"use strict";

/**
 * Introspection stage executed by the validation harness. The phase collects
 * baseline metadata (mcp_info, mcp_capabilities), enumerates resources, and
 * samples the unified event bus so the resulting artefacts can be audited
 * offline.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadServerModule } from "../server-loader.mjs";
import { McpSession, McpToolCallError } from "../mcp-session.mjs";

let eventBusResolver = null;

async function resolveEventBus() {
  if (!eventBusResolver) {
    eventBusResolver = (async () => {
      const module = await loadServerModule();
      if (typeof module.getEventBusInstance !== "function") {
        throw new Error(
          "The server module does not expose the event bus accessor",
        );
      }
      return module.getEventBusInstance;
    })();
  }
  const getter = await eventBusResolver;
  return getter();
}

/**
 * Extracts the first textual content block from an MCP response and attempts to
 * parse it as JSON. Introspection tools return human-readable JSON documents,
 * making this sufficient for our reporting needs.
 */
function parseJsonContent(response) {
  const entries = Array.isArray(response?.content) ? response.content : [];
  const candidate = entries.find((entry) => entry && typeof entry === "object" && typeof entry.text === "string");
  if (!candidate) {
    return {};
  }
  try {
    return JSON.parse(candidate.text);
  } catch {
    return {};
  }
}

/** Derives the `scheme://authority/` prefix for a resource URI. */
function deriveResourcePrefix(uri) {
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return "unknown://";
  }
}

/**
 * Runs the introspection phase and returns the collected artefacts alongside
 * the tool call metadata required by the reporting layer.
 */
export async function runIntrospectionStage(options) {
  const {
    context,
    recorder,
    logger = console,
    phaseId = "phase-01-introspection",
    createSession,
  } = options;

  const toolCalls = [];
  const session = createSession
    ? createSession()
    : new McpSession({
        context,
        recorder,
        clientName: "validation-introspection",
        clientVersion: "1.0.0",
        featureOverrides: {
          enableMcpIntrospection: true,
          enableResources: true,
          enableEventsBus: true,
        },
      });

  await recorder.appendLogEntry({
    level: "info",
    message: "stage_started",
    phaseId,
    details: { stage: "introspection", phase_id: phaseId },
  });

  await session.open();

  const toolCallSummaries = [];

  async function safeCall(toolName, payload) {
    try {
      const call = await session.callTool(toolName, payload, { phaseId });
      toolCalls.push({
        toolName,
        traceId: call.traceId,
        durationMs: call.durationMs,
        artefacts: call.artefacts,
        response: call.response,
      });
      toolCallSummaries.push({ toolName, traceId: call.traceId });
      return call;
    } catch (error) {
      if (error instanceof McpToolCallError) {
        const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
        toolCalls.push({
          toolName,
          traceId: error.traceId,
          durationMs: error.durationMs,
          artefacts: error.artefacts,
          response: {
            isError: true,
            structuredContent: null,
            content: [{ type: "text", text: message }],
          },
        });
        toolCallSummaries.push({ toolName, traceId: error.traceId, error: message });
        logger?.warn?.(`tool_call_failed:${toolName}`, message);
        return null;
      }
      throw error;
    }
  }

  try {
    const infoCall = await safeCall("mcp_info", {});
    const infoPayload = infoCall ? parseJsonContent(infoCall.response) : {};
    const info = infoPayload.info ?? {};

    const capabilitiesCall = await safeCall("mcp_capabilities", {});
    const capabilitiesPayload = capabilitiesCall ? parseJsonContent(capabilitiesCall.response) : {};
    const capabilities = capabilitiesPayload.capabilities ?? {};

    const resourcesListCall = await safeCall("resources_list", { limit: 200 });
    const allResources = Array.isArray(resourcesListCall?.response?.structuredContent?.items)
      ? [...resourcesListCall.response.structuredContent.items]
      : [];

    const resourcesByPrefix = new Map();
    for (const entry of allResources) {
      if (!entry?.uri) {
        continue;
      }
      const prefix = deriveResourcePrefix(entry.uri);
      const bucket = resourcesByPrefix.get(prefix) ?? [];
      bucket.push(entry);
      resourcesByPrefix.set(prefix, bucket);
    }

    const prefixResults = [];
    for (const [prefix] of resourcesByPrefix) {
      const listing = await safeCall("resources_list", { prefix, limit: 200 });
      const items = Array.isArray(listing?.response?.structuredContent?.items)
        ? [...listing.response.structuredContent.items]
        : [];
      prefixResults.push({ prefix, items, traceId: listing?.traceId ?? null });
    }

    const baselineEventsCall = await safeCall("events_subscribe", { limit: 10 });
    const baselineEvents = baselineEventsCall?.response?.structuredContent ?? baselineEventsCall?.response ?? {};
    if (baselineEventsCall && Array.isArray(baselineEvents.events)) {
      for (const event of baselineEvents.events) {
        await recorder.appendPhaseEvent({ phaseId, traceId: baselineEventsCall.traceId, event });
      }
    }

    const bus = await resolveEventBus();
    const published = bus.publish({
      cat: "graph",
      level: "info",
      runId: `validation-${context.runId}`,
      msg: "introspection_probe",
      kind: "probe",
      data: { stage: "introspection", emitted_at: new Date().toISOString() },
    });

    const publishedSeq = typeof published.seq === "number" ? published.seq : 0;
    const fromSeq = typeof baselineEvents?.next_seq === "number"
      ? baselineEvents.next_seq
      : Math.max(0, publishedSeq - 1);
    const followUpEventsCall = await safeCall("events_subscribe", { from_seq: fromSeq, limit: 20 });
    const followUpEvents = followUpEventsCall?.response?.structuredContent ?? followUpEventsCall?.response ?? {};
    if (followUpEventsCall && Array.isArray(followUpEvents.events)) {
      for (const event of followUpEvents.events) {
        await recorder.appendPhaseEvent({ phaseId, traceId: followUpEventsCall.traceId, event });
      }
    }

    const reportPath = join(context.directories.report, "step01-introspection.json");
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          info,
          capabilities,
          resource_prefixes: prefixResults.map((entry) => ({ prefix: entry.prefix, count: entry.items.length })),
          events: {
            published_seq: published.seq,
            baseline_count: baselineEvents?.count ?? (Array.isArray(baselineEvents?.events) ? baselineEvents.events.length : 0),
            follow_up_count: followUpEvents?.count ?? (Array.isArray(followUpEvents?.events) ? followUpEvents.events.length : 0),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const resourceIndexPath = join(context.directories.resources, "resource-prefixes.json");
    await writeFile(
      resourceIndexPath,
      `${JSON.stringify(
        {
          all: allResources,
          byPrefix: prefixResults,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await recorder.appendLogEntry({
      level: "info",
      message: "stage_completed",
      phaseId,
      details: {
        stage: "introspection",
        phase_id: phaseId,
        calls: toolCallSummaries,
        report_path: reportPath,
        resource_index_path: resourceIndexPath,
      },
    });

    return {
      phaseId,
      summary: {
        info,
        capabilities,
        resourceCatalog: {
          all: allResources,
          byPrefix: prefixResults,
        },
        events: {
          published,
          baseline: baselineEvents,
          followUp: followUpEvents,
        },
        reportPath,
        resourceIndexPath,
      },
      calls: toolCalls,
    };
  } catch (error) {
    logger?.error?.("introspection_stage_failed", error);
    throw error;
  } finally {
    await session.close();
  }
}

