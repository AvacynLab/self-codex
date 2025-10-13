import { CircuitBreaker, type CircuitBreakerOptions } from "../infra/circuitBreaker.js";

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
  /** Optional clock injected by tests. */
  now?: () => number;
  /**
   * Optional sleep primitive injected by tests. Defaults to a `setTimeout`-backed
   * promise which remains adequate for production usage.
   */
  sleep?: (ms: number) => Promise<void>;
}

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
  private readonly options: Required<Omit<OneForOneSupervisorOptions, "breaker">> & {
    breaker: CircuitBreakerOptions;
    backoffFactor: number;
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
    this.options = {
      breaker: options.breaker,
      minBackoffMs: Math.trunc(options.minBackoffMs),
      maxBackoffMs: Math.trunc(options.maxBackoffMs),
      backoffFactor: factor,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? defaultSleep,
    };
  }

  /**
   * Attempts to reserve a slot for the provided key. The method waits for the
   * computed backoff before resolving. Callers must invoke either `succeed()`
   * or `fail()` on the returned ticket.
   */
  async acquire(key: string): Promise<SupervisionTicket> {
    const state = this.lookupState(key);
    const attempt = state.breaker.tryAcquire();
    if (!attempt.allowed) {
      throw new ChildCircuitOpenError(key, attempt.state, attempt.retryAt);
    }

    const now = this.options.now();
    const waitMs = Math.max(0, state.nextAllowedAt - now);
    if (waitMs > 0) {
      await this.options.sleep(waitMs);
    }

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
        });
      },
      fail: () => {
        settle(() => {
          attempt.fail();
          this.bumpBackoff(state);
        });
      },
    };
  }

  /** Records a crash detected outside of an acquire ticket (e.g. runtime exit). */
  recordCrash(key: string, at: number = this.options.now()): void {
    const state = this.lookupState(key);
    state.breaker.recordFailure(at);
    this.bumpBackoff(state, at);
  }

  /** Records a clean shutdown, resetting both the backoff and breaker state. */
  recordSuccess(key: string): void {
    const state = this.lookupState(key);
    state.breaker.recordSuccess();
    this.resetState(state);
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
}
