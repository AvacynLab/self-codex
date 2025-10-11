import { inspect } from "node:util";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/**
 * Serialises arbitrary data into a deterministic JSON string so the cache keys
 * remain stable regardless of property insertion order. Arrays preserve their
 * order while objects are sorted lexicographically by key.
 */
function serialiseVariant(value) {
    if (value === undefined) {
        return "undefined";
    }
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => serialiseVariant(entry)).join(",")}]`;
    }
    const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${serialiseVariant(entryValue)}`);
    return `{${entries.join(",")}}`;
}
/**
 * Small LRU cache used to memoise expensive graph computations (k-shortest
 * paths, centrality, …). Results are invalidated whenever the graph identifier
 * changes or its version is incremented by a mutation.
 */
export class GraphComputationCache {
    capacity;
    entries = new Map();
    hits = 0;
    misses = 0;
    evictions = 0;
    constructor(capacity = 128) {
        this.capacity = capacity;
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new Error(`GraphComputationCache capacity must be a positive integer (received ${inspect(capacity)})`);
        }
    }
    composeKey(graphId, graphVersion, operation, variant) {
        const prefix = `${graphId}::${graphVersion}::${operation}`;
        const suffix = serialiseVariant(variant);
        return `${prefix}::${suffix}`;
    }
    /** Retrieves an entry from the cache if it matches the current graph version. */
    get(graphId, graphVersion, operation, variant) {
        const key = this.composeKey(graphId, graphVersion, operation, variant);
        const entry = this.entries.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }
        if (entry.graphVersion !== graphVersion) {
            this.entries.delete(key);
            this.misses += 1;
            return undefined;
        }
        // Refresh the entry position to preserve the LRU ordering.
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.hits += 1;
        return entry.value;
    }
    /** Stores a new computation result and evicts the least recently used entry if needed. */
    set(graphId, graphVersion, operation, variant, value) {
        const key = this.composeKey(graphId, graphVersion, operation, variant);
        this.entries.delete(key);
        this.entries.set(key, { key, graphId, graphVersion, value });
        if (this.entries.size > this.capacity) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.evictions += 1;
            }
        }
    }
    /**
     * Removes every cached entry associated with the provided graph identifier.
     * Used when a mutation increments the graph version.
     */
    invalidateGraph(graphId) {
        for (const key of Array.from(this.entries.keys())) {
            const entry = this.entries.get(key);
            if (entry && entry.graphId === graphId) {
                this.entries.delete(key);
            }
        }
    }
    /** Clears every cached result. */
    clear() {
        this.entries.clear();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
    }
    /** Exposes internal counters for diagnostics and assertions in tests. */
    stats() {
        return {
            size: this.entries.size,
            capacity: this.capacity,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
        };
    }
}
export { serialiseVariant as serialiseCacheVariant };
//# sourceMappingURL=cache.js.map