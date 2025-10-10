import { createHash } from "crypto";

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
/** Hash algorithm used to fingerprint request parameters. */
const IDEMPOTENCY_HASH_ALGORITHM = "sha256";

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

/**
 * Builds a deterministic cache key combining the user provided idempotency key,
 * the targeted method, and a stable hash of the request parameters. The
 * resulting token guards against callers accidentally reusing the same
 * idempotency key with different payloads while remaining agnostic of property
 * ordering in JSON bodies.
 */
export function buildIdempotencyCacheKey(method: string, idempotencyKey: string, params: unknown): string {
  const safeMethod = typeof method === "string" && method.trim().length > 0 ? method.trim().toLowerCase() : "unknown";
  const safeKey = typeof idempotencyKey === "string" ? idempotencyKey : String(idempotencyKey);
  const fingerprint = hashParams(params);
  return `${safeMethod}:${safeKey}:${fingerprint}`;
}

/**
 * Serialises parameters with stable ordering before hashing so logically
 * equivalent payloads generate the same digest even when property ordering
 * differs between retries.
 */
function hashParams(params: unknown): string {
  const canonical = canonicalise(params, new WeakSet());
  const json = JSON.stringify(canonical);
  return createHash(IDEMPOTENCY_HASH_ALGORITHM).update(json).digest("hex");
}

/**
 * Recursively sorts object keys and normalises primitive wrappers to ensure the
 * generated fingerprint remains stable for semantically identical payloads.
 */
function canonicalise(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalise(entry, seen));
    }

    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const normalised: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const entry = record[key];
      if (entry === undefined) {
        continue;
      }
      normalised[key] = canonicalise(entry, seen);
    }
    return normalised;
  } finally {
    seen.delete(value as object);
  }
}


