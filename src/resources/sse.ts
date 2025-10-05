import type { ResourceChildLogEntry, ResourceRunEvent, ResourceWatchResult } from "./registry.js";
import { serialiseForSse } from "../events/sse.js";

/**
 * Shape of a Server-Sent Events (SSE) record emitted when streaming a
 * `resources_watch` page. Each record corresponds to a single event/log entry
 * so consumers can resume from the associated identifier.
 */
export interface ResourceWatchSseMessage {
  /** Unique identifier for the SSE record (resource URI + monotonous sequence). */
  id: string;
  /** SSE event name discriminating run events, child logs or keep-alives. */
  event: "resource_run_event" | "resource_child_log" | "resource_keep_alive";
  /** JSON payload normalised for SSE transport (single `data:` line). */
  data: string;
}

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

/**
 * Builds the JSON payload transported on the SSE `data:` line. The payload
 * includes the resource URI and `next_seq` pointer so reconnecting clients can
 * resume a watch operation without additional bookkeeping.
 */
function buildPayload(
  result: ResourceWatchResult,
  record: ReturnType<typeof normaliseRunEvent> | ReturnType<typeof normaliseChildLog> | { type: "keep_alive" },
) {
  return {
    uri: result.uri,
    kind: result.kind,
    next_seq: result.nextSeq,
    record,
  };
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

  return result.events.map((event) => {
    if (result.kind === "run_events") {
      const payload = buildPayload(result, normaliseRunEvent(event as ResourceRunEvent));
      return {
        id: `${result.uri}:${(event as ResourceRunEvent).seq}`,
        event: "resource_run_event" as const,
        data: serialiseForSse(payload),
      };
    }

    const payload = buildPayload(result, normaliseChildLog(event as ResourceChildLogEntry));
    return {
      id: `${result.uri}:${(event as ResourceChildLogEntry).seq}`,
      event: "resource_child_log" as const,
      data: serialiseForSse(payload),
    };
  });
}

/**
 * Renders SSE messages into a wire-ready string. Tests and upcoming HTTP
 * handlers share this helper to keep the framing (`id/event/data` + blank line)
 * consistent with the other SSE endpoints.
 */
export function renderResourceWatchSseMessages(messages: ResourceWatchSseMessage[]): string {
  return messages.map((message) => `id: ${message.id}\nevent: ${message.event}\ndata: ${message.data}\n\n`).join("");
}
