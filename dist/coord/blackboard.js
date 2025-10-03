import { EventEmitter } from "node:events";
/**
 * In-memory, fully deterministic key/value blackboard. Entries can be tagged,
 * expire after a configurable TTL and are observable through a bounded history
 * log that powers live watchers. The store purposely keeps mutations
 * synchronous so it can be exercised with manual clocks in tests.
 */
export class BlackboardStore {
    entries = new Map();
    events = [];
    emitter = new EventEmitter();
    now;
    historyLimit;
    version = 0;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.historyLimit = Math.max(1, options.historyLimit ?? 500);
    }
    /** Stores or updates an entry and returns the latest snapshot. */
    set(key, value, options = {}) {
        this.evictExpired();
        const timestamp = this.now();
        const tags = normaliseTags(options.tags ?? []);
        const ttl = options.ttlMs !== undefined ? Math.max(1, Math.floor(options.ttlMs)) : null;
        const expiresAt = ttl !== null ? timestamp + ttl : null;
        const existing = this.entries.get(key);
        const previous = existing ? this.cloneEntry(existing) : undefined;
        const version = ++this.version;
        const entry = {
            key,
            value: structuredClone(value),
            tags,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
            expiresAt,
            version,
        };
        this.entries.set(key, entry);
        const snapshot = this.cloneEntry(entry);
        this.recordEvent({
            version,
            kind: "set",
            key,
            timestamp,
            entry: snapshot,
            previous,
        });
        return snapshot;
    }
    /**
     * Applies multiple mutations atomically. Either every entry is committed and
     * a matching history event is emitted, or the store is reverted to its prior
     * state. The helper is primarily used by the MCP bulk tool so clients can
     * refresh several keys in a single round-trip without risking partial
     * updates.
     */
    batchSet(entries) {
        this.evictExpired();
        if (entries.length === 0) {
            return [];
        }
        const originalEntries = new Map();
        for (const [key, entry] of this.entries.entries()) {
            originalEntries.set(key, this.cloneInternal(entry));
        }
        const startingVersion = this.version;
        const committedSnapshots = [];
        const eventsToEmit = [];
        let nextVersion = startingVersion;
        try {
            for (const payload of entries) {
                const timestamp = this.now();
                const tags = normaliseTags(payload.tags ?? []);
                const ttl = payload.ttlMs !== undefined ? Math.max(1, Math.floor(payload.ttlMs)) : null;
                const expiresAt = ttl !== null ? timestamp + ttl : null;
                const previousInternal = this.entries.get(payload.key);
                const previousSnapshot = previousInternal ? this.cloneEntry(previousInternal) : undefined;
                const createdAt = previousInternal?.createdAt ?? timestamp;
                const entry = {
                    key: payload.key,
                    value: structuredClone(payload.value),
                    tags,
                    createdAt,
                    updatedAt: timestamp,
                    expiresAt,
                    version: 0,
                };
                nextVersion += 1;
                entry.version = nextVersion;
                this.entries.set(payload.key, this.cloneInternal(entry));
                const snapshot = this.cloneEntry(entry);
                committedSnapshots.push(snapshot);
                eventsToEmit.push({
                    version: nextVersion,
                    kind: "set",
                    key: payload.key,
                    timestamp,
                    entry: snapshot,
                    previous: previousSnapshot,
                });
            }
        }
        catch (error) {
            this.entries.clear();
            for (const [key, entry] of originalEntries.entries()) {
                this.entries.set(key, entry);
            }
            this.version = startingVersion;
            throw error;
        }
        this.version = nextVersion;
        for (const event of eventsToEmit) {
            this.recordEvent(event);
        }
        return committedSnapshots;
    }
    /** Retrieves an entry if it exists and has not expired yet. */
    get(key) {
        this.evictExpired();
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        return this.cloneEntry(entry);
    }
    /**
     * Deletes an entry when present. The previous snapshot is emitted so
     * consumers can reconcile derived state. Returns true when a deletion
     * occurred.
     */
    delete(key) {
        this.evictExpired();
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }
        const timestamp = this.now();
        const previous = this.cloneEntry(entry);
        this.entries.delete(key);
        const version = ++this.version;
        this.recordEvent({
            version,
            kind: "delete",
            key,
            timestamp,
            previous,
        });
        return true;
    }
    /** Returns non-expired entries filtered by keys and/or tags. */
    query(options = {}) {
        this.evictExpired();
        const keysFilter = options.keys ? new Set(options.keys) : null;
        const tagsFilter = options.tags ? new Set(options.tags.map((tag) => tag.toLowerCase())) : null;
        const snapshots = [];
        for (const entry of this.entries.values()) {
            if (keysFilter && !keysFilter.has(entry.key)) {
                continue;
            }
            if (tagsFilter && !containsAllTags(entry.tags, tagsFilter)) {
                continue;
            }
            snapshots.push(this.cloneEntry(entry));
        }
        return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /**
     * Removes expired entries, emitting an `expire` event for each key that
     * reaches its TTL. The emitted events are also returned to help with
     * diagnostics.
     */
    evictExpired() {
        const timestamp = this.now();
        const expired = [];
        for (const [key, entry] of [...this.entries.entries()]) {
            if (entry.expiresAt !== null && entry.expiresAt <= timestamp) {
                const previous = this.cloneEntry(entry);
                this.entries.delete(key);
                const version = ++this.version;
                const event = {
                    version,
                    kind: "expire",
                    key,
                    timestamp,
                    previous,
                    reason: "ttl",
                };
                this.recordEvent(event);
                expired.push(this.cloneEvent(event));
            }
        }
        return expired;
    }
    /** Highest version observed so far. */
    getCurrentVersion() {
        return this.version;
    }
    /** Returns history events with a version strictly greater than the input. */
    getEventsSince(fromVersion, options = {}) {
        this.evictExpired();
        const limit = options.limit ?? Number.POSITIVE_INFINITY;
        const filtered = this.events.filter((event) => event.version > fromVersion);
        const sliced = filtered.slice(0, Math.max(0, limit));
        return sliced.map((event) => this.cloneEvent(event));
    }
    /**
     * Registers a listener that receives backlog events and live updates. The
     * returned function detaches the listener.
     */
    watch(options) {
        const fromVersion = options.fromVersion ?? 0;
        let lastDelivered = fromVersion;
        const backlog = this.getEventsSince(fromVersion);
        for (const event of backlog) {
            options.listener(this.cloneEvent(event));
            lastDelivered = Math.max(lastDelivered, event.version);
        }
        const handler = (event) => {
            if (event.version <= lastDelivered) {
                return;
            }
            lastDelivered = event.version;
            options.listener(this.cloneEvent(event));
        };
        this.emitter.on("event", handler);
        return () => {
            this.emitter.off("event", handler);
        };
    }
    /** Clears the internal event log. Intended for tests only. */
    clearHistory() {
        this.events.length = 0;
    }
    recordEvent(event) {
        this.events.push(this.cloneEvent(event));
        if (this.events.length > this.historyLimit) {
            this.events.splice(0, this.events.length - this.historyLimit);
        }
        this.emitter.emit("event", this.cloneEvent(event));
    }
    cloneInternal(entry) {
        return {
            key: entry.key,
            value: structuredClone(entry.value),
            tags: [...entry.tags],
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            expiresAt: entry.expiresAt,
            version: entry.version,
        };
    }
    cloneEntry(entry) {
        return {
            key: entry.key,
            value: structuredClone(entry.value),
            tags: [...entry.tags],
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            expiresAt: entry.expiresAt,
            version: entry.version,
        };
    }
    cloneEvent(event) {
        return {
            version: event.version,
            kind: event.kind,
            key: event.key,
            timestamp: event.timestamp,
            reason: event.reason,
            entry: event.entry ? { ...event.entry, value: structuredClone(event.entry.value) } : undefined,
            previous: event.previous
                ? { ...event.previous, value: structuredClone(event.previous.value) }
                : undefined,
        };
    }
}
function normaliseTags(tags) {
    const unique = new Set();
    for (const raw of tags) {
        const tag = raw.trim();
        if (!tag)
            continue;
        unique.add(tag.toLowerCase());
    }
    return [...unique].sort();
}
function containsAllTags(entryTags, required) {
    if (required.size === 0) {
        return true;
    }
    const haystack = new Set(entryTags.map((tag) => tag.toLowerCase()));
    for (const tag of required) {
        if (!haystack.has(tag)) {
            return false;
        }
    }
    return true;
}
