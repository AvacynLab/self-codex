/**
 * Circuit breaker primitives guarding downstream dependencies. The helper keeps
 * track of failure streaks and exposes a deterministic state machine matching
 * the expectations of the child supervisor and HTTP transports.
 */
export type CircuitBreakerState = "closed" | "open" | "half-open";

/** Snapshot describing the breaker internals for diagnostics and tests. */
export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  retryAt: number | null;
  halfOpenInFlight: number;
  halfOpenSuccesses: number;
}

/** Ticket returned by {@link CircuitBreaker.tryAcquire}. */
export interface CircuitBreakerAttempt {
  allowed: boolean;
  state: CircuitBreakerState;
  retryAt: number | null;
  succeed(): void;
  fail(): void;
}

/**
 * Configuration accepted by both {@link CircuitBreaker} and the registry.
 */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures required before the breaker opens. */
  failThreshold: number;
  /** Cooldown window (in milliseconds) enforced once the breaker opens. */
  cooldownMs: number;
  /** Maximum number of concurrent attempts permitted while half-open. */
  halfOpenMaxInFlight?: number;
  /** Number of successful half-open probes required to fully close the breaker. */
  halfOpenSuccesses?: number;
  /** Optional clock override used by tests. */
  now?: () => number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
}

function cloneSnapshot(state: CircuitBreakerSnapshot): CircuitBreakerSnapshot {
  return { ...state };
}

/**
 * Standalone circuit breaker implementing the classic closed → open →
 * half-open state machine. Instances are intentionally self-contained so they
 * can be embedded inside supervisors or exposed through a registry.
 */
export class CircuitBreaker {
  private readonly failThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxInFlight: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly now: () => number;

  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private retryAt: number | null = null;
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;

  constructor(options: CircuitBreakerOptions) {
    assertPositiveInteger(options.failThreshold, "failThreshold");
    assertNonNegative(options.cooldownMs, "cooldownMs");
    const maxInFlight = options.halfOpenMaxInFlight ?? 1;
    assertPositiveInteger(maxInFlight, "halfOpenMaxInFlight");
    const halfOpenSuccesses = options.halfOpenSuccesses ?? 1;
    assertPositiveInteger(halfOpenSuccesses, "halfOpenSuccesses");

    this.failThreshold = Math.trunc(options.failThreshold);
    this.cooldownMs = Math.trunc(options.cooldownMs);
    this.halfOpenMaxInFlight = Math.trunc(maxInFlight);
    this.halfOpenSuccessThreshold = Math.trunc(halfOpenSuccesses);
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the current breaker state. */
  public getState(): CircuitBreakerState {
    return this.state;
  }

  /** Returns the next retry timestamp when the breaker is open. */
  public nextRetryAt(): number | null {
    return this.retryAt;
  }

  /** Emits a snapshot suitable for logs or test assertions. */
  public snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
      halfOpenInFlight: this.halfOpenInFlight,
      halfOpenSuccesses: this.halfOpenSuccesses,
    };
  }

  /**
   * Attempts to reserve a slot. Callers must invoke either `succeed()` or
   * `fail()` on the returned ticket when the execution completes.
   */
  public tryAcquire(now: number = this.now()): CircuitBreakerAttempt {
    this.refreshState(now);

    if (this.state === "open") {
      return {
        allowed: false,
        state: "open",
        retryAt: this.retryAt,
        succeed: () => {},
        fail: () => {},
      };
    }

    if (this.state === "half-open" && this.halfOpenInFlight >= this.halfOpenMaxInFlight) {
      return {
        allowed: false,
        state: "half-open",
        retryAt: this.retryAt,
        succeed: () => {},
        fail: () => {},
      };
    }

    if (this.state === "half-open") {
      this.halfOpenInFlight += 1;
    }

    const initialState = this.state;
    return {
      allowed: true,
      state: initialState,
      retryAt: this.retryAt,
      succeed: () => this.completeAttempt(initialState, "success"),
      fail: () => this.completeAttempt(initialState, "failure"),
    };
  }

  /** Records a successful execution, closing the breaker when appropriate. */
  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.halfOpenSuccesses += 1;
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionToClosed();
      }
      return;
    }

    this.transitionToClosed();
  }

  /** Records a failed execution, potentially opening the breaker. */
  public recordFailure(at: number = this.now()): void {
    if (this.state === "half-open") {
      this.open(at);
      return;
    }

    if (this.state === "open") {
      this.retryAt = Math.max(this.retryAt ?? at + this.cooldownMs, at + this.cooldownMs);
      this.openedAt = this.openedAt ?? at;
      this.consecutiveFailures = this.failThreshold;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failThreshold) {
      this.open(at);
    }
  }

  private completeAttempt(origin: CircuitBreakerState, outcome: "success" | "failure"): void {
    if (origin === "half-open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
    if (outcome === "success") {
      this.recordSuccess();
    } else {
      this.recordFailure();
    }
  }

  private refreshState(now: number): void {
    if (this.state === "open" && this.retryAt !== null && now >= this.retryAt) {
      this.state = "half-open";
      this.halfOpenInFlight = 0;
      this.halfOpenSuccesses = 0;
      this.retryAt = null;
    }
  }

  private transitionToClosed(): void {
    this.state = "closed";
    this.openedAt = null;
    this.retryAt = null;
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
  }

  private open(at: number): void {
    this.state = "open";
    this.openedAt = at;
    this.retryAt = at + this.cooldownMs;
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
    this.consecutiveFailures = this.failThreshold;
  }
}

/**
 * Registry storing breakers per logical key (typically JSON-RPC routes). Each
 * key reuses the same configuration ensuring consistent behaviour across
 * consumers.
 */
export class CircuitBreakerRegistry {
  private readonly options: CircuitBreakerOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(options: CircuitBreakerOptions) {
    this.options = options;
  }

  /** Drops the cached breaker for the provided key. */
  public reset(key: string): void {
    this.breakers.delete(key);
  }

  /** Returns the breaker snapshot for diagnostics. */
  public snapshot(key: string): CircuitBreakerSnapshot {
    return cloneSnapshot(this.getBreaker(key).snapshot());
  }

  /** Attempts to reserve a slot for the given key. */
  public tryAcquire(key: string, now?: number): CircuitBreakerAttempt {
    return this.getBreaker(key).tryAcquire(now);
  }

  /** Forwards success notifications to the underlying breaker. */
  public recordSuccess(key: string): void {
    this.getBreaker(key).recordSuccess();
  }

  /** Forwards failure notifications to the underlying breaker. */
  public recordFailure(key: string, at?: number): void {
    this.getBreaker(key).recordFailure(at);
  }

  private getBreaker(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}

/**
 * Convenience helper executing an asynchronous task guarded by a registry.
 */
export async function withCircuitBreaker<T>(
  registry: CircuitBreakerRegistry,
  key: string,
  invoke: () => Promise<T>,
): Promise<T> {
  const attempt = registry.tryAcquire(key);
  if (!attempt.allowed) {
    const error = new Error(`circuit breaker open for '${key}'`);
    (error as Error & { code?: string; retryAt?: number | null }).code = "E-CIRCUIT-OPEN";
    (error as Error & { code?: string; retryAt?: number | null }).retryAt = attempt.retryAt;
    throw error;
  }

  try {
    const result = await invoke();
    attempt.succeed();
    return result;
  } catch (error) {
    attempt.fail();
    throw error;
  }
}
