import { EventEmitter } from "node:events";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Outcome returned when requesting the cancellation of an operation. The enum
 * allows callers to differentiate between successful requests and idempotent
 * retries without resorting to exceptions.
 */
export type CancellationRequestOutcome = "requested" | "already_cancelled";

/**
 * Internal representation for every tracked operation. The entry stores
 * metadata so diagnostics and tests can assert timelines deterministically.
 */
interface CancellationEntry {
  readonly opId: string;
  readonly controller: AbortController;
  runId: string | null;
  jobId: string | null;
  graphId: string | null;
  nodeId: string | null;
  childId: string | null;
  createdAt: number;
  cancelledAt: number | null;
  reason: string | null;
  /**
   * Public-facing handle mirroring the entry. The value is assigned once the
   * handle is constructed so callers never observe a partially initialised
   * structure when reading from the registry.
   */
  handle: CancellationHandle | null;
}

/** Event emitted whenever a cancellation is requested. */
const EVENT_CANCELLED = "cancelled";

/**
 * Structured payload describing the lifecycle of a cancellation request. The
 * outcome differentiates between the first successful signal and idempotent
 * retries so observers can keep deterministic timelines.
 */
export interface CancellationEventPayload {
  /** Operation identifier the cancellation targets. */
  opId: string;
  /** Optional run identifier associated with the operation. */
  runId: string | null;
  /** Optional job identifier correlated with the operation. */
  jobId: string | null;
  /** Optional graph identifier correlated with the operation. */
  graphId: string | null;
  /** Optional node identifier correlated with the operation. */
  nodeId: string | null;
  /** Optional child identifier correlated with the operation. */
  childId: string | null;
  /** Human readable reason attached to the request, if any. */
  reason: string | null;
  /** Monotonic timestamp recorded when the request was observed. */
  at: number;
  /** Outcome describing whether the cancellation was newly requested or idempotent. */
  outcome: CancellationRequestOutcome;
}

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
  public readonly details: {
    opId: string;
    runId: string | null;
    jobId: string | null;
    graphId: string | null;
    nodeId: string | null;
    childId: string | null;
    reason: string | null;
  };

  constructor(details: {
    opId: string;
    runId: string | null;
    jobId: string | null;
    graphId: string | null;
    nodeId: string | null;
    childId: string | null;
    reason: string | null;
  }) {
    super(
      details.reason
        ? `operation ${details.opId} cancelled: ${details.reason}`
        : `operation ${details.opId} cancelled`,
    );
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
  public readonly code = "E-CANCEL-NOTFOUND";
  public readonly hint = "verify opId via events_subscribe";
  public readonly details: { opId: string };

  constructor(opId: string) {
    super("unknown opId");
    this.name = "CancellationNotFoundError";
    this.details = { opId };
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
  /** Optional job identifier correlated to the operation. */
  readonly jobId: string | null;
  /** Optional graph identifier correlated to the operation. */
  readonly graphId: string | null;
  /** Optional node identifier correlated to the operation. */
  readonly nodeId: string | null;
  /** Optional child identifier correlated to the operation. */
  readonly childId: string | null;
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
  options: {
    runId?: string | null;
    jobId?: string | null;
    graphId?: string | null;
    nodeId?: string | null;
    childId?: string | null;
    createdAt?: number;
  } = {},
): CancellationHandle {
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

  const entry: CancellationEntry = {
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

  const handle: CancellationHandle = {
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
    runIndex.get(runId)!.add(opId);
  }

  return handle;
}

/** Retrieve a handle previously registered with {@link registerCancellation}. */
export function getCancellation(opId: string): CancellationHandle | undefined {
  const handle = operations.get(opId)?.handle;
  return handle ?? undefined;
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
 * Request the cancellation of a specific operation. Throws
 * {@link CancellationNotFoundError} when the identifier was never registered or
 * already cleaned up from the registry.
 */
export function requestCancellation(
  opId: string,
  options: { reason?: string | null; at?: number } = {},
): CancellationRequestOutcome {
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
    } satisfies CancellationEventPayload);
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
  } satisfies CancellationEventPayload);
  return "already_cancelled";
}

/**
 * Alias maintained for parity with earlier checklist wording. The
 * implementation defers to {@link requestCancellation} so callers benefit from
 * the stricter error handling.
 */
export function requestCancel(
  opId: string,
  options: { reason?: string | null; at?: number } = {},
): CancellationRequestOutcome {
  return requestCancellation(opId, options);
}

/** Structured result describing the cancellation status of an operation. */
export interface CancellationRunResult {
  opId: string;
  outcome: CancellationRequestOutcome;
  runId: string | null;
  jobId: string | null;
  graphId: string | null;
  nodeId: string | null;
  childId: string | null;
}

/**
 * Request the cancellation of every operation associated with the provided run
 * identifier. The function returns the list of affected operations along with
 * their individual outcomes so callers can report partial failures.
 */
export function cancelRun(
  runId: string,
  options: { reason?: string | null; at?: number } = {},
): CancellationRunResult[] {
  const bucket = runIndex.get(runId);
  if (!bucket || bucket.size === 0) {
    return [];
  }
  const results: CancellationRunResult[] = [];
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
export function resetCancellationRegistry(): void {
  operations.clear();
  runIndex.clear();
}

/**
 * Subscribe to cancellation lifecycle events. The returned disposer must be
 * invoked to avoid leaking listeners when the orchestrator shuts down.
 */
export function subscribeCancellationEvents(
  listener: (event: CancellationEventPayload) => void,
): () => void {
  cancellationEmitter.on(EVENT_CANCELLED, listener);
  return () => {
    cancellationEmitter.off(EVENT_CANCELLED, listener);
  };
}
