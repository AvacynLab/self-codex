import { EventEmitter } from "node:events";
import { assertValidEventMessage, type EventMessage } from "./types.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * High-level category describing the subsystem that produced the event. The
 * identifiers match the checklist contract so filtering remains predictable for
 * MCP clients and regression tests alike.
 */
export type EventCategory =
  | "bt"
  | "scheduler"
  | "child"
  | "graph"
  | "stig"
  | "bb"
  | "cnp"
  | "consensus"
  | "values";

/**
 * Severity levels supported by the unified event bus. The values mirror the
 * structured logger which keeps cross-sink correlation trivial.
 */
export type EventLevel = "info" | "warn" | "error";

/**
 * Event envelope persisted by the bus. Optional identifiers default to `null`
 * instead of `undefined` so JSON serialisation stays deterministic in tests.
 */
export interface EventEnvelope {
  seq: number;
  ts: number;
  cat: EventCategory;
  level: EventLevel;
  jobId?: string | null;
  runId?: string | null;
  opId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  childId?: string | null;
  /** Identifier describing the orchestrator component that emitted the event. */
  component: string | null;
  /** Lifecycle stage or semantic step associated with the event. */
  stage: string | null;
  /** Optional duration expressed in milliseconds when the event measures latency. */
  elapsedMs?: number | null;
  /**
   * Optional semantic kind describing the precise lifecycle event.
   *
   * Historically, callers only received the coarse category (child/plan/...)
   * which prevented consumers from distinguishing between PROMPT, PENDING or
   * REPLY emissions when subscribing to the bus. The new field mirrors the
   * `EventStore` kind so downstream filters remain compatible with the legacy
   * contract expected by the regression suite.
   */
  kind?: string;
  msg: EventMessage;
  data?: unknown;
}

/**
 * Input accepted by {@link EventBus.publish}. The helper fills the timestamp
 * and sequence number when not explicitly provided.
 */
export interface EventInput {
  cat: EventCategory;
  level?: EventLevel;
  jobId?: string | null;
  runId?: string | null;
  opId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  childId?: string | null;
  component?: string | null;
  stage?: string | null;
  elapsedMs?: number | null;
  /** Optional semantic event identifier (see {@link EventEnvelope.kind}). */
  kind?: string | null;
  msg: EventMessage;
  data?: unknown;
  ts?: number;
}

/** Filters supported when listing or subscribing to events. */
export interface EventFilter {
  cats?: EventCategory[];
  levels?: EventLevel[];
  jobId?: string;
  runId?: string;
  opId?: string;
  graphId?: string;
  childId?: string;
  nodeId?: string;
  component?: string;
  stage?: string;
  afterSeq?: number;
  limit?: number;
}

/** Options accepted when instantiating the event bus. */
export interface EventBusOptions {
  historyLimit?: number;
  now?: () => number;
  streamBufferSize?: number;
}

const BUS_EVENT = "event";
const DEFAULT_HISTORY_LIMIT = 1_000;
const DEFAULT_STREAM_BUFFER = 256;

export const EVENT_CATEGORIES: readonly EventCategory[] = [
  "bt",
  "scheduler",
  "child",
  "graph",
  "stig",
  "bb",
  "cnp",
  "consensus",
  "values",
] as const;

const ALLOWED_CATEGORIES = new Set<EventCategory>(EVENT_CATEGORIES);

function normaliseCategory(cat: EventCategory): EventCategory {
  if (!ALLOWED_CATEGORIES.has(cat)) {
    throw new TypeError(`unknown event category: ${cat}`);
  }
  return cat;
}

function normaliseMessage(msg: string): EventMessage {
  const trimmed = msg.trim();
  if (trimmed.length === 0) {
    throw new TypeError("event message must be non-empty");
  }
  assertValidEventMessage(trimmed);
  return trimmed;
}

/**
 * Normalise the optional semantic kind supplied by bridge publishers.
 *
 * The bus guarantees that subscribers observe upper-cased identifiers so
 * dashboards can compare against stable PROMPT/PENDING/etc. tokens regardless
 * of the original casing provided by upstream emitters.
 */
function normaliseKind(kind: string | null | undefined): string | undefined {
  if (typeof kind !== "string") {
    return undefined;
  }
  const trimmed = kind.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Preserve historical expectations by upper-casing the identifier so
  // subscribers receive stable PROMPT/PENDING/etc. tokens regardless of the
  // original casing supplied by publishers.
  return trimmed.toUpperCase();
}

/**
 * Normalise optional textual tags (component/stage) by trimming whitespace and
 * rejecting empty strings. The helper keeps casing untouched so downstream
 * dashboards can render human friendly identifiers while the bus guarantees the
 * property is either a non-empty string or `null`.
 */
function normaliseTag(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalise optional duration values (expressed in milliseconds). The bus
 * stores `null` instead of `undefined` to preserve deterministic JSON
 * serialisation for tests.
 */
function normaliseElapsed(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  return Math.round(value);
}

class EventStream
  implements AsyncIterable<EventEnvelope>, AsyncIterator<EventEnvelope, void, void>
{
  private readonly buffer: EventEnvelope[] = [];
  private resolve?: (result: IteratorResult<EventEnvelope, void>) => void;
  private closed = false;

  /**
   * Precomputed iterator result returned whenever the stream completes. The
   * object is immutable to guarantee that awaiting consumers observe a stable
   * reference that cannot be mutated by publishers.
   */
  private static readonly DONE: IteratorReturnResult<void> = Object.freeze({
    value: undefined,
    done: true as const,
  });

  constructor(
    private readonly emitter: EventEmitter,
    private readonly matcher: (event: EventEnvelope) => boolean,
    seed: Iterable<EventEnvelope>,
    private readonly maxBuffer: number,
  ) {
    for (const event of seed) {
      this.enqueue(event);
    }
    this.emitter.on(BUS_EVENT, this.handleEvent);
  }

  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope, void> {
    return this;
  }

  async next(): Promise<IteratorResult<EventEnvelope, void>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    if (this.closed) {
      return EventStream.DONE;
    }
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  async return(): Promise<IteratorResult<EventEnvelope, void>> {
    this.close();
    return EventStream.DONE;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emitter.removeListener(BUS_EVENT, this.handleEvent);
    if (this.resolve) {
      this.resolve(EventStream.DONE);
      this.resolve = undefined;
    }
    this.buffer.length = 0;
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
    this.enqueue(event);
  };

  private enqueue(event: EventEnvelope): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      const idx = this.buffer.findIndex((candidate) => candidate.level === "info");
      if (idx >= 0) {
        this.buffer.splice(idx, 1);
      } else {
        this.buffer.shift();
      }
    }
  }
}

/**
 * Unified event bus buffering orchestration events in memory. The bus offers
 * both random access (via {@link list}) and streaming (via {@link subscribe}).
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: EventEnvelope[] = [];
  private historyLimit: number;
  private readonly now: () => number;
  private readonly streamBufferSize: number;
  private seq = 0;

  constructor(options: EventBusOptions = {}) {
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.now = options.now ?? (() => Date.now());
    this.streamBufferSize = Math.max(1, options.streamBufferSize ?? DEFAULT_STREAM_BUFFER);
  }

  setHistoryLimit(limit: number): void {
    this.historyLimit = Math.max(1, limit);
    this.trimHistory();
  }

  publish(input: EventInput): EventEnvelope {
    const message = normaliseMessage(input.msg);
    const component = normaliseTag(input.component ?? input.cat);
    const stage = normaliseTag(input.stage ?? message);
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
      component,
      stage,
      elapsedMs: normaliseElapsed(input.elapsedMs ?? null),
      // Preserve semantic PROMPT/PENDING/... identifiers whenever publishers
      // provide them while gracefully falling back to legacy category tokens.
      kind: normaliseKind(input.kind ?? undefined),
      msg: message,
      data: input.data,
    };

    this.history.push(envelope);
    if (this.history.length > this.historyLimit) {
      this.dropFromHistory();
    }

    this.emitter.emit(BUS_EVENT, envelope);
    return envelope;
  }

  list(filter: EventFilter = {}): EventEnvelope[] {
    const filtered = this.history.filter((event) => this.matches(event, filter));
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, this.historyLimit) : this.historyLimit;
    return filtered.slice(-limit);
  }

  subscribe(filter: EventFilter = {}): EventStream {
    const matcher = (event: EventEnvelope): boolean => this.matches(event, filter);
    const seed = this.list(filter);
    return new EventStream(this.emitter, matcher, seed, this.streamBufferSize);
  }

  private matches(event: EventEnvelope, filter: EventFilter): boolean {
    if (filter.cats && filter.cats.length > 0 && !filter.cats.includes(event.cat)) {
      return false;
    }
    if (filter.levels && filter.levels.length > 0 && !filter.levels.includes(event.level)) {
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
    if (filter.component && event.component !== filter.component) {
      return false;
    }
    if (filter.stage && event.stage !== filter.stage) {
      return false;
    }
    if (typeof filter.afterSeq === "number" && !(event.seq > filter.afterSeq)) {
      return false;
    }
    return true;
  }

  private dropFromHistory(): void {
    const index = this.history.findIndex((event) => event.level === "info");
    if (index >= 0) {
      this.history.splice(index, 1);
    } else {
      this.history.shift();
    }
  }

  private trimHistory(): void {
    while (this.history.length > this.historyLimit) {
      this.dropFromHistory();
    }
  }
}
