/**
 * Centralised in-memory journal retaining a bounded view of orchestration
 * events. The store enforces FIFO eviction globally, per job, and per kind while
 * keeping log serialisation deterministic so replay artefacts remain diffable.
 */
import { StructuredLogger } from "./logger.js";
import { coerceNullToUndefined, omitUndefinedEntries } from "./utils/object.js";
import { normaliseProvenanceList, type Provenance } from "./types/provenance.js";

/**
 * Maximum size (in characters) of the JSON representation we attempt to mirror
 * in log entries. Larger payloads are summarised to avoid bloating the
 * orchestrator logs when callers attach verbose artefacts to an event.
 */
const MAX_LOGGED_PAYLOAD_LENGTH = 4_096;
/** Upper bound applied to event payload error messages before storage. */
const MAX_ERROR_MESSAGE_LENGTH = 1_000;

/**
 * Recursively sorts the keys of plain object payloads so JSON serialisation
 * becomes deterministic. Stable ordering keeps diffs readable when
 * EventStore-backed artefacts are inspected or committed to disk. Complex
 * structures (maps, dates, sets) fall back to their default JSON
 * representation. Circular references intentionally mirror the behaviour of
 * {@link JSON.stringify} by throwing so the caller can surface a summary.
 */
function stabiliseForStableJson(value: unknown, stack = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const objectValue = value as Record<string, unknown>;
  if (stack.has(objectValue)) {
    throw new TypeError("Converting circular structure to JSON");
  }

  stack.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      return objectValue.map((entry) => stabiliseForStableJson(entry, stack));
    }

    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype === Object.prototype || prototype === null) {
      const sortedKeys = Object.keys(objectValue).sort();
      const clone: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        clone[key] = stabiliseForStableJson(objectValue[key], stack);
      }
      return clone;
    }

    return value;
  } finally {
    stack.delete(objectValue);
  }
}

/**
 * Determines whether a value is a plain object (i.e. created via object literal
 * or with a null prototype). The helper avoids cloning complex instances such
 * as Map/Set/Date where preserving prototype semantics is critical.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Clones payloads before they are stored in the event journal so downstream
 * consumers observe immutable snapshots even when emitters mutate their inputs
 * afterwards. The function favours `structuredClone` for deep copies and falls
 * back to the `stabiliseForStableJson` walk for plain objects/arrays when
 * `structuredClone` rejects (e.g. functions). Exotic instances (Map/Set/Date)
 * reuse the original reference as they are safe to clone via `structuredClone`
 * and must preserve their prototype semantics.
 */
function clonePayloadForStorage(payload: unknown): unknown {
  if (payload === undefined) {
    return undefined;
  }

  if (typeof structuredClone === "function") {
    try {
      const cloned = structuredClone(payload);
      try {
        return stabiliseForStableJson(cloned);
      } catch {
        return cloned;
      }
    } catch {
      // Fall through to the manual clone for plain objects/arrays.
    }
  }

  if (Array.isArray(payload) || isPlainObject(payload)) {
    try {
      return stabiliseForStableJson(payload);
    } catch {
      return payload;
    }
  }

  return payload;
}

/**
 * Normalises event payloads before they are cloned for storage. Search events
 * automatically receive a payload version tag and excessively long error
 * messages are truncated so downstream artefacts remain readable.
 */
function normaliseEventPayload(kind: EventKind, payload: unknown): unknown {
  if (!kind.startsWith("search:")) {
    return payload;
  }

  const base: Record<string, unknown> =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};

  const message = base.message;
  if (typeof message === "string" && message.length > MAX_ERROR_MESSAGE_LENGTH) {
    const slice = message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1);
    base.message = `${slice}…`;
  }

  if (base.version === undefined) {
    base.version = 1;
  }

  return base;
}

export type EventKind =
  | "PLAN"
  | "START"
  | "PROMPT"
  | "PENDING"
  | "REPLY_PART"
  | "REPLY"
  | "STATUS"
  | "AGGREGATE"
  | "KILL"
  | "HEARTBEAT"
  | "INFO"
  | "WARN"
  | "ERROR"
  | "BT_RUN"
  | "SCHEDULER"
  | "AUTOSCALER"
  | "COGNITIVE"
  | "HTTP_ACCESS" // Structured audit log capturing HTTP access (ip/route/status/latency).
  | "search:job_created"
  | "search:job_started"
  | "search:job_progress"
  | "search:doc_ingested"
  | "search:error"
  | "search:job_completed"
  | "search:job_failed";

export type EventLevel = "info" | "warn" | "error";
export type EventSource = "orchestrator" | "child" | "system";

export interface OrchestratorEvent {
  seq: number;
  ts: number;
  kind: EventKind;
  source: EventSource;
  level: EventLevel;
  jobId?: string;
  childId?: string;
  payload?: unknown;
  provenance: Provenance[];
}

export interface EventStoreOptions {
  readonly maxHistory: number;
  readonly logger?: StructuredLogger;
}

export interface EmitEventInput {
  kind: EventKind;
  level?: EventLevel;
  source?: EventSource;
  jobId?: string;
  childId?: string;
  payload?: unknown;
  provenance?: Provenance[];
}

export interface EventFilters {
  readonly jobId?: string;
  readonly childId?: string;
  readonly minSeq?: number;
  readonly kinds?: ReadonlyArray<EventKind>;
  readonly limit?: number;
  readonly reverse?: boolean;
}

/** Narrow filters accepted by {@link EventStore.listForJob}. */
export interface JobEventFilters extends Pick<EventFilters, "childId" | "minSeq" | "kinds" | "limit" | "reverse"> {}

/** Builds a set from the user supplied kinds while ignoring duplicates or garbage values. */
function normaliseKindFilter(kinds: ReadonlyArray<EventKind> | undefined): Set<EventKind> | null {
  if (!kinds || kinds.length === 0) {
    return null;
  }

  const set = new Set<EventKind>();
  for (const kind of kinds) {
    if (typeof kind !== "string") {
      continue;
    }
    set.add(kind as EventKind);
  }

  return set.size > 0 ? set : null;
}

/** Coerces the optional limit to a safe integer, returning `0` for non-positive values. */
function normaliseLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isFinite(limit)) {
    return undefined;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) {
    return 0;
  }
  return floored;
}

/**
 * Applies ordering and windowing to the filtered events. The helper returns a
 * brand new array so callers can freely mutate the result without observing
 * internal state changes.
 */
function applyWindow(
  events: OrchestratorEvent[],
  options: { reverse?: boolean; limit?: number },
): OrchestratorEvent[] {
  const ordered = options.reverse ? [...events].reverse() : [...events];
  const limit = normaliseLimit(options.limit);
  if (limit === undefined) {
    return ordered;
  }
  if (limit === 0) {
    return [];
  }
  return ordered.slice(0, limit);
}

/**
 * Event storage keeping a bounded history both globally and for individual
 * jobs. Consumers can request subsets filtered by sequence, job or child.
 */
export class EventStore {
  private seq = 0;
  private maxHistory: number;
  private readonly events: OrchestratorEvent[] = [];
  private readonly perJob = new Map<string, OrchestratorEvent[]>();
  private readonly perKind = new Map<EventKind, OrchestratorEvent[]>();
  private logger: StructuredLogger;

  constructor(options: EventStoreOptions) {
    this.maxHistory = Math.max(1, options.maxHistory);
    this.logger = options.logger ?? new StructuredLogger();
  }

  emit(input: EmitEventInput): OrchestratorEvent {
    const normalisedPayload = normaliseEventPayload(input.kind, input.payload);
    const event: OrchestratorEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      kind: input.kind,
      level: input.level ?? "info",
      source: input.source ?? "orchestrator",
      // Optional identifiers are coerced to `undefined` so the resulting event
      // never materialises `null` placeholders. This keeps the EventStore API
      // aligned with `exactOptionalPropertyTypes` and mirrors the behaviour of
      // higher-level emitters such as `pushEvent`.
      ...omitUndefinedEntries({
        jobId: coerceNullToUndefined(input.jobId),
        childId: coerceNullToUndefined(input.childId),
        payload: clonePayloadForStorage(normalisedPayload),
      }),
      provenance: normaliseProvenanceList(input.provenance),
    };

    // FIFO eviction happens on every write so the global buffer never grows
    // beyond {@link maxHistory}. Downstream buckets mirror the same limit to
    // guarantee bounded memory usage even when callers query per-job or
    // per-kind slices after the global window has advanced.
    this.events.push(event);
    if (this.events.length > this.maxHistory) {
      const evicted = this.events.shift();
      if (evicted) {
        this.logEventEviction("global", evicted, { remaining: this.events.length });
      }
    }

    if (event.jobId) {
      const existing = this.perJob.get(event.jobId) ?? [];
      existing.push(event);
      if (existing.length > this.maxHistory) {
        const evicted = existing.shift();
        if (evicted) {
          this.logEventEviction("job", evicted, {
            jobId: event.jobId,
            remaining: existing.length,
          });
        }
      }
      if (existing.length === 0) {
        this.perJob.delete(event.jobId);
      } else {
        this.perJob.set(event.jobId, existing);
      }
    }

    const kindBucket = this.perKind.get(event.kind) ?? [];
    kindBucket.push(event);
    if (kindBucket.length > this.maxHistory) {
      const evicted = kindBucket.shift();
      if (evicted) {
        this.logEventEviction("kind", evicted, {
          kind: event.kind,
          remaining: kindBucket.length,
        });
      }
    }
    if (kindBucket.length === 0) {
      this.perKind.delete(event.kind);
    } else {
      this.perKind.set(event.kind, kindBucket);
    }

    this.logEventEmission(event);

    return event;
  }

  /**
   * Returns events filtered by job/child/kind selectors and optional windowing
   * controls. Results keep chronological ordering unless {@link EventFilters.reverse}
   * is explicitly enabled.
   */
  list(filters: EventFilters = {}): OrchestratorEvent[] {
    const kindFilter = normaliseKindFilter(filters.kinds);
    const minSeq = typeof filters.minSeq === "number" ? filters.minSeq : undefined;
    const filtered = this.events.filter((event) => {
      if (minSeq !== undefined && event.seq <= minSeq) {
        return false;
      }
      if (filters.jobId && event.jobId !== filters.jobId) {
        return false;
      }
      if (filters.childId && event.childId !== filters.childId) {
        return false;
      }
      if (kindFilter && !kindFilter.has(event.kind)) {
        return false;
      }
      return true;
    });
    return applyWindow(filtered, omitUndefinedEntries({ reverse: filters.reverse, limit: filters.limit }));
  }

  /**
   * Efficient helper returning events scoped to a single job. Callers can pass
   * either the legacy `minSeq` number or the richer {@link JobEventFilters}
   * object when they need pagination and kind filtering.
   */
  listForJob(jobId: string, options?: number | JobEventFilters): OrchestratorEvent[] {
    const base = this.perJob.get(jobId) ?? [];
    const filters: JobEventFilters =
      typeof options === "number"
        ? { minSeq: options }
        : options
          ? options
          : {};

    const kindFilter = normaliseKindFilter(filters.kinds);
    const minSeq = typeof filters.minSeq === "number" ? filters.minSeq : undefined;
    const childId = filters.childId;

    const filtered = base.filter((event) => {
      if (minSeq !== undefined && event.seq <= minSeq) {
        return false;
      }
      if (childId && event.childId !== childId) {
        return false;
      }
      if (kindFilter && !kindFilter.has(event.kind)) {
        return false;
      }
      return true;
    });

    return applyWindow(filtered, omitUndefinedEntries({ reverse: filters.reverse, limit: filters.limit }));
  }

  getSnapshot(): OrchestratorEvent[] {
    return [...this.events];
  }

  setMaxHistory(limit: number): void {
    this.maxHistory = Math.max(1, limit);
    this.trim();
    this.logger.debug("event_history_limit_updated", { limit: this.maxHistory });
  }

  setLogger(logger: StructuredLogger): void {
    this.logger = logger;
  }

  getMaxHistory(): number {
    return this.maxHistory;
  }

  getLastSequence(): number {
    return this.seq;
  }

  getEventCount(): number {
    return this.events.length;
  }

  getEventsByKind(kind: EventKind): OrchestratorEvent[] {
    const bucket = this.perKind.get(kind);
    return bucket ? [...bucket] : [];
  }

  /**
   * Trims the global and per-job buffers so they do not exceed the configured
   * history. Per-job slices intentionally retain their own windows even when the
   * global buffer has already evicted the same entries to preserve job-centric
   * pagination semantics.
   */
  private trim(): void {
    while (this.events.length > this.maxHistory) {
      const evicted = this.events.shift();
      if (evicted) {
        this.logEventEviction("global", evicted, { remaining: this.events.length });
      }
    }
    for (const [jobId, events] of this.perJob.entries()) {
      while (events.length > this.maxHistory) {
        const evicted = events.shift();
        if (evicted) {
          this.logEventEviction("job", evicted, { jobId, remaining: events.length });
        }
      }
      if (events.length === 0) {
        this.perJob.delete(jobId);
      } else {
        this.perJob.set(jobId, events);
      }
    }

    for (const [kind, events] of this.perKind.entries()) {
      while (events.length > this.maxHistory) {
        const evicted = events.shift();
        if (evicted) {
          this.logEventEviction("kind", evicted, { kind, remaining: events.length });
        }
      }
      if (events.length === 0) {
        this.perKind.delete(kind);
      } else {
        this.perKind.set(kind, events);
      }
    }
  }

  /**
   * Emits a structured log entry mirroring the recorded event without leaking
   * overly large payloads. The helper keeps the EventStore as the canonical
   * history while still surfacing a concise audit trail in the orchestrator
   * logs.
   */
  private logEventEmission(event: OrchestratorEvent): void {
    const logPayload: Record<string, unknown> = {
      seq: event.seq,
      ts: event.ts,
      kind: event.kind,
      source: event.source,
      level: event.level,
      job_id: event.jobId ?? null,
      child_id: event.childId ?? null,
      provenance_count: event.provenance.length,
    };

    if (event.payload !== undefined) {
      const serialised = this.serialisePayloadForLogging(event.payload);
      if (serialised.status === "success") {
        logPayload.payload = serialised.value;
      } else {
        logPayload.payload_summary = serialised.value;
      }
    }

    this.logWithLevel(event.level, "event_recorded", logPayload);
  }

  /**
   * Logs the eviction of an event from the bounded history. The structured
   * payload includes the eviction scope so operators can distinguish between
   * global and per-job trimming operations.
   */
  private logEventEviction(
    scope: "global" | "job" | "kind",
    event: OrchestratorEvent,
    details: { jobId?: string; kind?: EventKind; remaining: number },
  ): void {
    const payload: Record<string, unknown> = {
      scope,
      seq: event.seq,
      kind: event.kind,
      job_id: details.jobId ?? event.jobId ?? null,
      child_id: event.childId ?? null,
      remaining: details.remaining,
      reason: "history_limit",
    };

    if (details.kind) {
      payload.kind = details.kind;
    }

    this.logger.info("event_evicted", payload);
  }

  /**
   * Maps the event level to the appropriate logger method. Using a dedicated
   * helper guarantees a consistent mapping should additional levels be added in
   * the future.
   */
  private logWithLevel(level: EventLevel, message: string, payload: Record<string, unknown>): void {
    switch (level) {
      case "warn":
        this.logger.warn(message, payload);
        break;
      case "error":
        this.logger.error(message, payload);
        break;
      case "info":
      default:
        this.logger.info(message, payload);
        break;
    }
  }

  /**
   * Serialises the payload attached to an event so logging remains deterministic
   * even when callers provide complex objects. Oversized payloads are replaced
   * with a summary noting the original length.
   */
  private serialisePayloadForLogging(
    payload: unknown,
  ): {
    status: "success";
    value: unknown;
  } | {
    status: "summary";
    value: { summary: string; length: number; error?: string };
  } {
    try {
      const json = JSON.stringify(stabiliseForStableJson(payload));
      if (json === undefined) {
        return { status: "success", value: null };
      }
      if (json.length > MAX_LOGGED_PAYLOAD_LENGTH) {
        return {
          status: "summary",
          value: { summary: "payload_truncated", length: json.length },
        };
      }
      return { status: "success", value: JSON.parse(json) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "summary",
        value: { summary: "payload_serialization_failed", length: 0, error: message },
      };
    }
  }
}
