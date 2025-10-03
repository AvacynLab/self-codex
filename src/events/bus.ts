import { EventEmitter } from "node:events";

/**
 * Severity levels supported by the unified event bus. The values align with the
 * structured logger levels so operators can correlate entries across sinks.
 */
export type EventLevel = "debug" | "info" | "warn" | "error";

/**
 * Payload emitted for every event published on the bus. Optional correlation
 * identifiers remain nullable because older orchestration paths may not yet
 * forward `runId`/`opId` until the migration is complete.
 */
export interface EventEnvelope {
  /** Monotonic sequence number assigned by the bus. */
  seq: number;
  /** Millisecond timestamp recorded at publication time. */
  ts: number;
  /** High level category ("plan", "child", ...). */
  cat: string;
  /** Severity level attached to the event. */
  level: EventLevel;
  /** Optional job identifier retained for backward compatibility with legacy tooling. */
  jobId?: string | null;
  /** Optional run identifier correlated to plan lifecycle operations. */
  runId?: string | null;
  /** Optional operation identifier when the event belongs to a sub-task. */
  opId?: string | null;
  /** Optional graph identifier when a mutation triggered the event. */
  graphId?: string | null;
  /** Optional node identifier (Behaviour Tree node, graph node, ...). */
  nodeId?: string | null;
  /** Optional child runtime identifier. */
  childId?: string | null;
  /** Short human readable message summarising the event. */
  msg: string;
  /** Structured payload with additional contextual data. */
  data?: unknown;
}

/**
 * Input accepted by {@link EventBus.publish}. Sequence numbers and timestamps
 * are populated automatically when missing so tests can stay deterministic by
 * injecting custom clock functions.
 */
export interface EventInput {
  cat: string;
  level?: EventLevel;
  jobId?: string | null;
  runId?: string | null;
  opId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  childId?: string | null;
  msg: string;
  data?: unknown;
  ts?: number;
}

/** Filters supported when listing or subscribing to events. */
export interface EventFilter {
  cats?: string[];
  levels?: EventLevel[];
  jobId?: string;
  runId?: string;
  opId?: string;
  graphId?: string;
  childId?: string;
  nodeId?: string;
  /** Exclusive lower bound applied on the sequence number. */
  afterSeq?: number;
  /** Maximum number of events returned (defaults to history limit). */
  limit?: number;
}

/** Options accepted when instantiating the event bus. */
export interface EventBusOptions {
  /** Maximum number of events kept in memory (defaults to 1000). */
  historyLimit?: number;
  /** Optional clock used to stamp events, mainly for deterministic tests. */
  now?: () => number;
}

/** Internal event emitted whenever the bus records a new envelope. */
const BUS_EVENT = "event";

/** Utility ensuring categories remain normalised for lookups. */
function normaliseCategory(cat: string): string {
  return cat.trim().toLowerCase();
}

/** Utility ensuring event messages are compact and predictable. */
function normaliseMessage(msg: string): string {
  const trimmed = msg.trim();
  return trimmed.length > 0 ? trimmed : "event";
}

/**
 * Async iterator used to expose live streams. The iterator buffers events until
 * a consumer reads them, mirroring the behaviour of a JSON Lines stream.
 */
class EventStream implements AsyncIterable<EventEnvelope>, AsyncIterator<EventEnvelope> {
  private readonly buffer: EventEnvelope[] = [];
  private resolve?: (result: IteratorResult<EventEnvelope>) => void;
  private closed = false;

  constructor(
    private readonly emitter: EventEmitter,
    private readonly matcher: (event: EventEnvelope) => boolean,
    seed: EventEnvelope[],
  ) {
    for (const event of seed) {
      if (this.matcher(event)) {
        this.buffer.push(event);
      }
    }
    this.emitter.on(BUS_EVENT, this.handleEvent);
  }

  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
    return this;
  }

  async next(): Promise<IteratorResult<EventEnvelope>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    if (this.closed) {
      return { value: undefined as unknown as EventEnvelope, done: true };
    }
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  async return(): Promise<IteratorResult<EventEnvelope>> {
    this.close();
    return { value: undefined as unknown as EventEnvelope, done: true };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emitter.removeListener(BUS_EVENT, this.handleEvent);
    if (this.resolve) {
      this.resolve({ value: undefined as unknown as EventEnvelope, done: true });
      this.resolve = undefined;
    }
  }

  private handleEvent = (event: EventEnvelope) => {
    if (this.closed || !this.matcher(event)) {
      return;
    }
    if (this.resolve) {
      this.resolve({ value: event, done: false });
      this.resolve = undefined;
      return;
    }
    this.buffer.push(event);
  };
}

/**
 * Unified event bus buffering orchestration events in memory. The bus offers
 * both random access (via {@link list}) and live streaming (via
 * {@link subscribe}) which keeps downstream MCP tools deterministic and easy
 * to test.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: EventEnvelope[] = [];
  private historyLimit: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(options: EventBusOptions = {}) {
    this.historyLimit = Math.max(1, options.historyLimit ?? 1_000);
    this.now = options.now ?? (() => Date.now());
  }

  /** Adjust the history limit at runtime and trim existing entries accordingly. */
  setHistoryLimit(limit: number): void {
    this.historyLimit = Math.max(1, limit);
    while (this.history.length > this.historyLimit) {
      this.history.shift();
    }
  }

  /** Determine whether an event matches the provided filters. */
  private matches(event: EventEnvelope, filter: EventFilter): boolean {
    const normalisedCats = filter.cats?.map(normaliseCategory);
    const normalisedLevels = filter.levels?.map((level) => level.toLowerCase() as EventLevel);

    if (normalisedCats && normalisedCats.length > 0 && !normalisedCats.includes(event.cat)) {
      return false;
    }
    if (normalisedLevels && normalisedLevels.length > 0 && !normalisedLevels.includes(event.level)) {
      return false;
    }
    if (filter.jobId && event.jobId !== filter.jobId) {
      return false;
    }
    if (filter.runId && event.runId !== filter.runId) {
      return false;
    }
    if (filter.opId && event.opId !== filter.opId) {
      return false;
    }
    if (filter.graphId && event.graphId !== filter.graphId) {
      return false;
    }
    if (filter.childId && event.childId !== filter.childId) {
      return false;
    }
    if (filter.nodeId && event.nodeId !== filter.nodeId) {
      return false;
    }
    if (typeof filter.afterSeq === "number" && !(event.seq > filter.afterSeq)) {
      return false;
    }
    return true;
  }

  /** Publish a new event on the bus. */
  publish(input: EventInput): EventEnvelope {
    const envelope: EventEnvelope = {
      seq: ++this.seq,
      ts: input.ts ?? this.now(),
      cat: normaliseCategory(input.cat),
      level: input.level ?? "info",
      jobId: input.jobId ?? null,
      runId: input.runId ?? null,
      opId: input.opId ?? null,
      graphId: input.graphId ?? null,
      nodeId: input.nodeId ?? null,
      childId: input.childId ?? null,
      msg: normaliseMessage(input.msg),
      data: input.data,
    };

    this.history.push(envelope);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }

    this.emitter.emit(BUS_EVENT, envelope);
    return envelope;
  }

  /**
   * Returns a snapshot of events matching the provided filters. The snapshot is
   * sorted chronologically and truncated to `limit` when specified.
   */
  list(filter: EventFilter = {}): EventEnvelope[] {
    const sliced = this.history.filter((event) => this.matches(event, filter));
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, this.historyLimit) : this.historyLimit;
    return sliced.slice(-limit);
  }

  /**
   * Creates an async iterator streaming live events. Consumers should call
   * {@link EventStream.close} once finished to avoid leaking listeners.
   */
  subscribe(filter: EventFilter = {}): EventStream {
    const matcher = (event: EventEnvelope): boolean => this.matches(event, filter);
    const seed = this.list(filter);
    return new EventStream(this.emitter, matcher, seed);
  }
}
