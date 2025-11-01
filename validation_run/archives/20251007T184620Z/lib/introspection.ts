import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession } from './mcpSession.js';

import type { McpInfo, McpCapabilities } from '../../../../src/mcp/info.js';
import type { ResourceListEntry } from '../../../../src/resources/registry.js';
import { getEventBusInstance } from '../../../../src/server.js';
import type { EventEnvelope } from '../../../../src/events/bus.js';

/**
 * Structured representation of the `events_subscribe` tool output used by the
 * harness. The server mirrors the JSON-Lines payload both as plain text and as
 * structured content; the latter is easier to consume programmatically.
 */
export interface EventsSubscribeResult {
  readonly format: 'jsonlines' | 'sse';
  readonly events: Array<{
    readonly seq: number;
    readonly ts: number;
    readonly cat: string;
    readonly kind: string;
    readonly level: string;
    readonly job_id: string | null;
    readonly run_id: string | null;
    readonly op_id: string | null;
    readonly graph_id: string | null;
    readonly node_id: string | null;
    readonly child_id: string | null;
    readonly msg: string;
    readonly data: unknown;
  }>;
  readonly stream: string;
  readonly next_seq: number | null;
  readonly count: number;
}

/** Summary of the artefacts collected while running the introspection stage. */
export interface IntrospectionSummary {
  readonly info: McpInfo;
  readonly capabilities: McpCapabilities;
  readonly resourceCatalog: {
    readonly all: ResourceListEntry[];
    readonly byPrefix: Array<{ readonly prefix: string; readonly items: ResourceListEntry[]; readonly traceId: string }>;
  };
  readonly eventProbe: {
    readonly published: EventEnvelope;
    readonly baseline: EventsSubscribeResult;
    readonly followUp: EventsSubscribeResult;
  };
  readonly reportPath: string;
  readonly resourceIndexPath: string;
}

/** Options accepted by {@link runIntrospectionStage}. */
export interface IntrospectionStageOptions {
  /** Validation run context shared by the harness. */
  readonly context: RunContext;
  /** Recorder used to persist artefacts and logs. */
  readonly recorder: ArtifactRecorder;
  /** Optional factory injected for unit testing to control session creation. */
  readonly createSession?: () => McpSession;
}

/**
 * Small helper that extracts the JSON payload embedded in the textual MCP
 * response. Introspection tools serialise their result as a human-readable JSON
 * document, making simple parsing sufficient for our audit needs.
 */
function parseJsonContent(response: Awaited<ReturnType<McpSession['callTool']>>['response']): unknown {
  const firstTextEntry = Array.isArray(response.content)
    ? response.content.find((entry): entry is { type?: string; text?: string } => entry?.type === 'text')
    : undefined;
  const raw = firstTextEntry?.text ?? '{}';
  return JSON.parse(raw);
}

/**
 * Derives a deterministic prefix from a resource URI so that we can issue
 * targeted scans. The prefix mirrors the MCP contract: scheme + authority with
 * a trailing slash (e.g. `sc://graphs/`).
 */
function deriveResourcePrefix(uri: string): string {
  const parsed = new URL(uri);
  return `${parsed.protocol}//${parsed.host}/`;
}

/**
 * Executes the first checklist stage by invoking the introspection tools,
 * listing resources and collecting a live event sample. The function stores a
 * machine-readable report alongside a resource index to facilitate downstream
 * inspection.
 */
export async function runIntrospectionStage(options: IntrospectionStageOptions): Promise<IntrospectionSummary> {
  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-introspection',
        clientVersion: '1.0.0',
        featureOverrides: {
          enableMcpIntrospection: true,
          enableResources: true,
          enableEventsBus: true,
        },
      });

  await session.open();

  try {
    const infoCall = await session.callTool('mcp_info', {});
    const infoPayload = parseJsonContent(infoCall.response) as { info: McpInfo };
    const info = infoPayload.info;

    const capabilitiesCall = await session.callTool('mcp_capabilities', {});
    const capabilitiesPayload = parseJsonContent(capabilitiesCall.response) as { capabilities: McpCapabilities };
    const capabilities = capabilitiesPayload.capabilities;

    const resourcesAllCall = await session.callTool('resources_list', { limit: 200 });
    const resourcesAll = (
      (resourcesAllCall.response.structuredContent as { items?: ResourceListEntry[] } | undefined)?.items ?? []
    ).slice();

    const prefixes = new Map<string, ResourceListEntry[]>();
    for (const entry of resourcesAll) {
      const prefix = deriveResourcePrefix(entry.uri);
      const bucket = prefixes.get(prefix) ?? [];
      bucket.push(entry);
      prefixes.set(prefix, bucket);
    }

    const resourceCalls: Array<{ prefix: string; items: ResourceListEntry[]; traceId: string }> = [];
    for (const [prefix] of prefixes) {
      const listing = await session.callTool('resources_list', { prefix, limit: 200 });
      const items = (listing.response.structuredContent as { items?: ResourceListEntry[] } | undefined)?.items ?? [];
      resourceCalls.push({ prefix, items, traceId: listing.traceId });
    }

    const baselineEventsCall = await session.callTool('events_subscribe', { limit: 5 });
    const baselineEvents = (baselineEventsCall.response.structuredContent ?? baselineEventsCall.response) as EventsSubscribeResult;
    for (const event of baselineEvents.events) {
      await options.recorder.appendEvent({
        traceId: baselineEventsCall.traceId,
        event,
      });
    }

    const eventBus = getEventBusInstance();
    const published = eventBus.publish({
      cat: 'graph',
      level: 'info',
      runId: `validation-${options.context.runId}`,
      msg: 'introspection_probe',
      kind: 'probe',
      data: { stage: 'introspection', timestamp: new Date().toISOString() },
    });

    const followUpEventsCall = await session.callTool('events_subscribe', {
      from_seq: baselineEvents.next_seq ?? published.seq - 1,
      limit: 20,
    });
    const followUpEvents = (followUpEventsCall.response.structuredContent ?? followUpEventsCall.response) as EventsSubscribeResult;

    for (const event of followUpEvents.events) {
      await options.recorder.appendEvent({
        traceId: followUpEventsCall.traceId,
        event,
      });
    }

    const report = {
      info,
      capabilities,
      resources: {
        prefixes: resourceCalls.map((entry) => ({ prefix: entry.prefix, count: entry.items.length })),
      },
      events: {
        published_seq: published.seq,
        baseline_count: baselineEvents.count,
        follow_up_count: followUpEvents.count,
      },
    };

    const reportPath = path.join(options.context.directories.report, 'step01-introspection.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const resourceIndexPath = path.join(options.context.directories.resources, 'resource-prefixes.json');
    await writeFile(
      resourceIndexPath,
      `${JSON.stringify(
        {
          all: resourcesAll,
          byPrefix: resourceCalls,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await options.recorder.appendLogEntry({
      level: 'info',
      message: 'introspection_stage_completed',
      details: {
        info_tool_trace: infoCall.traceId,
        capabilities_tool_trace: capabilitiesCall.traceId,
        resources_trace: resourcesAllCall.traceId,
        prefixes_traces: resourceCalls.map((entry) => ({ prefix: entry.prefix, trace: entry.traceId })),
        baseline_events_trace: baselineEventsCall.traceId,
        follow_up_events_trace: followUpEventsCall.traceId,
        report_path: reportPath,
        resource_index_path: resourceIndexPath,
      },
    });

    return {
      info,
      capabilities,
      resourceCatalog: {
        all: resourcesAll,
        byPrefix: resourceCalls,
      },
      eventProbe: {
        published,
        baseline: baselineEvents,
        followUp: followUpEvents,
      },
      reportPath,
      resourceIndexPath,
    };
  } finally {
    await session.close();
  }
}

