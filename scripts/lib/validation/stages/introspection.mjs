"use strict";

/**
 * Introspection stage executed by the validation harness. The phase collects
 * baseline metadata (mcp_info, mcp_capabilities), enumerates resources, and
 * samples the unified event bus so the resulting artefacts can be audited
 * offline.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadServerModule } from "../server-loader.mjs";
import { McpSession, McpToolCallError } from "../mcp-session.mjs";

let eventBusResolver = null;

const AGGREGATED_FILENAMES = Object.freeze({
  requests: "01_introspection.jsonl",
  responses: "01_introspection.jsonl",
  events: "01_bus.jsonl",
  report: "step01-introspection.json",
});

/** Returns the current timestamp formatted as ISO8601 for artefact metadata. */
function nowIso() {
  return new Date().toISOString();
}

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
  /**
   * Tracks the first materialised artefact paths for the aggregated JSONL files.
   *
   * The validation harness only needs the location of the consolidated request
   * / response / event streams when they actually exist.  By keeping the slots
   * `undefined` until a file is created we can later omit the corresponding
   * properties from persisted summaries, avoiding `null` placeholders that would
   * violate the future `exactOptionalPropertyTypes` contract.
   */
  const aggregatedPaths = { requests: undefined, responses: undefined, events: undefined };
  let requestSequence = 0;
  let responseSequence = 0;
  let eventSequence = 0;
  const aggregatedRequestEntries = [];
  const aggregatedResponseEntries = [];
  const aggregatedBusEntries = [];

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

  async function recordAggregatedRequest({ callType, toolName, payload, traceId, artefacts }) {
    requestSequence += 1;
    const entry = {
      sequence: requestSequence,
      observedAt: nowIso(),
      phaseId,
      callType,
      tool: toolName,
      traceId,
      payload,
      artefacts,
    };
    aggregatedRequestEntries.push(entry);
    const path = await recorder.appendJsonlArtifact({
      directory: "inputs",
      filename: AGGREGATED_FILENAMES.requests,
      payload: entry,
      phaseId,
      metadata: {
        channel: "introspection_requests",
        tool: toolName,
        call_type: callType,
      },
      resourceData: {
        entry_count: aggregatedRequestEntries.length,
        entries: aggregatedRequestEntries,
      },
    });
    if (!aggregatedPaths.requests) {
      aggregatedPaths.requests = path;
    }
    return path;
  }

  async function recordAggregatedResponse({
    callType,
    toolName,
    traceId,
    artefacts,
    response,
    error,
    durationMs,
  }) {
    responseSequence += 1;
    const entry = {
      sequence: responseSequence,
      observedAt: nowIso(),
      phaseId,
      callType,
      tool: toolName,
      traceId,
      durationMs,
      artefacts,
      response: response ?? null,
      error: error ?? null,
    };
    aggregatedResponseEntries.push(entry);
    const path = await recorder.appendJsonlArtifact({
      directory: "outputs",
      filename: AGGREGATED_FILENAMES.responses,
      payload: entry,
      phaseId,
      metadata: {
        channel: "introspection_responses",
        tool: toolName,
        call_type: callType,
      },
      resourceData: {
        entry_count: aggregatedResponseEntries.length,
        entries: aggregatedResponseEntries,
      },
    });
    if (!aggregatedPaths.responses) {
      aggregatedPaths.responses = path;
    }
    return path;
  }

  async function recordBusEvent({ source, event, traceId }) {
    eventSequence += 1;
    const entry = {
      sequence: eventSequence,
      observedAt: nowIso(),
      phaseId,
      source,
      traceId: traceId ?? null,
      event,
    };
    aggregatedBusEntries.push(entry);
    const path = await recorder.appendJsonlArtifact({
      directory: "events",
      filename: AGGREGATED_FILENAMES.events,
      payload: entry,
      phaseId,
      metadata: {
        channel: "event_bus",
        source,
      },
      resourceData: {
        entry_count: aggregatedBusEntries.length,
        events: aggregatedBusEntries,
      },
    });
    if (!aggregatedPaths.events) {
      aggregatedPaths.events = path;
    }
    await recorder.appendPhaseEvent({
      phaseId,
      traceId: traceId ?? null,
      event: {
        kind: "bus_event",
        source,
        sequence: eventSequence,
        payload: event,
      },
    });
    return path;
  }

  async function executeCall({ label, payload, callType, invoke }) {
    try {
      const call = await invoke();
      await recordAggregatedRequest({
        callType,
        toolName: label,
        payload,
        traceId: call.traceId,
        artefacts: call.artefacts,
      });
      await recordAggregatedResponse({
        callType,
        toolName: label,
        traceId: call.traceId,
        artefacts: call.artefacts,
        response: call.response,
        durationMs: call.durationMs,
      });
      toolCalls.push({
        toolName: label,
        traceId: call.traceId,
        durationMs: call.durationMs,
        artefacts: call.artefacts,
        response: call.response,
      });
      toolCallSummaries.push({ toolName: label, traceId: call.traceId });
      return call;
    } catch (error) {
      if (error instanceof McpToolCallError) {
        const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
        await recordAggregatedRequest({
          callType,
          toolName: label,
          payload,
          traceId: error.traceId,
          artefacts: error.artefacts,
        });
        await recordAggregatedResponse({
          callType,
          toolName: label,
          traceId: error.traceId,
          artefacts: error.artefacts,
          error: { message },
          durationMs: error.durationMs,
        });
        toolCalls.push({
          toolName: label,
          traceId: error.traceId,
          durationMs: error.durationMs,
          artefacts: error.artefacts,
          response: {
            isError: true,
            structuredContent: null,
            content: [{ type: "text", text: message }],
          },
        });
        toolCallSummaries.push({ toolName: label, traceId: error.traceId, error: message });
        logger?.warn?.(`tool_call_failed:${label}`, message);
        return null;
      }
      throw error;
    }
  }

  try {
    const infoCall = await executeCall({
      label: "mcp_info",
      payload: {},
      callType: "tool",
      invoke: () => session.callTool("mcp_info", {}, { phaseId }),
    });
    const infoPayload = infoCall ? parseJsonContent(infoCall.response) : {};
    const info = infoPayload.info ?? {};

    const capabilitiesCall = await executeCall({
      label: "mcp_capabilities",
      payload: {},
      callType: "tool",
      invoke: () => session.callTool("mcp_capabilities", {}, { phaseId }),
    });
    const capabilitiesPayload = capabilitiesCall ? parseJsonContent(capabilitiesCall.response) : {};
    const capabilities = capabilitiesPayload.capabilities ?? {};

    const toolsListCall = await executeCall({
      label: "rpc:tools_list",
      payload: { limit: 200 },
      callType: "rpc",
      invoke: () => session.listTools({ limit: 200 }, { phaseId }),
    });
    const toolsResponse = toolsListCall?.response ?? {};
    const tools = Array.isArray(toolsResponse.tools) ? [...toolsResponse.tools] : [];
    const toolsNextCursor = toolsResponse.nextCursor;

    const resourcesListCall = await executeCall({
      label: "resources_list",
      payload: { limit: 200 },
      callType: "tool",
      invoke: () => session.callTool("resources_list", { limit: 200 }, { phaseId }),
    });
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
      const listing = await executeCall({
        label: "resources_list",
        payload: { prefix, limit: 200 },
        callType: "tool",
        invoke: () => session.callTool("resources_list", { prefix, limit: 200 }, { phaseId }),
      });
      const items = Array.isArray(listing?.response?.structuredContent?.items)
        ? [...listing.response.structuredContent.items]
        : [];
      prefixResults.push({ prefix, items, traceId: listing?.traceId ?? null });
    }

    const baselineEventsCall = await executeCall({
      label: "events_subscribe",
      payload: { limit: 10 },
      callType: "tool",
      invoke: () => session.callTool("events_subscribe", { limit: 10 }, { phaseId }),
    });
    const baselineEvents = baselineEventsCall?.response?.structuredContent ?? baselineEventsCall?.response ?? {};
    if (baselineEventsCall && Array.isArray(baselineEvents.events)) {
      for (const event of baselineEvents.events) {
        await recordBusEvent({ source: "baseline", event, traceId: baselineEventsCall.traceId });
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
    const followUpEventsCall = await executeCall({
      label: "events_subscribe",
      payload: { from_seq: fromSeq, limit: 20 },
      callType: "tool",
      invoke: () => session.callTool("events_subscribe", { from_seq: fromSeq, limit: 20 }, { phaseId }),
    });
    const followUpEvents = followUpEventsCall?.response?.structuredContent ?? followUpEventsCall?.response ?? {};
    if (followUpEventsCall && Array.isArray(followUpEvents.events)) {
      for (const event of followUpEvents.events) {
        await recordBusEvent({ source: "follow_up", event, traceId: followUpEventsCall.traceId });
      }
    }

    if (eventSequence === 0) {
      await recordBusEvent({
        source: "summary",
        event: { kind: "bus_idle", note: "no events captured during introspection" },
        traceId: null,
      });
    }

    const reportPath = join(context.directories.report, AGGREGATED_FILENAMES.report);
    /**
     * Builds the artefact pointers without serialising `undefined` values.  The
     * resulting object is reused for the JSON report as well as the returned
     * stage summary so all consumers observe the same sanitised payload.
     */
    const aggregatedArtifacts = {
      ...(aggregatedPaths.requests ? { requests: aggregatedPaths.requests } : {}),
      ...(aggregatedPaths.responses ? { responses: aggregatedPaths.responses } : {}),
      ...(aggregatedPaths.events ? { events: aggregatedPaths.events } : {}),
    };

    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          info,
          capabilities,
          tools: {
            total: tools.length,
            ...(toolsNextCursor !== undefined && toolsNextCursor !== null
              ? { next_cursor: toolsNextCursor }
              : {}),
            items: tools,
          },
          resource_prefixes: prefixResults.map((entry) => ({ prefix: entry.prefix, count: entry.items.length })),
          events: {
            published_seq: published.seq,
            baseline_count: baselineEvents?.count ?? (Array.isArray(baselineEvents?.events) ? baselineEvents.events.length : 0),
            follow_up_count: followUpEvents?.count ?? (Array.isArray(followUpEvents?.events) ? followUpEvents.events.length : 0),
          },
          artifacts: aggregatedArtifacts,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const introspectionArtifactsDir = join(context.directories.artifacts, "introspection");
    await mkdir(introspectionArtifactsDir, { recursive: true });
    const resourceIndexPath = join(introspectionArtifactsDir, "resource-prefixes.json");
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

    const toolsCatalogPath = join(introspectionArtifactsDir, "tools-catalog.json");
    await writeFile(
      toolsCatalogPath,
      `${JSON.stringify(
        {
          total: tools.length,
          nextCursor: toolsNextCursor,
          items: tools,
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
        tools_catalog_path: toolsCatalogPath,
        aggregated_requests: aggregatedPaths.requests,
        aggregated_responses: aggregatedPaths.responses,
        aggregated_events: aggregatedPaths.events,
      },
    });

    return {
      phaseId,
      summary: {
        info,
        capabilities,
        tools: {
          total: tools.length,
          ...(toolsNextCursor !== undefined && toolsNextCursor !== null
            ? { nextCursor: toolsNextCursor }
            : {}),
          items: tools,
        },
        resourceCatalog: {
          all: allResources,
          byPrefix: prefixResults,
        },
        events: {
          published,
          baseline: baselineEvents,
          followUp: followUpEvents,
        },
        artifacts: {
          ...(aggregatedPaths.requests ? { requestsPath: aggregatedPaths.requests } : {}),
          ...(aggregatedPaths.responses ? { responsesPath: aggregatedPaths.responses } : {}),
          ...(aggregatedPaths.events ? { eventsPath: aggregatedPaths.events } : {}),
          reportPath,
          resourceIndexPath,
          toolsCatalogPath,
        },
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

