import { EventEmitter } from "node:events";

/** Options accepted by {@link BlackboardStore}. */
export interface BlackboardStoreOptions {
  /** Clock used for TTL computations. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Maximum number of events retained in history for watchers. */
  historyLimit?: number;
}

/** Additional parameters supported when storing an entry. */
export interface BlackboardSetOptions {
  /** Optional set of tags used to group entries semantically. */
  tags?: string[];
  /** Time-to-live in milliseconds. When omitted the entry never expires. */
  ttlMs?: number;
}

/**
 * Payload accepted by {@link BlackboardStore.batchSet}. Each entry mirrors the
 * arguments of {@link BlackboardStore.set} but allows the caller to describe
 * multiple mutations that should be applied atomically.
 */
export interface BlackboardBatchSetInput {
  key: string;
  value: unknown;
  tags?: string[];
  ttlMs?: number;
}

/** Filtering options consumed by {@link BlackboardStore.query}. */
export interface BlackboardQueryOptions {
  /** Restrict the result set to the provided keys. */
  keys?: string[];
  /** Require all provided tags to be present on the entry. */
  tags?: string[];
}

/** Kinds of events emitted by the blackboard when its content changes. */
export type BlackboardEventKind = "set" | "delete" | "expire";

/** Snapshot exposed to callers describing a stored key/value entry. */
export interface BlackboardEntrySnapshot {
  key: string;
  value: unknown;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  version: number;
}

/** Event pushed to the history log and delivered to live watchers. */
export interface BlackboardEvent {
  version: number;
  kind: BlackboardEventKind;
  key: string;
  timestamp: number;
  entry?: BlackboardEntrySnapshot;
  previous?: BlackboardEntrySnapshot;
  reason?: "ttl";
}

/** Options required to start a live watch on the blackboard. */
export interface BlackboardWatchOptions {
  /** Version after which events must be delivered (exclusive). */
  fromVersion?: number;
  /** Callback invoked for every event greater than {@link fromVersion}. */
  listener: (event: BlackboardEvent) => void;
}

interface BlackboardEntryInternal {
  key: string;
  value: unknown;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  version: number;
}

/**
 * In-memory, fully deterministic key/value blackboard. Entries can be tagged,
 * expire after a configurable TTL and are observable through a bounded history
 * log that powers live watchers. The store purposely keeps mutations
 * synchronous so it can be exercised with manual clocks in tests.
 */
export class BlackboardStore {
  private readonly entries = new Map<string, BlackboardEntryInternal>();
  private readonly events: BlackboardEvent[] = [];
  private readonly emitter = new EventEmitter();
  private readonly now: () => number;
  private readonly historyLimit: number;
  private version = 0;

  constructor(options: BlackboardStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = Math.max(1, options.historyLimit ?? 500);
  }

  /** Stores or updates an entry and returns the latest snapshot. */
  set(key: string, value: unknown, options: BlackboardSetOptions = {}): BlackboardEntrySnapshot {
    this.evictExpired();
    const timestamp = this.now();
    const tags = normaliseTags(options.tags ?? []);
    const ttl = options.ttlMs !== undefined ? Math.max(1, Math.floor(options.ttlMs)) : null;
    const expiresAt = ttl !== null ? timestamp + ttl : null;
    const existing = this.entries.get(key);
    const previous = existing ? this.cloneEntry(existing) : undefined;
    const version = ++this.version;
    const entry: BlackboardEntryInternal = {
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
  batchSet(entries: ReadonlyArray<BlackboardBatchSetInput>): BlackboardEntrySnapshot[] {
    this.evictExpired();
    if (entries.length === 0) {
      return [];
    }

    const originalEntries = new Map<string, BlackboardEntryInternal>();
    for (const [key, entry] of this.entries.entries()) {
      originalEntries.set(key, this.cloneInternal(entry));
    }
    const startingVersion = this.version;
    const committedSnapshots: BlackboardEntrySnapshot[] = [];
    const eventsToEmit: BlackboardEvent[] = [];
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
        const entry: BlackboardEntryInternal = {
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
    } catch (error) {
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
  get(key: string): BlackboardEntrySnapshot | undefined {
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
  delete(key: string): boolean {
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
  query(options: BlackboardQueryOptions = {}): BlackboardEntrySnapshot[] {
    this.evictExpired();
    const keysFilter = options.keys ? new Set(options.keys) : null;
    const tagsFilter = options.tags ? new Set(options.tags.map((tag) => tag.toLowerCase())) : null;
    const snapshots: BlackboardEntrySnapshot[] = [];
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
  evictExpired(): BlackboardEvent[] {
    const timestamp = this.now();
    const expired: BlackboardEvent[] = [];
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.expiresAt !== null && entry.expiresAt <= timestamp) {
        const previous = this.cloneEntry(entry);
        this.entries.delete(key);
        const version = ++this.version;
        const event: BlackboardEvent = {
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
  getCurrentVersion(): number {
    return this.version;
  }

  /** Returns history events with a version strictly greater than the input. */
  getEventsSince(fromVersion: number, options: { limit?: number } = {}): BlackboardEvent[] {
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
  watch(options: BlackboardWatchOptions): () => void {
    const fromVersion = options.fromVersion ?? 0;
    let lastDelivered = fromVersion;
    const backlog = this.getEventsSince(fromVersion);
    for (const event of backlog) {
      options.listener(this.cloneEvent(event));
      lastDelivered = Math.max(lastDelivered, event.version);
    }
    const handler = (event: BlackboardEvent) => {
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
  clearHistory(): void {
    this.events.length = 0;
  }

  private recordEvent(event: BlackboardEvent): void {
    this.events.push(this.cloneEvent(event));
    if (this.events.length > this.historyLimit) {
      this.events.splice(0, this.events.length - this.historyLimit);
    }
    this.emitter.emit("event", this.cloneEvent(event));
  }

  private cloneInternal(entry: BlackboardEntryInternal): BlackboardEntryInternal {
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

  private cloneEntry(entry: BlackboardEntryInternal): BlackboardEntrySnapshot {
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

  private cloneEvent(event: BlackboardEvent): BlackboardEvent {
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

function normaliseTags(tags: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    unique.add(tag.toLowerCase());
  }
  return [...unique].sort();
}

function containsAllTags(entryTags: string[], required: Set<string>): boolean {
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
