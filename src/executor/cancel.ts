import { EventEmitter } from "node:events";

/**
 * Outcome returned when requesting the cancellation of an operation. The enum
 * allows callers to differentiate between successful requests and idempotent
 * retries without resorting to exceptions.
 */
export type CancellationRequestOutcome = "requested" | "already_cancelled" | "not_found";

/**
 * Internal representation for every tracked operation. The entry stores
 * metadata so diagnostics and tests can assert timelines deterministically.
 */
interface CancellationEntry {
  readonly opId: string;
  readonly controller: AbortController;
  runId: string | null;
  createdAt: number;
  cancelledAt: number | null;
  reason: string | null;
  handle: CancellationHandle;
}

/** Event emitted whenever a cancellation is requested. */
const EVENT_CANCELLED = "cancelled";

/** Shared emitter used to fan-out cancellation notifications. */
const cancellationEmitter = new EventEmitter();

/** Registry storing the lifecycle of every cancellable operation. */
const operations = new Map<string, CancellationEntry>();

/** Reverse index mapping run identifiers to their active operations. */
const runIndex = new Map<string, Set<string>>();

/**
 * Error raised when an operation observes a cancellation signal. The error is
 * structured so the orchestrator can propagate consistent MCP payloads.
 */
export class OperationCancelledError extends Error {
  public readonly code = "E-CANCEL-OP";
  public readonly hint = "operation_cancelled";
  public readonly details: { opId: string; runId: string | null; reason: string | null };

  constructor(opId: string, runId: string | null, reason: string | null) {
    super(reason ? `operation ${opId} cancelled: ${reason}` : `operation ${opId} cancelled`);
    this.name = "OperationCancelledError";
    this.details = { opId, runId, reason };
  }
}

/**
 * Public handle returned to callers when registering an operation. The handle
 * exposes helpers that keep runtime code agnostic of the underlying registry
 * implementation.
 */
export interface CancellationHandle {
  /** Operation identifier associated with the handle. */
  readonly opId: string;
  /** Optional run identifier correlated to the operation. */
  readonly runId: string | null;
  /** Monotonic creation timestamp. */
  readonly createdAt: number;
  /** Timestamp recorded when the cancellation was requested, if any. */
  readonly cancelledAt: number | null;
  /** Human readable reason supplied by the caller, if any. */
  readonly reason: string | null;
  /** Abort signal toggled when a cancellation is requested. */
  readonly signal: AbortSignal;
  /** Determine whether the operation has already been cancelled. */
  isCancelled(): boolean;
  /** Throw a structured {@link OperationCancelledError} when cancelled. */
  throwIfCancelled(): void;
  /** Subscribe to cancellation notifications. */
  onCancel(listener: (payload: { reason: string | null; at: number }) => void): () => void;
  /** Build an {@link OperationCancelledError} mirroring the current state. */
  toError(): OperationCancelledError;
}

/**
 * Register a new cancellable operation. Consumers should ensure
 * {@link unregisterCancellation} is called once the work completes to avoid
 * leaking book-keeping data.
 */
export function registerCancellation(
  opId: string,
  options: { runId?: string | null; createdAt?: number } = {},
): CancellationHandle {
  if (operations.has(opId)) {
    throw new Error(`cancellation handle already registered for ${opId}`);
  }

  const controller = new AbortController();
  const runId = options.runId ?? null;
  const createdAt = options.createdAt ?? Date.now();

  const entry: CancellationEntry = {
    opId,
    controller,
    runId,
    createdAt,
    cancelledAt: null,
    reason: null,
    handle: undefined as unknown as CancellationHandle,
  };

  const handle: CancellationHandle = {
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
    isCancelled(): boolean {
      return entry.controller.signal.aborted;
    },
    throwIfCancelled(): void {
      if (entry.controller.signal.aborted) {
        throw handle.toError();
      }
    },
    onCancel(listener: (payload: { reason: string | null; at: number }) => void): () => void {
      const wrapped = (payload: { opId: string; reason: string | null; at: number }) => {
        if (payload.opId === entry.opId) {
          listener({ reason: payload.reason, at: payload.at });
        }
      };
      cancellationEmitter.on(EVENT_CANCELLED, wrapped);
      return () => {
        cancellationEmitter.off(EVENT_CANCELLED, wrapped);
      };
    },
    toError(): OperationCancelledError {
      return new OperationCancelledError(entry.opId, entry.runId, entry.reason);
    },
  };

  entry.handle = handle;
  operations.set(opId, entry);
  if (runId) {
    if (!runIndex.has(runId)) {
      runIndex.set(runId, new Set());
    }
    runIndex.get(runId)!.add(opId);
  }

  return handle;
}

/** Retrieve a handle previously registered with {@link registerCancellation}. */
export function getCancellation(opId: string): CancellationHandle | undefined {
  return operations.get(opId)?.handle;
}

/** Remove the bookkeeping for an operation once it settles. */
export function unregisterCancellation(opId: string): void {
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
export function isCancelled(opId: string): boolean {
  return operations.get(opId)?.controller.signal.aborted ?? false;
}

/**
 * Request the cancellation of a specific operation.
 */
export function requestCancellation(
  opId: string,
  options: { reason?: string | null; at?: number } = {},
): CancellationRequestOutcome {
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
export function cancelRun(
  runId: string,
  options: { reason?: string | null; at?: number } = {},
): Array<{ opId: string; outcome: CancellationRequestOutcome }> {
  const bucket = runIndex.get(runId);
  if (!bucket || bucket.size === 0) {
    return [];
  }
  const results: Array<{ opId: string; outcome: CancellationRequestOutcome }> = [];
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
export function resetCancellationRegistry(): void {
  operations.clear();
  runIndex.clear();
}
