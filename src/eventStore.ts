import { StructuredLogger } from "./logger.js";

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
  | "ERROR";

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
}

export interface EventFilters {
  readonly jobId?: string;
  readonly childId?: string;
  readonly minSeq?: number;
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
      payload: input.payload
    };

    this.events.push(event);
    if (this.events.length > this.maxHistory) {
      this.events.shift();
    }

    if (event.jobId) {
      const existing = this.perJob.get(event.jobId) ?? [];
      existing.push(event);
      if (existing.length > this.maxHistory) {
        existing.shift();
      }
      this.perJob.set(event.jobId, existing);
    }

    return event;
  }

  list(filters: EventFilters = {}): OrchestratorEvent[] {
    return this.events.filter((event) => {
      if (filters.minSeq !== undefined && event.seq <= filters.minSeq) {
        return false;
      }
      if (filters.jobId && event.jobId !== filters.jobId) {
        return false;
      }
      if (filters.childId && event.childId !== filters.childId) {
        return false;
      }
      return true;
    });
  }

  listForJob(jobId: string, minSeq?: number): OrchestratorEvent[] {
    const base = this.perJob.get(jobId) ?? [];
    if (minSeq === undefined) {
      return [...base];
    }
    return base.filter((event) => event.seq > minSeq);
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
      this.events.shift();
    }
    for (const [jobId, events] of this.perJob.entries()) {
      while (events.length > this.maxHistory) {
        events.shift();
      }
      this.perJob.set(jobId, events);
    }
  }
}
