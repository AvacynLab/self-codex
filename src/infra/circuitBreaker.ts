/**
 * Minimal circuit breaker implementation used to protect expensive operations
 * such as spawning external processes. The helper intentionally keeps the state
 * machine explicit so the supervisor can introspect transitions during tests
 * and correlate errors with telemetry later on.
 */
export type CircuitBreakerState = "closed" | "open" | "half-open";

/** Configuration options accepted by {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures tolerated before the breaker opens. */
  failThreshold: number;
  /** Cooldown window (in milliseconds) enforced once the breaker is open. */
  cooldownMs: number;
  /**
   * Maximum number of in-flight operations allowed while the breaker is
   * half-open. Defaults to `1` which matches the classic fail-fast behaviour.
   */
  halfOpenMaxInFlight?: number;
  /** Optional clock used to ease deterministic testing. */
  now?: () => number;
}

/** Result returned when attempting to reserve the breaker. */
export type CircuitBreakerAttempt =
  | (CircuitBreakerPermit & { allowed: true })
  | CircuitBreakerRejection;

/** Structure describing a rejected attempt. */
export interface CircuitBreakerRejection {
  allowed: false;
  /** State observed while denying the attempt. */
  state: CircuitBreakerState;
  /** Timestamp at which a new attempt may be allowed (null when unknown). */
  retryAt: number | null;
}

/** Handle returned when the breaker authorises an operation. */
export interface CircuitBreakerPermit {
  allowed: true;
  /** State observed when the permit was granted. */
  state: CircuitBreakerState;
  /** Marks the operation as successful, potentially closing the breaker. */
  succeed(): void;
  /** Marks the operation as failed and updates the breaker accordingly. */
  fail(): void;
}

/** Error surfaced whenever the breaker refuses to authorise an operation. */
export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly state: CircuitBreakerState,
    public readonly retryAt: number | null,
  ) {
    super(
      retryAt === null
        ? `Circuit breaker is ${state}; retry later`
        : `Circuit breaker is ${state}; retry after ${retryAt}`,
    );
    this.name = "CircuitBreakerOpenError";
  }
}

/** Internal state tracked by the circuit breaker. */
interface CircuitBreakerInternalState {
  state: CircuitBreakerState;
  /** Number of consecutive failures observed in the closed state. */
  failureCount: number;
  /** Timestamp recorded when the breaker opened. */
  openedAt: number | null;
  /** Number of in-flight operations while half-open. */
  halfOpenInFlight: number;
}

/**
 * Circuit breaker guarding process management calls. The implementation keeps
 * the transition diagram compact while still surfacing the relevant metadata
 * to callers when a request is rejected.
 */
export class CircuitBreaker {
  private readonly options: Required<CircuitBreakerOptions>;
  private readonly state: CircuitBreakerInternalState;

  constructor(options: CircuitBreakerOptions) {
    if (!Number.isFinite(options.failThreshold) || options.failThreshold <= 0) {
      throw new Error("failThreshold must be a positive finite number");
    }
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
      throw new Error("cooldownMs must be a non-negative finite number");
    }
    const halfOpenMax = options.halfOpenMaxInFlight ?? 1;
    if (!Number.isFinite(halfOpenMax) || halfOpenMax <= 0) {
      throw new Error("halfOpenMaxInFlight must be a positive finite number");
    }

    this.options = {
      failThreshold: Math.trunc(options.failThreshold),
      cooldownMs: Math.trunc(options.cooldownMs),
      halfOpenMaxInFlight: Math.trunc(halfOpenMax),
      now: options.now ?? (() => Date.now()),
    };
    this.state = {
      state: "closed",
      failureCount: 0,
      openedAt: null,
      halfOpenInFlight: 0,
    };
  }

  /** Returns the current state of the breaker without mutating it. */
  getState(): CircuitBreakerState {
    this.refresh();
    return this.state.state;
  }

  /**
   * Attempts to reserve the breaker for a new operation. When the breaker is
   * open the rejection contains the timestamp at which a retry may occur.
   */
  tryAcquire(): CircuitBreakerAttempt {
    this.refresh();

    if (this.state.state === "open") {
      return {
        allowed: false,
        state: "open",
        retryAt: this.state.openedAt !== null ? this.state.openedAt + this.options.cooldownMs : null,
      };
    }

    if (this.state.state === "half-open") {
      if (this.state.halfOpenInFlight >= this.options.halfOpenMaxInFlight) {
        return { allowed: false, state: "half-open", retryAt: null };
      }
      this.state.halfOpenInFlight += 1;
    }

    return {
      allowed: true,
      state: this.state.state,
      succeed: () => {
        if (this.state.state === "half-open") {
          this.state.halfOpenInFlight = Math.max(0, this.state.halfOpenInFlight - 1);
          if (this.state.halfOpenInFlight === 0) {
            this.close();
          }
        } else {
          this.resetFailures();
        }
      },
      fail: () => {
        if (this.state.state === "half-open") {
          this.state.halfOpenInFlight = Math.max(0, this.state.halfOpenInFlight - 1);
          this.trip(this.now());
          return;
        }
        this.state.failureCount += 1;
        if (this.state.failureCount >= this.options.failThreshold) {
          this.trip(this.now());
        }
      },
    };
  }

  /** Registers an explicit failure, useful when downstream code detects crashes. */
  recordFailure(at: number = this.now()): void {
    this.refresh(at);
    if (this.state.state === "half-open") {
      this.trip(at);
      return;
    }
    this.state.failureCount += 1;
    if (this.state.failureCount >= this.options.failThreshold) {
      this.trip(at);
    }
  }

  /** Resets the breaker to the closed state. */
  recordSuccess(): void {
    this.close();
  }

  /** Timestamp at which the breaker may allow new work or `null` if unknown. */
  nextRetryAt(): number | null {
    if (this.state.state !== "open") {
      return null;
    }
    return this.state.openedAt !== null ? this.state.openedAt + this.options.cooldownMs : null;
  }

  private refresh(at: number = this.now()): void {
    if (this.state.state !== "open") {
      return;
    }
    if (this.state.openedAt === null) {
      return;
    }
    if (at - this.state.openedAt >= this.options.cooldownMs) {
      this.state.state = "half-open";
      this.state.halfOpenInFlight = 0;
    }
  }

  private trip(at: number): void {
    this.state.state = "open";
    this.state.openedAt = at;
    this.state.failureCount = 0;
    this.state.halfOpenInFlight = 0;
  }

  private close(): void {
    this.state.state = "closed";
    this.state.failureCount = 0;
    this.state.openedAt = null;
    this.state.halfOpenInFlight = 0;
  }

  private resetFailures(): void {
    this.state.failureCount = 0;
  }

  private now(): number {
    return this.options.now();
  }
}
