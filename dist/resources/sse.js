import { serialiseForSse } from "../events/sse.js";
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
/**
 * Renders SSE messages into a wire-ready string. Tests and upcoming HTTP
 * handlers share this helper to keep the framing (`id/event/data` + blank line)
 * consistent with the other SSE endpoints.
 */
export function renderResourceWatchSseMessages(messages) {
    return messages.map((message) => `id: ${message.id}\nevent: ${message.event}\ndata: ${message.data}\n\n`).join("");
}
