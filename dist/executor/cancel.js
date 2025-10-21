import { EventEmitter } from "node:events";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { coerceNullToUndefined } from "../utils/object.js";
/** Event emitted whenever a cancellation is requested. */
const EVENT_CANCELLED = "cancelled";
/** Shared emitter used to fan-out cancellation notifications. */
const cancellationEmitter = new EventEmitter();
/** Registry storing the lifecycle of every cancellable operation. */
const operations = new Map();
/** Reverse index mapping run identifiers to their active operations. */
const runIndex = new Map();
/**
 * Error raised when an operation observes a cancellation signal. The error is
 * structured so the orchestrator can propagate consistent MCP payloads.
 */
export class OperationCancelledError extends Error {
    code = "E-CANCEL-OP";
    hint = "operation_cancelled";
    details;
    constructor(details) {
        super(details.reason
            ? `operation ${details.opId} cancelled: ${details.reason}`
            : `operation ${details.opId} cancelled`);
        this.name = "OperationCancelledError";
        this.details = details;
    }
}
/**
 * Error thrown when a caller attempts to cancel an unknown operation. The
 * message and hint intentionally mirror the specification excerpt used in the
 * checklist so automated clients can pattern-match the guidance.
 */
export class CancellationNotFoundError extends Error {
    code = "E-CANCEL-NOTFOUND";
    hint = "verify opId via events_subscribe";
    details;
    constructor(opId) {
        super("unknown opId");
        this.name = "CancellationNotFoundError";
        this.details = { opId };
    }
}
/**
 * Register a new cancellable operation. Consumers should ensure
 * {@link unregisterCancellation} is called once the work completes to avoid
 * leaking book-keeping data.
 */
export function registerCancellation(opId, options = {}) {
    if (operations.has(opId)) {
        throw new Error(`cancellation handle already registered for ${opId}`);
    }
    const controller = new AbortController();
    const runId = options.runId ?? null;
    const jobId = options.jobId ?? null;
    const graphId = options.graphId ?? null;
    const nodeId = options.nodeId ?? null;
    const childId = options.childId ?? null;
    const createdAt = options.createdAt ?? Date.now();
    const entry = {
        opId,
        controller,
        runId,
        jobId,
        graphId,
        nodeId,
        childId,
        createdAt,
        cancelledAt: null,
        reason: null,
        handle: null,
    };
    const handle = {
        get opId() {
            return entry.opId;
        },
        get runId() {
            return entry.runId;
        },
        get jobId() {
            return entry.jobId;
        },
        get graphId() {
            return entry.graphId;
        },
        get nodeId() {
            return entry.nodeId;
        },
        get childId() {
            return entry.childId;
        },
        get createdAt() {
            return entry.createdAt;
        },
        get cancelledAt() {
            return entry.cancelledAt;
        },
        get reason() {
            return entry.reason;
        },
        get signal() {
            return entry.controller.signal;
        },
        isCancelled() {
            return entry.controller.signal.aborted;
        },
        throwIfCancelled() {
            if (entry.controller.signal.aborted) {
                throw handle.toError();
            }
        },
        onCancel(listener) {
            const wrapped = (payload) => {
                if (payload.opId === entry.opId) {
                    listener({ reason: payload.reason, at: payload.at });
                }
            };
            cancellationEmitter.on(EVENT_CANCELLED, wrapped);
            return () => {
                cancellationEmitter.off(EVENT_CANCELLED, wrapped);
            };
        },
        toError() {
            return new OperationCancelledError({
                opId: entry.opId,
                runId: entry.runId,
                jobId: entry.jobId,
                graphId: entry.graphId,
                nodeId: entry.nodeId,
                childId: entry.childId,
                reason: entry.reason,
            });
        },
    };
    // The handle is assigned after construction so the registry always exposes a
    // fully initialised structure when accessed through {@link getCancellation}.
    entry.handle = handle;
    operations.set(opId, entry);
    if (runId) {
        if (!runIndex.has(runId)) {
            runIndex.set(runId, new Set());
        }
        runIndex.get(runId).add(opId);
    }
    return handle;
}
/** Retrieve a handle previously registered with {@link registerCancellation}. */
export function getCancellation(opId) {
    const handle = operations.get(opId)?.handle;
    return coerceNullToUndefined(handle);
}
/** Remove the bookkeeping for an operation once it settles. */
export function unregisterCancellation(opId) {
    const entry = operations.get(opId);
    if (!entry) {
        return;
    }
    operations.delete(opId);
    if (entry.runId) {
        const bucket = runIndex.get(entry.runId);
        if (bucket) {
            bucket.delete(opId);
            if (bucket.size === 0) {
                runIndex.delete(entry.runId);
            }
        }
    }
}
/** Determine whether an operation has observed a cancellation request. */
export function isCancelled(opId) {
    return operations.get(opId)?.controller.signal.aborted ?? false;
}
/**
 * Request the cancellation of a specific operation. Throws
 * {@link CancellationNotFoundError} when the identifier was never registered or
 * already cleaned up from the registry.
 */
export function requestCancellation(opId, options = {}) {
    const entry = operations.get(opId);
    if (!entry) {
        throw new CancellationNotFoundError(opId);
    }
    const alreadyCancelled = entry.controller.signal.aborted;
    if (!alreadyCancelled) {
        entry.reason = options.reason ?? entry.reason;
        entry.cancelledAt = options.at ?? Date.now();
        entry.controller.abort();
        const at = entry.cancelledAt ?? Date.now();
        cancellationEmitter.emit(EVENT_CANCELLED, {
            opId: entry.opId,
            runId: entry.runId,
            jobId: entry.jobId,
            graphId: entry.graphId,
            nodeId: entry.nodeId,
            childId: entry.childId,
            reason: entry.reason,
            at,
            outcome: "requested",
        });
        return "requested";
    }
    if (options.reason && !entry.reason) {
        entry.reason = options.reason;
    }
    const at = options.at ?? Date.now();
    cancellationEmitter.emit(EVENT_CANCELLED, {
        opId: entry.opId,
        runId: entry.runId,
        jobId: entry.jobId,
        graphId: entry.graphId,
        nodeId: entry.nodeId,
        childId: entry.childId,
        reason: entry.reason,
        at,
        outcome: "already_cancelled",
    });
    return "already_cancelled";
}
/**
 * Alias maintained for parity with earlier checklist wording. The
 * implementation defers to {@link requestCancellation} so callers benefit from
 * the stricter error handling.
 */
export function requestCancel(opId, options = {}) {
    return requestCancellation(opId, options);
}
/**
 * Request the cancellation of every operation associated with the provided run
 * identifier. The function returns the list of affected operations along with
 * their individual outcomes so callers can report partial failures.
 */
export function cancelRun(runId, options = {}) {
    const bucket = runIndex.get(runId);
    if (!bucket || bucket.size === 0) {
        return [];
    }
    const results = [];
    for (const opId of bucket) {
        const outcome = requestCancellation(opId, options);
        const entry = operations.get(opId);
        results.push({
            opId,
            outcome,
            runId: entry?.runId ?? null,
            jobId: entry?.jobId ?? null,
            graphId: entry?.graphId ?? null,
            nodeId: entry?.nodeId ?? null,
            childId: entry?.childId ?? null,
        });
    }
    return results;
}
/**
 * Utility mainly exposed for unit tests so they can isolate registry state
 * without relying on implicit global ordering.
 */
export function resetCancellationRegistry() {
    operations.clear();
    runIndex.clear();
}
/**
 * Subscribe to cancellation lifecycle events. The returned disposer must be
 * invoked to avoid leaking listeners when the orchestrator shuts down.
 */
export function subscribeCancellationEvents(listener) {
    cancellationEmitter.on(EVENT_CANCELLED, listener);
    return () => {
        cancellationEmitter.off(EVENT_CANCELLED, listener);
    };
}
//# sourceMappingURL=cancel.js.map