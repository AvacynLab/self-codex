import { Buffer } from "node:buffer";
import { readInt } from "../config/env.js";
import { setTimeout as delay } from "node:timers/promises";
import { TextEncoder } from "node:util";
import { serialiseForSse } from "../events/sse.js";
import { recordSseDrop } from "../infra/tracing.js";
/**
 * Normalises a run event for transport by switching to `snake_case` keys and
 * removing `undefined` values. The helper keeps the original payload intact so
 * downstream tools receive the same structure as `resources_watch`.
 */
function normaliseRunEvent(event) {
    return {
        type: "run_event",
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
function normaliseChildLog(entry) {
    return {
        type: "child_log",
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
function normaliseBlackboardEvent(event) {
    return {
        type: "blackboard_event",
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
function buildPayload(result, record) {
    const payload = {
        uri: result.uri,
        kind: result.kind,
        next_seq: result.nextSeq,
        record,
    };
    const filters = result.filters;
    if (filters) {
        const snapshot = {};
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
export function serialiseResourceWatchResultForSse(result) {
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
            const payload = buildPayload(result, normaliseRunEvent(event));
            return {
                id: `${result.uri}:${event.seq}`,
                event: "resource_run_event",
                data: serialiseForSse(payload),
            };
        }
        if (result.kind === "blackboard_namespace") {
            const payload = buildPayload(result, normaliseBlackboardEvent(event));
            return {
                id: `${result.uri}:${event.seq}`,
                event: "resource_blackboard_event",
                data: serialiseForSse(payload),
            };
        }
        const payload = buildPayload(result, normaliseChildLog(event));
        return {
            id: `${result.uri}:${event.seq}`,
            event: "resource_child_log",
            data: serialiseForSse(payload),
        };
    });
}
/** Default chunk size applied to SSE payloads when the environment omits overrides. */
const DEFAULT_MAX_CHUNK_BYTES = 32 * 1024;
/** Default number of bytes retained across buffered frames before backpressure drops kick in. */
const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;
/** Default timeout granted to downstream writers when flushing SSE frames (in milliseconds). */
const DEFAULT_EMIT_TIMEOUT_MS = 5_000;
function resolveMaxChunkBytes(override) {
    if (override && override > 0) {
        return override;
    }
    return readInt("MCP_SSE_MAX_CHUNK_BYTES", DEFAULT_MAX_CHUNK_BYTES, { min: 1 });
}
function resolveMaxBufferedBytes(override) {
    if (override && override > 0) {
        return override;
    }
    return readInt("MCP_SSE_MAX_BUFFER", DEFAULT_MAX_BUFFERED_BYTES, { min: 1 });
}
function resolveEmitTimeoutMs(override) {
    if (override && override > 0) {
        return override;
    }
    return readInt("MCP_SSE_EMIT_TIMEOUT_MS", DEFAULT_EMIT_TIMEOUT_MS, { min: 1 });
}
const utf8Encoder = new TextEncoder();
function chunkUtf8String(value, maxBytes) {
    if (maxBytes <= 0) {
        return [value];
    }
    const chunks = [];
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
        }
        else {
            current += char;
            currentBytes += encoded.length;
        }
    }
    if (current.length > 0 || chunks.length === 0) {
        chunks.push(current);
    }
    return chunks;
}
function renderSingleSseMessage(message, options = {}) {
    const maxChunkBytes = resolveMaxChunkBytes(options.maxChunkBytes);
    const dataChunks = chunkUtf8String(message.data, maxChunkBytes);
    const header = `id: ${message.id}\nevent: ${message.event}\n`;
    const payload = dataChunks.map((chunk) => `data: ${chunk}\n`).join("");
    return `${header}${payload}\n`;
}
export function renderResourceWatchSseMessages(messages, options = {}) {
    return messages.map((message) => renderSingleSseMessage(message, options)).join("");
}
/**
 * Bounded buffer guarding SSE emissions for a single client. Messages are
 * rendered eagerly into SSE frames and stored until a downstream writer drains
 * them. The buffer enforces a strict capacity to avoid unbounded growth when
 * consumers are slow or disconnected.
 */
export class ResourceWatchSseBuffer {
    maxBufferedBytes;
    emitTimeoutMs;
    options;
    queue = [];
    /**
     * Monotonic counter tracking the number of frames discarded for this client.
     * The metric complements the global observability signal and is primarily
     * used by tests to ensure drops are recorded whenever backpressure triggers.
     */
    droppedFrames = 0;
    /** Tracks the cumulative byte size of buffered frames for overflow checks. */
    bufferedBytes = 0;
    constructor(options) {
        this.options = options;
        this.maxBufferedBytes = resolveMaxBufferedBytes(options.maxBufferedBytes);
        this.emitTimeoutMs = resolveEmitTimeoutMs(options.emitTimeoutMs);
    }
    /** Number of SSE frames currently stored in the buffer. */
    get size() {
        return this.queue.length;
    }
    /** Total number of bytes occupied by the buffered SSE frames. */
    get bufferedSizeBytes() {
        return this.bufferedBytes;
    }
    /** Total number of frames dropped for this buffer instance. */
    get droppedFrameCount() {
        return this.droppedFrames;
    }
    /** Clears all buffered frames without notifying downstream consumers. */
    clear() {
        this.queue.length = 0;
        this.bufferedBytes = 0;
    }
    /**
     * Enqueues a collection of messages after rendering them into SSE frames.
     * When the buffer overflows, the oldest frames are discarded and a warning is
     * emitted so operators can correlate the drop with the affected client.
     */
    enqueue(messages) {
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
                const droppedFrame = this.queue.shift();
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
    /**
     * Flushes buffered frames sequentially using the provided writer. Each frame
     * is awaited with a timeout so a stalled consumer does not exhaust memory.
     */
    async drain(writer) {
        while (this.queue.length > 0) {
            const payload = this.queue.shift();
            this.bufferedBytes = Math.max(0, this.bufferedBytes - payload.bytes);
            const writeResult = writer(payload.frame);
            const timeout = this.emitTimeoutMs;
            if (timeout > 0) {
                try {
                    const winner = await Promise.race([
                        writeResult.then(() => "ok"),
                        delay(timeout).then(() => "timeout"),
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
                                error: error instanceof Error ? error.message : String(error),
                            });
                        });
                        // Drop the frame silently since the consumer is not draining fast enough.
                        continue;
                    }
                }
                catch (error) {
                    recordSseDrop();
                    this.droppedFrames += 1;
                    this.options.logger.warn("resources_sse_emit_failed", {
                        client_id: this.options.clientId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }
            }
            else {
                try {
                    await writeResult;
                }
                catch (error) {
                    recordSseDrop();
                    this.droppedFrames += 1;
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
export { DEFAULT_MAX_CHUNK_BYTES, DEFAULT_MAX_BUFFERED_BYTES, DEFAULT_EMIT_TIMEOUT_MS, };
//# sourceMappingURL=sse.js.map