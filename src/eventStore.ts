import { StructuredLogger } from "./logger.js";
import { normaliseProvenanceList, type Provenance } from "./types/provenance.js";

/**
 * Maximum size (in characters) of the JSON representation we attempt to mirror
 * in log entries. Larger payloads are summarised to avoid bloating the
 * orchestrator logs when callers attach verbose artefacts to an event.
 */
const MAX_LOGGED_PAYLOAD_LENGTH = 4_096;

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
  | "HTTP_ACCESS"; // Structured audit log capturing HTTP access (ip/route/status/latency).

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
  private logger: StructuredLogger;

  constructor(options: EventStoreOptions) {
    this.maxHistory = Math.max(1, options.maxHistory);
    this.logger = options.logger ?? new StructuredLogger();
  }

  emit(input: EmitEventInput): OrchestratorEvent {
    const event: OrchestratorEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      kind: input.kind,
      level: input.level ?? "info",
      source: input.source ?? "orchestrator",
      jobId: input.jobId,
      childId: input.childId,
      payload: input.payload,
      provenance: normaliseProvenanceList(input.provenance),
    };

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
      this.perJob.set(event.jobId, existing);
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
    return applyWindow(filtered, { reverse: filters.reverse, limit: filters.limit });
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

    return applyWindow(filtered, { reverse: filters.reverse, limit: filters.limit });
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
    return this.events.filter((event) => event.kind === kind);
  }

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
      this.perJob.set(jobId, events);
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
    scope: "global" | "job",
    event: OrchestratorEvent,
    details: { jobId?: string; remaining: number },
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
      const json = JSON.stringify(payload);
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
