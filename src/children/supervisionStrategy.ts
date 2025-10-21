import { CircuitBreaker, type CircuitBreakerOptions, type CircuitBreakerState } from "../infra/circuitBreaker.js";

/**
 * Options accepted by the {@link OneForOneSupervisor}. The defaults favour a
 * conservative strategy where repeated crashes quickly backoff while still
 * allowing a single probe after the cooldown window elapsed.
 */
export interface OneForOneSupervisorOptions {
  /** Configuration forwarded to the underlying circuit breaker. */
  breaker: CircuitBreakerOptions;
  /** Initial delay applied after the first failure. */
  minBackoffMs: number;
  /** Maximum delay enforced after successive failures. */
  maxBackoffMs: number;
  /** Multiplicative factor applied after each failure (defaults to `2`). */
  backoffFactor?: number;
  /**
   * Maximum number of restart attempts allowed within a one-minute sliding
   * window. `null` (or values <= 0) disable the quota and preserve the legacy
   * behaviour.
   */
  maxRestartsPerMinute?: number | null;
  /** Optional clock injected by tests. */
  now?: () => number;
  /**
   * Optional sleep primitive injected by tests. Defaults to a `setTimeout`-backed
   * promise which remains adequate for production usage.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Optional hook invoked whenever the supervisor emits lifecycle events. */
  onEvent?: (event: SupervisorEvent) => void;
}

/**
 * Structured events emitted by the supervisor so callers can surface lifecycle
 * transitions on the unified event bus or feed observability pipelines.
 */
export type SupervisorEvent =
  | {
      type: "child_restart";
      key: string;
      attempt: number;
      breakerState: CircuitBreakerState;
      at: number;
      delayMs: number;
      backoffWaitMs: number;
      quotaWaitMs: number;
    }
  | { type: "breaker_open"; key: string; retryAt: number | null }
  | { type: "breaker_half_open"; key: string }
  | { type: "breaker_closed"; key: string };

/** Error thrown when the circuit breaker refuses additional attempts. */
export class ChildCircuitOpenError extends Error {
  constructor(
    public readonly key: string,
    public readonly state: ReturnType<CircuitBreaker["getState"]>,
    public readonly retryAt: number | null,
  ) {
    super(
      retryAt === null
        ? `Circuit breaker for ${key} is ${state}`
        : `Circuit breaker for ${key} is ${state}; retry after ${retryAt}`,
    );
    this.name = "ChildCircuitOpenError";
  }
}

/** Handle returned when the supervisor authorises a new attempt. */
export interface SupervisionTicket {
  /** Identifier of the supervised slot (command signature). */
  readonly key: string;
  /** State observed while acquiring the ticket. */
  readonly state: ReturnType<CircuitBreaker["getState"]>;
  /**
   * Marks the attempt as successful which resets both the backoff and breaker
   * counters.
   */
  succeed(): void;
  /** Marks the attempt as failed, increasing the backoff and breaker counters. */
  fail(): void;
}

interface SupervisedChildState {
  attempts: number;
  nextDelayMs: number;
  nextAllowedAt: number;
  breaker: CircuitBreaker;
  restartTimestamps: number[];
  lastBreakerState: CircuitBreakerState;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Supervisor implementing the classic one-for-one strategy: every crashing
 * child is restarted individually after waiting for an exponential backoff.
 * Once the number of consecutive failures crosses the configured threshold the
 * circuit breaker opens and further attempts are rejected until the cooldown
 * expires.
 */
export class OneForOneSupervisor {
  private readonly options: {
    breaker: CircuitBreakerOptions;
    minBackoffMs: number;
    maxBackoffMs: number;
    backoffFactor: number;
    maxRestartsPerMinute: number | null;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    onEvent?: (event: SupervisorEvent) => void;
  };
  private readonly children = new Map<string, SupervisedChildState>();

  constructor(options: OneForOneSupervisorOptions) {
    if (!Number.isFinite(options.minBackoffMs) || options.minBackoffMs < 0) {
      throw new Error("minBackoffMs must be a non-negative finite number");
    }
    if (!Number.isFinite(options.maxBackoffMs) || options.maxBackoffMs < options.minBackoffMs) {
      throw new Error("maxBackoffMs must be >= minBackoffMs and finite");
    }
    const factor = options.backoffFactor ?? 2;
    if (!Number.isFinite(factor) || factor < 1) {
      throw new Error("backoffFactor must be a finite number >= 1");
    }
    const maxRestartsRaw = options.maxRestartsPerMinute;
    let maxRestartsPerMinute: number | null = null;
    if (typeof maxRestartsRaw === "number" && Number.isFinite(maxRestartsRaw)) {
      maxRestartsPerMinute = maxRestartsRaw > 0 ? Math.trunc(maxRestartsRaw) : null;
    }

    const onEvent = options.onEvent;
    this.options = {
      breaker: options.breaker,
      minBackoffMs: Math.trunc(options.minBackoffMs),
      maxBackoffMs: Math.trunc(options.maxBackoffMs),
      backoffFactor: factor,
      maxRestartsPerMinute,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? defaultSleep,
      ...(onEvent ? { onEvent } : {}),
    };
  }

  /**
   * Attempts to reserve a slot for the provided key. The method waits for the
   * computed backoff before resolving. Callers must invoke either `succeed()`
   * or `fail()` on the returned ticket.
   */
  async acquire(key: string): Promise<SupervisionTicket> {
    const state = this.lookupState(key);
    this.syncBreakerState(state, key);

    const attempt = state.breaker.tryAcquire();
    if (!attempt.allowed) {
      this.handleBreakerState(state, key, attempt.state, attempt.retryAt ?? null);
      throw new ChildCircuitOpenError(key, attempt.state, attempt.retryAt);
    }

    this.handleBreakerState(state, key, attempt.state, state.breaker.nextRetryAt());

    const now = this.options.now();
    const backoffWait = Math.max(0, state.nextAllowedAt - now);
    const quotaWait = this.computeQuotaWait(state, now);
    const waitMs = Math.max(backoffWait, quotaWait);
    if (waitMs > 0) {
      await this.options.sleep(waitMs);
    }

    const startedAt = this.options.now();
    this.recordRestart(state, startedAt);

    this.emit({
      type: "child_restart",
      key,
      attempt: state.attempts + 1,
      breakerState: attempt.state,
      at: startedAt,
      delayMs: waitMs,
      backoffWaitMs: backoffWait,
      quotaWaitMs: quotaWait,
    });

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    return {
      key,
      state: attempt.state,
      succeed: () => {
        settle(() => {
          attempt.succeed();
          this.resetState(state);
          this.handleBreakerState(state, key, state.breaker.getState(), state.breaker.nextRetryAt());
        });
      },
      fail: () => {
        settle(() => {
          attempt.fail();
          this.bumpBackoff(state);
          this.handleBreakerState(state, key, state.breaker.getState(), state.breaker.nextRetryAt());
        });
      },
    };
  }

  /** Records a crash detected outside of an acquire ticket (e.g. runtime exit). */
  recordCrash(key: string, at: number = this.options.now()): void {
    const state = this.lookupState(key);
    state.breaker.recordFailure(at);
    this.bumpBackoff(state, at);
    this.handleBreakerState(state, key, state.breaker.getState(), state.breaker.nextRetryAt());
  }

  /** Records a clean shutdown, resetting both the backoff and breaker state. */
  recordSuccess(key: string): void {
    const state = this.lookupState(key);
    state.breaker.recordSuccess();
    this.resetState(state);
    this.handleBreakerState(state, key, state.breaker.getState(), state.breaker.nextRetryAt());
  }

  /** Drops the cached state for a given key. */
  clear(key: string): void {
    this.children.delete(key);
  }

  private lookupState(key: string): SupervisedChildState {
    let state = this.children.get(key);
    if (!state) {
      state = {
        attempts: 0,
        nextDelayMs: this.options.minBackoffMs,
        nextAllowedAt: 0,
        breaker: new CircuitBreaker({ ...this.options.breaker, now: this.options.now }),
        restartTimestamps: [],
        lastBreakerState: "closed",
      };
      this.children.set(key, state);
    }
    return state;
  }

  private resetState(state: SupervisedChildState): void {
    state.attempts = 0;
    state.nextDelayMs = this.options.minBackoffMs;
    state.nextAllowedAt = 0;
  }

  private bumpBackoff(state: SupervisedChildState, at: number = this.options.now()): void {
    state.attempts += 1;
    const nextDelay = state.attempts === 1
      ? this.options.minBackoffMs
      : Math.min(this.options.maxBackoffMs, Math.round(state.nextDelayMs * this.options.backoffFactor));
    state.nextDelayMs = Math.max(this.options.minBackoffMs, nextDelay);
    state.nextAllowedAt = at + state.nextDelayMs;
  }

  private recordRestart(state: SupervisedChildState, at: number): void {
    this.pruneRestartHistory(state, at);
    state.restartTimestamps.push(at);
  }

  private pruneRestartHistory(state: SupervisedChildState, now: number): void {
    if (!state.restartTimestamps.length) {
      return;
    }
    const windowStart = now - 60_000;
    let index = 0;
    while (index < state.restartTimestamps.length && state.restartTimestamps[index] < windowStart) {
      index += 1;
    }
    if (index > 0) {
      state.restartTimestamps.splice(0, index);
    }
  }

  private computeQuotaWait(state: SupervisedChildState, now: number): number {
    const quota = this.options.maxRestartsPerMinute;
    if (quota === null) {
      return 0;
    }
    this.pruneRestartHistory(state, now);
    if (state.restartTimestamps.length < quota) {
      return 0;
    }
    const earliest = state.restartTimestamps[0];
    const allowedAt = earliest + 60_000;
    return Math.max(0, allowedAt - now);
  }

  private handleBreakerState(
    state: SupervisedChildState,
    key: string,
    observed: CircuitBreakerState,
    retryAt: number | null,
  ): void {
    if (observed === "open") {
      this.emit({ type: "breaker_open", key, retryAt });
    }
    if (state.lastBreakerState === observed) {
      return;
    }
    state.lastBreakerState = observed;
    if (observed === "half-open") {
      this.emit({ type: "breaker_half_open", key });
    } else if (observed === "closed") {
      this.emit({ type: "breaker_closed", key });
    }
  }

  private syncBreakerState(state: SupervisedChildState, key: string): void {
    this.handleBreakerState(state, key, state.breaker.getState(), state.breaker.nextRetryAt());
  }

  private emit(event: SupervisorEvent): void {
    if (!this.options.onEvent) {
      return;
    }
    try {
      this.options.onEvent(event);
    } catch {
      // Observability hooks must never compromise supervision. Errors are
      // swallowed intentionally to keep the restart loop resilient.
    }
  }
}
