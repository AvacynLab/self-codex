import { EventEmitter } from "node:events";
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
    constructor(opId, runId, reason) {
        super(reason ? `operation ${opId} cancelled: ${reason}` : `operation ${opId} cancelled`);
        this.name = "OperationCancelledError";
        this.details = { opId, runId, reason };
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
    const createdAt = options.createdAt ?? Date.now();
    const entry = {
        opId,
        controller,
        runId,
        createdAt,
        cancelledAt: null,
        reason: null,
        handle: undefined,
    };
    const handle = {
        get opId() {
            return entry.opId;
        },
        get runId() {
            return entry.runId;
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
            return new OperationCancelledError(entry.opId, entry.runId, entry.reason);
        },
    };
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
    return operations.get(opId)?.handle;
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
 * Request the cancellation of a specific operation.
 */
export function requestCancellation(opId, options = {}) {
    const entry = operations.get(opId);
    if (!entry) {
        return "not_found";
    }
    const alreadyCancelled = entry.controller.signal.aborted;
    if (!alreadyCancelled) {
        entry.reason = options.reason ?? entry.reason;
        entry.cancelledAt = options.at ?? Date.now();
        entry.controller.abort();
        cancellationEmitter.emit(EVENT_CANCELLED, {
            opId: entry.opId,
            reason: entry.reason,
            at: entry.cancelledAt ?? Date.now(),
        });
        return "requested";
    }
    if (options.reason && !entry.reason) {
        entry.reason = options.reason;
    }
    return "already_cancelled";
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
        results.push({ opId, outcome });
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
