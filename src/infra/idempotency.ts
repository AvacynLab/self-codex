/**
 * Lightweight in-memory registry storing the outcome of idempotent operations.
 *
 * The store keeps a TTL per key so retried requests can replay the exact same
 * payload without re-executing the underlying side effects. Every entry records
 * hit counters and timestamps which tests rely on to guarantee deterministic
 * behaviour when fake timers are installed.
 */
export interface IdempotencyEntry<T> {
  /** User provided key correlating retries for the same operation. */
  readonly key: string;
  /** Value persisted for the first successful execution. */
  readonly value: T;
  /** Monotonic timestamp recorded when the value was stored. */
  readonly storedAt: number;
  /** Timestamp after which the entry is considered expired. */
  readonly expiresAt: number;
  /** Number of times callers observed a replay (first call counts as 1). */
  readonly hits: number;
  /** Timestamp of the latest replay (mirrors {@link storedAt} for first call). */
  readonly lastHitAt: number;
}

/** Options accepted when instantiating the registry. */
export interface IdempotencyRegistryOptions {
  /** Default TTL (milliseconds) applied when callers do not override it. */
  defaultTtlMs?: number;
  /** Optional clock used for testing (defaults to {@link Date.now}). */
  clock?: () => number;
}

/** Result returned when looking up a key inside the registry. */
export interface IdempotencyHit<T> {
  /** Stored value, cloned defensively from the registry. */
  value: T;
  /** Indicates whether the result was replayed (`true`) or freshly stored. */
  idempotent: boolean;
  /** Metadata describing the snapshot kept in memory. */
  entry: IdempotencyEntry<T>;
}

/** Internal representation retained in memory (mutable to update hit counters). */
interface MutableIdempotencyEntry<T> extends IdempotencyEntry<T> {
  hits: number;
  lastHitAt: number;
}

/** Function returning a promise or synchronous value. */
type MaybeAsyncFactory<T> = () => T | Promise<T>;

/** Clamp used to avoid storing negative TTLs when callers provide invalid data. */
const MIN_TTL_MS = 1;
/** Default TTL (~10 minutes) offering a generous window for retries. */
const DEFAULT_TTL_MS = 600_000;

/**
 * In-memory registry storing idempotent outcomes. The implementation favours a
 * predictable behaviour over absolute performance as the orchestrator only
 * keeps a few dozen entries at a time (tools and server enforce timeouts).
 */
export class IdempotencyRegistry {
  private readonly entries = new Map<string, MutableIdempotencyEntry<unknown>>();
  private readonly pending = new Map<string, Promise<MutableIdempotencyEntry<unknown>>>();
  private readonly clock: () => number;
  private readonly defaultTtlMs: number;

  constructor(options: IdempotencyRegistryOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    const ttl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.defaultTtlMs = ttl > 0 ? ttl : DEFAULT_TTL_MS;
  }

  /** Number of live entries currently tracked. */
  public size(): number {
    return this.entries.size;
  }

  /** Remove every entry from the registry. Mainly used by tests. */
  public clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  /** Retrieve an entry without updating the hit counter (used for diagnostics). */
  public peek<T>(key: string): IdempotencyEntry<T> | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.isExpired(entry, this.clock())) {
      this.entries.delete(key);
      return null;
    }
    return { ...entry, value: this.clone(entry.value as T) };
  }

  /**
   * Remember the outcome of an asynchronous operation. The factory is invoked
   * at most once per key; concurrent callers await the same promise and replay
   * the stored value once resolved.
   */
  public async remember<T>(
    key: string,
    factory: MaybeAsyncFactory<T>,
    options: { ttlMs?: number } = {},
  ): Promise<IdempotencyHit<T>> {
    const now = this.clock();
    const existing = this.entries.get(key);
    if (existing && !this.isExpired(existing, now)) {
      existing.hits += 1;
      existing.lastHitAt = now;
      return {
        value: this.clone(existing.value as T),
        idempotent: true,
        entry: { ...existing, value: this.clone(existing.value as T) } as IdempotencyEntry<T>,
      };
    }

    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.executeFactory(key, factory, options.ttlMs);
      this.pending.set(key, pending);
    }

    try {
      const stored = await pending;
      const value = this.clone(stored.value as T);
      return {
        value,
        idempotent: existing !== undefined && !this.isExpired(existing, now),
        entry: { ...stored, value: this.clone(stored.value as T) } as IdempotencyEntry<T>,
      };
    } finally {
      this.pending.delete(key);
    }
  }
  /**
   * Synchronous variant used by helpers that must remain synchronous (e.g.
   * `tx_begin`). The factory is executed immediately when the key is unknown.
   */
  public rememberSync<T>(key: string, factory: () => T, options: { ttlMs?: number } = {}): IdempotencyHit<T> {
    const now = this.clock();
    const existing = this.entries.get(key);
    if (existing && !this.isExpired(existing, now)) {
      existing.hits += 1;
      existing.lastHitAt = now;
      return {
        value: this.clone(existing.value as T),
        idempotent: true,
        entry: { ...existing, value: this.clone(existing.value as T) } as IdempotencyEntry<T>,
      };
    }

    const produced = factory();
    const stored = this.storeInternal(key, produced, options.ttlMs);
    return {
      value: this.clone(stored.value as T),
      idempotent: false,
      entry: { ...stored, value: this.clone(stored.value as T) } as IdempotencyEntry<T>,
    };
  }

  /** Manually remove expired entries. Called periodically by the server. */
  public pruneExpired(now: number = this.clock()): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
      }
    }
  }

  /** Persist a value without running a factory (used for fixtures/tests). */
  public store<T>(key: string, value: T, options: { ttlMs?: number } = {}): IdempotencyEntry<T> {
    const stored = this.storeInternal(key, value, options.ttlMs);
    return { ...stored, value: this.clone(stored.value as T) } as IdempotencyEntry<T>;
  }

  private async executeFactory<T>(
    key: string,
    factory: MaybeAsyncFactory<T>,
    ttlOverride?: number,
  ): Promise<MutableIdempotencyEntry<unknown>> {
    const value = await factory();
    return this.storeInternal(key, value, ttlOverride);
  }

  private storeInternal<T>(key: string, value: T, ttlOverride?: number): MutableIdempotencyEntry<unknown> {
    const now = this.clock();
    const ttlMs = this.normaliseTtl(ttlOverride);
    const entry: MutableIdempotencyEntry<unknown> = {
      key,
      value: this.clone(value),
      storedAt: now,
      expiresAt: now + ttlMs,
      hits: 1,
      lastHitAt: now,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private normaliseTtl(ttlMs?: number): number {
    if (ttlMs === undefined || ttlMs === null || Number.isNaN(ttlMs)) {
      return this.defaultTtlMs;
    }
    if (!Number.isFinite(ttlMs)) {
      return this.defaultTtlMs;
    }
    return Math.max(MIN_TTL_MS, ttlMs);
  }

  private isExpired(entry: IdempotencyEntry<unknown>, now: number): boolean {
    return now >= entry.expiresAt;
  }

  private clone<T>(value: T): T {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
}


