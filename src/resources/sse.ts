import type {
  ResourceBlackboardEvent,
  ResourceChildLogEntry,
  ResourceRunEvent,
  ResourceWatchResult,
  ResourceWatchFilters,
} from "./registry.js";
import { serialiseForSse } from "../events/sse.js";
import {
  SseBuffer,
  type SseBufferOptions,
  type SseMessage,
  type RenderSseMessageOptions,
  renderSseMessages,
} from "../events/sseBuffer.js";

/**
 * Shape of a Server-Sent Events (SSE) record emitted when streaming a
 * `resources_watch` page. Each record corresponds to a single event/log entry
 * so consumers can resume from the associated identifier.
 */
type ResourceWatchEventName =
  | "resource_run_event"
  | "resource_child_log"
  | "resource_blackboard_event"
  | "resource_keep_alive";

export type ResourceWatchSseMessage = SseMessage<ResourceWatchEventName>;

/**
 * Normalises a run event for transport by switching to `snake_case` keys and
 * removing `undefined` values. The helper keeps the original payload intact so
 * downstream tools receive the same structure as `resources_watch`.
 */
function normaliseRunEvent(event: ResourceRunEvent) {
  return {
    type: "run_event" as const,
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    level: event.level,
    job_id: event.jobId ?? null,
    run_id: event.runId,
    op_id: event.opId ?? null,
    graph_id: event.graphId ?? null,
    node_id: event.nodeId ?? null,
    child_id: event.childId ?? null,
    component: event.component,
    stage: event.stage,
    elapsed_ms: event.elapsedMs,
    payload: event.payload ?? null,
  };
}

/**
 * Normalises a child log entry for SSE transport. Optional fields are coerced to
 * `null` so JSON serialisation stays stable and consumers can rely on explicit
 * keys when decoding the stream.
 */
function normaliseChildLog(entry: ResourceChildLogEntry) {
  return {
    type: "child_log" as const,
    seq: entry.seq,
    ts: entry.ts,
    stream: entry.stream,
    message: entry.message,
    job_id: entry.jobId ?? null,
    run_id: entry.runId ?? null,
    op_id: entry.opId ?? null,
    graph_id: entry.graphId ?? null,
    node_id: entry.nodeId ?? null,
    child_id: entry.childId,
    raw: entry.raw ?? null,
    parsed: entry.parsed ?? null,
  };
}

/** Normalises a blackboard event for SSE transport. */
function normaliseBlackboardEvent(event: ResourceBlackboardEvent) {
  return {
    type: "blackboard_event" as const,
    seq: event.seq,
    version: event.version,
    ts: event.ts,
    kind: event.kind,
    namespace: event.namespace,
    key: event.key,
    entry: event.entry ?? null,
    previous: event.previous ?? null,
    reason: event.reason ?? null,
  };
}

/**
 * Builds the JSON payload transported on the SSE `data:` line. The payload
 * includes the resource URI and `next_seq` pointer so reconnecting clients can
 * resume a watch operation without additional bookkeeping.
 */
function buildPayload(
  result: ResourceWatchResult,
  record:
    | ReturnType<typeof normaliseRunEvent>
    | ReturnType<typeof normaliseChildLog>
    | ReturnType<typeof normaliseBlackboardEvent>
    | { type: "keep_alive" },
) {
  const payload: {
    uri: string;
    kind: ResourceWatchResult["kind"];
    next_seq: number;
    record:
      | ReturnType<typeof normaliseRunEvent>
      | ReturnType<typeof normaliseChildLog>
      | ReturnType<typeof normaliseBlackboardEvent>
      | { type: "keep_alive" };
    filters?: ResourceWatchFilters;
  } = {
    uri: result.uri,
    kind: result.kind,
    next_seq: result.nextSeq,
    record,
  };
  const filters = result.filters;
  if (filters) {
    const snapshot: ResourceWatchFilters = {};
    if (filters.keys && filters.keys.length > 0) {
      snapshot.keys = filters.keys.map((key) => key);
    }
    if (filters.blackboard) {
      snapshot.blackboard = structuredClone(filters.blackboard);
    }
    if (filters.run) {
      snapshot.run = structuredClone(filters.run);
    }
    if (filters.child) {
      snapshot.child = structuredClone(filters.child);
    }
    if (Object.keys(snapshot).length > 0) {
      payload.filters = snapshot;
    }
  }
  return payload;
}

/**
 * Serialises a `resources_watch` page into SSE records. Run events and child log
 * entries are emitted individually while empty pages produce a keep-alive so the
 * transport stays active and clients retain the `next_seq` cursor.
 */
export function serialiseResourceWatchResultForSse(result: ResourceWatchResult): ResourceWatchSseMessage[] {
  if (result.events.length === 0) {
    const keepAlivePayload = buildPayload(result, { type: "keep_alive" });
    return [
      {
        id: `${result.uri}:${result.nextSeq}`,
        event: "resource_keep_alive",
        data: serialiseForSse(keepAlivePayload),
      },
    ];
  }

  switch (result.kind) {
    case "run_events":
      return result.events.map((event) => {
        const payload = buildPayload(result, normaliseRunEvent(event));
        return {
          id: `${result.uri}:${event.seq}`,
          event: "resource_run_event" as const,
          data: serialiseForSse(payload),
        };
      });
    case "child_logs":
      return result.events.map((entry) => {
        const payload = buildPayload(result, normaliseChildLog(entry));
        return {
          id: `${result.uri}:${entry.seq}`,
          event: "resource_child_log" as const,
          data: serialiseForSse(payload),
        };
      });
    case "blackboard_namespace":
      return result.events.map((event) => {
        const payload = buildPayload(result, normaliseBlackboardEvent(event));
        return {
          id: `${result.uri}:${event.seq}`,
          event: "resource_blackboard_event" as const,
          data: serialiseForSse(payload),
        };
      });
    case "tool_router_decisions":
      // Tool router snapshots are diagnostic by nature and currently surface via JSON
      // responses only. Failing fast prevents silently emitting malformed SSE frames.
      throw new Error("tool router decisions cannot be serialised to SSE messages");
  }
}

/**
 * Renders resource-watch SSE messages into wire-ready frames. The helper wraps the
 * shared renderer so every endpoint benefits from identical framing logic.
 */
export function renderResourceWatchSseMessages(
  messages: ResourceWatchSseMessage[],
  options: RenderSseMessageOptions = {},
): string {
  return renderSseMessages(messages, options);
}

export interface ResourceWatchSseBufferOptions extends SseBufferOptions {}

/**
 * Bounded buffer guarding SSE emissions for a single client. Messages are
 * rendered eagerly into SSE frames and stored until a downstream writer drains
 * them. The buffer enforces a strict capacity to avoid unbounded growth when
 * consumers are slow or disconnected.
 */
export class ResourceWatchSseBuffer extends SseBuffer<ResourceWatchEventName> {
  constructor(options: ResourceWatchSseBufferOptions) {
    super(options);
  }
}
