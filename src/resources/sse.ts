import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { TextEncoder } from "node:util";

import type {
  ResourceBlackboardEvent,
  ResourceChildLogEntry,
  ResourceRunEvent,
  ResourceWatchResult,
  ResourceWatchChildFilters,
  ResourceWatchBlackboardFilters,
  ResourceWatchRunFilters,
} from "./registry.js";
import { serialiseForSse } from "../events/sse.js";
import type { StructuredLogger } from "../logger.js";

/**
 * Shape of a Server-Sent Events (SSE) record emitted when streaming a
 * `resources_watch` page. Each record corresponds to a single event/log entry
 * so consumers can resume from the associated identifier.
 */
export interface ResourceWatchSseMessage {
  /** Unique identifier for the SSE record (resource URI + monotonous sequence). */
  id: string;
  /** SSE event name discriminating run events, child logs or keep-alives. */
  event: "resource_run_event" | "resource_child_log" | "resource_blackboard_event" | "resource_keep_alive";
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
    filters?: {
      keys?: string[];
      blackboard?: ResourceWatchBlackboardFilters;
      run?: ResourceWatchRunFilters;
      child?: ResourceWatchChildFilters;
    };
  } = {
    uri: result.uri,
    kind: result.kind,
    next_seq: result.nextSeq,
    record,
  };
  const filters = result.filters;
  if (filters) {
    const snapshot: NonNullable<typeof payload.filters> = {};
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

  return result.events.map((event) => {
    if (result.kind === "run_events") {
      const payload = buildPayload(result, normaliseRunEvent(event as ResourceRunEvent));
      return {
        id: `${result.uri}:${(event as ResourceRunEvent).seq}`,
        event: "resource_run_event" as const,
        data: serialiseForSse(payload),
      };
    }

    if (result.kind === "blackboard_namespace") {
      const payload = buildPayload(result, normaliseBlackboardEvent(event as ResourceBlackboardEvent));
      return {
        id: `${result.uri}:${(event as ResourceBlackboardEvent).seq}`,
        event: "resource_blackboard_event" as const,
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
export interface RenderSseMessageOptions {
  /** Maximum number of bytes allowed per SSE `data:` line (defaults to env/32KiB). */
  maxChunkBytes?: number;
}

/** Default chunk size applied to SSE payloads when the environment omits overrides. */
const DEFAULT_MAX_CHUNK_BYTES = 32 * 1024;

/** Default number of messages retained in a per-client buffer before dropping the oldest entries. */
const DEFAULT_MAX_BUFFERED_MESSAGES = 256;

/** Default timeout granted to downstream writers when flushing SSE frames (in milliseconds). */
const DEFAULT_EMIT_TIMEOUT_MS = 5_000;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveMaxChunkBytes(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  const envValue = process.env.MCP_SSE_MAX_CHUNK_BYTES;
  return parsePositiveInteger(envValue, DEFAULT_MAX_CHUNK_BYTES);
}

function resolveMaxBufferedMessages(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  const envValue = process.env.MCP_SSE_MAX_BUFFER;
  return parsePositiveInteger(envValue, DEFAULT_MAX_BUFFERED_MESSAGES);
}

function resolveEmitTimeoutMs(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  const envValue = process.env.MCP_SSE_EMIT_TIMEOUT_MS;
  return parsePositiveInteger(envValue, DEFAULT_EMIT_TIMEOUT_MS);
}

const utf8Encoder = new TextEncoder();

function chunkUtf8String(value: string, maxBytes: number): string[] {
  if (maxBytes <= 0) {
    return [value];
  }

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of value) {
    const encoded = utf8Encoder.encode(char);
    if (encoded.length > maxBytes) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
        currentBytes = 0;
      }
      chunks.push(char);
      continue;
    }

    if (currentBytes + encoded.length > maxBytes && current.length > 0) {
      chunks.push(current);
      current = char;
      currentBytes = encoded.length;
    } else {
      current += char;
      currentBytes += encoded.length;
    }
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

function renderSingleSseMessage(
  message: ResourceWatchSseMessage,
  options: RenderSseMessageOptions = {},
): string {
  const maxChunkBytes = resolveMaxChunkBytes(options.maxChunkBytes);
  const dataChunks = chunkUtf8String(message.data, maxChunkBytes);
  const header = `id: ${message.id}\nevent: ${message.event}\n`;
  const payload = dataChunks.map((chunk) => `data: ${chunk}\n`).join("");
  return `${header}${payload}\n`;
}

export function renderResourceWatchSseMessages(
  messages: ResourceWatchSseMessage[],
  options: RenderSseMessageOptions = {},
): string {
  return messages.map((message) => renderSingleSseMessage(message, options)).join("");
}

export interface ResourceWatchSseBufferOptions extends RenderSseMessageOptions {
  /** Unique identifier attached to logs when the buffer drops or times out. */
  clientId: string;
  /** Structured logger used to surface warnings when backpressure kicks in. */
  logger: Pick<StructuredLogger, "warn">;
  /**
   * Maximum number of messages retained before discarding the oldest ones. If
   * omitted, the helper falls back to `MCP_SSE_MAX_BUFFER` or the default
   * bounded capacity.
   */
  maxBufferedMessages?: number;
  /** Maximum time spent awaiting a downstream flush before the frame is dropped. */
  emitTimeoutMs?: number;
}

/**
 * Bounded buffer guarding SSE emissions for a single client. Messages are
 * rendered eagerly into SSE frames and stored until a downstream writer drains
 * them. The buffer enforces a strict capacity to avoid unbounded growth when
 * consumers are slow or disconnected.
 */
export class ResourceWatchSseBuffer {
  private readonly maxBufferedMessages: number;
  private readonly emitTimeoutMs: number;
  private readonly options: ResourceWatchSseBufferOptions;
  private readonly queue: string[] = [];

  constructor(options: ResourceWatchSseBufferOptions) {
    this.options = options;
    this.maxBufferedMessages = resolveMaxBufferedMessages(options.maxBufferedMessages);
    this.emitTimeoutMs = resolveEmitTimeoutMs(options.emitTimeoutMs);
  }

  /** Number of SSE frames currently stored in the buffer. */
  get size(): number {
    return this.queue.length;
  }

  /** Clears all buffered frames without notifying downstream consumers. */
  clear(): void {
    this.queue.length = 0;
  }

  /**
   * Enqueues a collection of messages after rendering them into SSE frames.
   * When the buffer overflows, the oldest frames are discarded and a warning is
   * emitted so operators can correlate the drop with the affected client.
   */
  enqueue(messages: ResourceWatchSseMessage[]): void {
    for (const message of messages) {
      this.queue.push(renderSingleSseMessage(message, this.options));
    }

    if (this.queue.length > this.maxBufferedMessages) {
      const overflow = this.queue.length - this.maxBufferedMessages;
      this.queue.splice(0, overflow);
      this.options.logger.warn("resources_sse_buffer_overflow", {
        client_id: this.options.clientId,
        dropped: overflow,
        capacity: this.maxBufferedMessages,
      });
    }
  }

  /**
   * Flushes buffered frames sequentially using the provided writer. Each frame
   * is awaited with a timeout so a stalled consumer does not exhaust memory.
   */
  async drain(writer: (frame: string) => Promise<void>): Promise<void> {
    while (this.queue.length > 0) {
      const frame = this.queue.shift()!;
      const writeResult = writer(frame);
      const timeout = this.emitTimeoutMs;

      if (timeout > 0) {
        try {
          const winner = await Promise.race([
            writeResult.then(() => "ok" as const),
            delay(timeout).then(() => "timeout" as const),
          ]);

          if (winner === "timeout") {
            this.options.logger.warn("resources_sse_emit_timeout", {
              client_id: this.options.clientId,
              timeout_ms: timeout,
            });
            void writeResult.catch((error) => {
              this.options.logger.warn("resources_sse_emit_failed", {
                client_id: this.options.clientId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            // Drop the frame silently since the consumer is not draining fast enough.
            continue;
          }
        } catch (error) {
          this.options.logger.warn("resources_sse_emit_failed", {
            client_id: this.options.clientId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      } else {
        try {
          await writeResult;
        } catch (error) {
          this.options.logger.warn("resources_sse_emit_failed", {
            client_id: this.options.clientId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
    }
  }
}

export {
  DEFAULT_MAX_CHUNK_BYTES,
  DEFAULT_MAX_BUFFERED_MESSAGES,
  DEFAULT_EMIT_TIMEOUT_MS,
};
