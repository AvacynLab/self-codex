import { inspect } from "util";

/**
 * Serialises arbitrary data into a deterministic JSON string so the cache keys
 * remain stable regardless of property insertion order. Arrays preserve their
 * order while objects are sorted lexicographically by key.
 */
function serialiseVariant(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialiseVariant(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${serialiseVariant(entryValue)}`);
  return `{${entries.join(",")}}`;
}

interface CacheEntry<T> {
  readonly key: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly value: T;
}

/** Runtime statistics exposed by the cache for observability/tests. */
export interface GraphComputationCacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * Small LRU cache used to memoise expensive graph computations (k-shortest
 * paths, centrality, …). Results are invalidated whenever the graph identifier
 * changes or its version is incremented by a mutation.
 */
export class GraphComputationCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly capacity = 128) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`GraphComputationCache capacity must be a positive integer (received ${inspect(capacity)})`);
    }
  }

  private composeKey(
    graphId: string,
    graphVersion: number,
    operation: string,
    variant: unknown,
  ): string {
    const prefix = `${graphId}::${graphVersion}::${operation}`;
    const suffix = serialiseVariant(variant);
    return `${prefix}::${suffix}`;
  }

  /** Retrieves an entry from the cache if it matches the current graph version. */
  get<T>(graphId: string, graphVersion: number, operation: string, variant: unknown): T | undefined {
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
    return entry.value as T;
  }

  /** Stores a new computation result and evicts the least recently used entry if needed. */
  set<T>(graphId: string, graphVersion: number, operation: string, variant: unknown, value: T): void {
    const key = this.composeKey(graphId, graphVersion, operation, variant);
    this.entries.delete(key);
    this.entries.set(key, { key, graphId, graphVersion, value });
    if (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
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
  invalidateGraph(graphId: string): void {
    for (const key of Array.from(this.entries.keys())) {
      const entry = this.entries.get(key);
      if (entry && entry.graphId === graphId) {
        this.entries.delete(key);
      }
    }
  }

  /** Clears every cached result. */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /** Exposes internal counters for diagnostics and assertions in tests. */
  stats(): GraphComputationCacheStats {
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
