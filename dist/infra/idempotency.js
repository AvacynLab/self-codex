import { createHash } from "node:crypto";
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
    entries = new Map();
    pending = new Map();
    clock;
    defaultTtlMs;
    constructor(options = {}) {
        this.clock = options.clock ?? (() => Date.now());
        const ttl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
        this.defaultTtlMs = ttl > 0 ? ttl : DEFAULT_TTL_MS;
    }
    /** Number of live entries currently tracked. */
    size() {
        return this.entries.size;
    }
    /** Remove every entry from the registry. Mainly used by tests. */
    clear() {
        this.entries.clear();
        this.pending.clear();
    }
    /** Retrieve an entry without updating the hit counter (used for diagnostics). */
    peek(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (this.isExpired(entry, this.clock())) {
            this.entries.delete(key);
            return null;
        }
        return { ...entry, value: this.clone(entry.value) };
    }
    /**
     * Remember the outcome of an asynchronous operation. The factory is invoked
     * at most once per key; concurrent callers await the same promise and replay
     * the stored value once resolved.
     */
    async remember(key, factory, options = {}) {
        const now = this.clock();
        const existing = this.entries.get(key);
        if (existing && !this.isExpired(existing, now)) {
            existing.hits += 1;
            existing.lastHitAt = now;
            return {
                value: this.clone(existing.value),
                idempotent: true,
                entry: { ...existing, value: this.clone(existing.value) },
            };
        }
        let pending = this.pending.get(key);
        if (!pending) {
            pending = this.executeFactory(key, factory, options.ttlMs);
            this.pending.set(key, pending);
        }
        try {
            const stored = await pending;
            const value = this.clone(stored.value);
            return {
                value,
                idempotent: existing !== undefined && !this.isExpired(existing, now),
                entry: { ...stored, value: this.clone(stored.value) },
            };
        }
        finally {
            this.pending.delete(key);
        }
    }
    /**
     * Synchronous variant used by helpers that must remain synchronous (e.g.
     * `tx_begin`). The factory is executed immediately when the key is unknown.
     */
    rememberSync(key, factory, options = {}) {
        const now = this.clock();
        const existing = this.entries.get(key);
        if (existing && !this.isExpired(existing, now)) {
            existing.hits += 1;
            existing.lastHitAt = now;
            return {
                value: this.clone(existing.value),
                idempotent: true,
                entry: { ...existing, value: this.clone(existing.value) },
            };
        }
        const produced = factory();
        const stored = this.storeInternal(key, produced, options.ttlMs);
        return {
            value: this.clone(stored.value),
            idempotent: false,
            entry: { ...stored, value: this.clone(stored.value) },
        };
    }
    /** Manually remove expired entries. Called periodically by the server. */
    pruneExpired(now = this.clock()) {
        for (const [key, entry] of this.entries) {
            if (this.isExpired(entry, now)) {
                this.entries.delete(key);
            }
        }
    }
    /** Persist a value without running a factory (used for fixtures/tests). */
    store(key, value, options = {}) {
        const stored = this.storeInternal(key, value, options.ttlMs);
        return { ...stored, value: this.clone(stored.value) };
    }
    async executeFactory(key, factory, ttlOverride) {
        const value = await factory();
        return this.storeInternal(key, value, ttlOverride);
    }
    storeInternal(key, value, ttlOverride) {
        const now = this.clock();
        const ttlMs = this.normaliseTtl(ttlOverride);
        const entry = {
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
    normaliseTtl(ttlMs) {
        if (ttlMs === undefined || ttlMs === null || Number.isNaN(ttlMs)) {
            return this.defaultTtlMs;
        }
        if (!Number.isFinite(ttlMs)) {
            return this.defaultTtlMs;
        }
        return Math.max(MIN_TTL_MS, ttlMs);
    }
    isExpired(entry, now) {
        return now >= entry.expiresAt;
    }
    clone(value) {
        try {
            return structuredClone(value);
        }
        catch {
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
export function buildIdempotencyCacheKey(method, idempotencyKey, params) {
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
function hashParams(params) {
    const canonical = canonicalise(params, new WeakSet());
    const json = JSON.stringify(canonical);
    return createHash(IDEMPOTENCY_HASH_ALGORITHM).update(json).digest("hex");
}
/**
 * Recursively sorts object keys and normalises primitive wrappers to ensure the
 * generated fingerprint remains stable for semantically identical payloads.
 */
function canonicalise(value, seen) {
    if (value === null || typeof value !== "object") {
        if (value instanceof Date) {
            return value.toISOString();
        }
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((entry) => canonicalise(entry, seen));
        }
        const record = value;
        const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
        const normalised = {};
        for (const key of sortedKeys) {
            const entry = record[key];
            if (entry === undefined) {
                continue;
            }
            normalised[key] = canonicalise(entry, seen);
        }
        return normalised;
    }
    finally {
        seen.delete(value);
    }
}
//# sourceMappingURL=idempotency.js.map