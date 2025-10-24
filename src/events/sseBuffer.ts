/**
 * Shared Server-Sent Events (SSE) helpers powering the dashboard and resource
 * streaming endpoints. The module encapsulates payload framing plus bounded
 * buffering so every SSE consumer benefits from consistent backpressure guards.
 */
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { TextEncoder } from "node:util";

import { readInt } from "../config/env.js";
import { recordSseDrop } from "../infra/tracing.js";
import type { StructuredLogger } from "../logger.js";

/** Maximum chunk size applied to SSE `data:` lines when the environment omits overrides. */
const DEFAULT_MAX_CHUNK_BYTES = 32 * 1024;

/** Total number of bytes retained across frames when callers omit explicit overrides. */
const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;

/** Timeout (milliseconds) granted to downstream writers before frames are dropped. */
const DEFAULT_EMIT_TIMEOUT_MS = 5_000;

/**
 * Options controlling the rendering of SSE frames. Tests override the chunk size to
 * exercise corner cases where payloads span multiple UTF-8 segments.
 */
export interface RenderSseMessageOptions {
  /** Maximum number of bytes allowed per SSE `data:` line (defaults to env/32KiB). */
  maxChunkBytes?: number;
}

/** Minimal descriptor for a single SSE frame. */
export interface SseMessage<EventName extends string = string> {
  /** Unique identifier attached to the SSE frame, used by clients to resume streams. */
  id: string;
  /** Event name surfaced to the `EventSource` listener. */
  event: EventName;
  /** JSON payload serialised for transport (single `data:` line). */
  data: string;
}

/** Options accepted by {@link SseBuffer}. */
export interface SseBufferOptions extends RenderSseMessageOptions {
  /** Unique identifier injected in warning logs when frames are dropped. */
  clientId: string;
  /** Structured logger leveraged to report backpressure issues. */
  logger: Pick<StructuredLogger, "warn">;
  /** Explicit override for the buffered byte capacity (defaults to env or 512KiB). */
  maxBufferedBytes?: number;
  /** Maximum time spent awaiting downstream writers before the frame is discarded. */
  emitTimeoutMs?: number;
}

function resolveMaxChunkBytes(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  return readInt("MCP_SSE_MAX_CHUNK_BYTES", DEFAULT_MAX_CHUNK_BYTES, { min: 1 });
}

function resolveMaxBufferedBytes(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  return readInt("MCP_SSE_MAX_BUFFER", DEFAULT_MAX_BUFFERED_BYTES, { min: 1 });
}

function resolveEmitTimeoutMs(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  return readInt("MCP_SSE_EMIT_TIMEOUT_MS", DEFAULT_EMIT_TIMEOUT_MS, { min: 1 });
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

function renderSingleSseMessage<EventName extends string>(
  message: SseMessage<EventName>,
  options: RenderSseMessageOptions = {},
): string {
  const maxChunkBytes = resolveMaxChunkBytes(options.maxChunkBytes);
  const dataChunks = chunkUtf8String(message.data, maxChunkBytes);
  const header = `id: ${message.id}\nevent: ${message.event}\n`;
  const payload = dataChunks.map((chunk) => `data: ${chunk}\n`).join("");
  return `${header}${payload}\n`;
}

/** Renders a collection of {@link SseMessage} instances into wire-ready frames. */
export function renderSseMessages<EventName extends string>(
  messages: Array<SseMessage<EventName>>,
  options: RenderSseMessageOptions = {},
): string {
  return messages.map((message) => renderSingleSseMessage(message, options)).join("");
}

/**
 * Bounded buffer guarding SSE emissions for a single client. Messages are rendered
 * eagerly into SSE frames and stored until downstream writers flush them. The buffer
 * enforces a strict capacity to avoid unbounded growth when consumers are slow.
 */
export class SseBuffer<EventName extends string = string> {
  private readonly maxBufferedBytes: number;
  private readonly emitTimeoutMs: number;
  private readonly options: SseBufferOptions;
  private readonly queue: Array<{ frame: string; bytes: number }> = [];
  /** Tracks how many frames were dropped for the associated client. */
  private droppedFrames = 0;
  /** Total number of bytes currently retained across buffered frames. */
  private bufferedBytes = 0;

  constructor(options: SseBufferOptions) {
    this.options = options;
    this.maxBufferedBytes = resolveMaxBufferedBytes(options.maxBufferedBytes);
    this.emitTimeoutMs = resolveEmitTimeoutMs(options.emitTimeoutMs);
  }

  /** Number of frames currently buffered. */
  get size(): number {
    return this.queue.length;
  }

  /** Aggregate byte size of the buffered frames. */
  get bufferedSizeBytes(): number {
    return this.bufferedBytes;
  }

  /** Total number of frames dropped for this client. */
  get droppedFrameCount(): number {
    return this.droppedFrames;
  }

  /** Clears buffered frames without notifying downstream consumers. */
  clear(): void {
    this.queue.length = 0;
    this.bufferedBytes = 0;
  }

  /**
   * Enqueues messages after rendering them into SSE frames. When the buffer overflows,
   * the oldest frames are discarded and a warning is emitted for observability.
   */
  enqueue(messages: Array<SseMessage<EventName>>): void {
    for (const message of messages) {
      const frame = renderSingleSseMessage(message, this.options);
      const bytes = Buffer.byteLength(frame, "utf8");
      this.queue.push({ frame, bytes });
      this.bufferedBytes += bytes;
    }

    if (this.bufferedBytes > this.maxBufferedBytes) {
      let dropped = 0;
      let freedBytes = 0;
      while (this.bufferedBytes > this.maxBufferedBytes && this.queue.length > 0) {
        const droppedFrame = this.queue.shift()!;
        this.bufferedBytes -= droppedFrame.bytes;
        dropped += 1;
        freedBytes += droppedFrame.bytes;
      }
      if (dropped > 0) {
        recordSseDrop(dropped);
        this.droppedFrames += dropped;
        this.options.logger.warn("resources_sse_buffer_overflow", {
          client_id: this.options.clientId,
          dropped,
          freed_bytes: freedBytes,
          capacity_bytes: this.maxBufferedBytes,
          buffered_bytes: this.bufferedBytes,
        });
      }
    }
  }

  /** Flushes buffered frames sequentially using the provided writer. */
  async drain(writer: (frame: string) => Promise<void>): Promise<void> {
    while (this.queue.length > 0) {
      const payload = this.queue.shift()!;
      this.bufferedBytes = Math.max(0, this.bufferedBytes - payload.bytes);
      const writeResult = writer(payload.frame);
      const timeout = this.emitTimeoutMs;

      if (timeout > 0) {
        try {
          const winner = await Promise.race([
            writeResult.then(() => "ok" as const),
            delay(timeout).then(() => "timeout" as const),
          ]);

          if (winner === "timeout") {
            recordSseDrop();
            this.droppedFrames += 1;
            this.options.logger.warn("resources_sse_emit_timeout", {
              client_id: this.options.clientId,
              timeout_ms: timeout,
            });
            void writeResult.catch((error) => {
              this.options.logger.warn("resources_sse_emit_failed", {
                client_id: this.options.clientId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
            break;
          }
        } catch (error) {
          recordSseDrop();
          this.droppedFrames += 1;
          this.options.logger.warn("resources_sse_emit_failed", {
            client_id: this.options.clientId,
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      } else {
        await writeResult;
      }
    }
  }
}
