import {
  type JobBudget,
  type JobFailure,
  type JobMeta,
  type JobProgress,
  type JobProvenance,
  type JobRecord,
  type JobState,
  type JobStatePatch,
  type JobStatus,
  type JobSummary,
  type ListFilter,
  type SearchJobStore,
  type StoredJobMeta,
} from "./jobStore.js";

/** Default TTL (7 days) applied when the caller does not provide one. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Guard returning `true` when the job status is terminal. */
const isTerminalStatus = (status: JobStatus): boolean =>
  status === "completed" || status === "failed";

/** Simple mutex used to provide coarse grained synchronisation. */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const release = this.enqueue();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private enqueue(): () => void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => wait);
    return release;
  }
}

/**
 * Options controlling the behaviour of {@link InMemorySearchJobStore}.
 */
export interface InMemorySearchJobStoreOptions {
  /** Time to keep terminal jobs before `gc` purges them. */
  readonly ttlMs?: number;
  /** Clock used for deterministic testing. */
  readonly clock?: () => number;
}

interface InternalRecord {
  readonly meta: StoredJobMeta;
  readonly provenance: JobProvenance;
  readonly state: JobState;
}

/** Utility converting unknown inputs to a clean `JobBudget`. */
const normaliseBudget = (budget: JobBudget | undefined): JobBudget => ({
  maxDurationMs: budget?.maxDurationMs ?? null,
  maxToolCalls: budget?.maxToolCalls ?? null,
  maxBytesOut: budget?.maxBytesOut ?? null,
});

/** Remove duplicates and whitespace from tag arrays. */
const normaliseTags = (tags: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0) {
      continue;
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
};

/** Produce a defensive copy of the provided provenance payload. */
const cloneProvenance = (provenance: JobProvenance): JobProvenance => ({
  trigger: provenance.trigger,
  transport: provenance.transport,
  requestId: provenance.requestId ?? null,
  requester: provenance.requester ?? null,
  remoteAddress: provenance.remoteAddress ?? null,
  extra: { ...(provenance.extra ?? {}) },
});

/** Deep clone for progress beacons. */
const cloneProgress = (progress: JobProgress): JobProgress => ({
  step: progress.step,
  message: progress.message ?? null,
  ratio: progress.ratio ?? null,
  updatedAt: progress.updatedAt,
});

/** Deep clone for summary payloads. */
const cloneSummary = (summary: JobSummary): JobSummary => ({
  consideredResults: summary.consideredResults,
  fetchedDocuments: summary.fetchedDocuments,
  ingestedDocuments: summary.ingestedDocuments,
  skippedDocuments: summary.skippedDocuments,
  artifacts: [...summary.artifacts],
  metrics: { ...summary.metrics },
  notes: summary.notes ?? null,
});

/** Deep clone for failure entries. */
const cloneFailure = (failure: JobFailure): JobFailure => ({
  code: failure.code,
  message: failure.message,
  stage: failure.stage ?? null,
  occurredAt: failure.occurredAt,
  details: failure.details ?? null,
});

/**
 * In-memory job store primarily used for tests and local development. All
 * operations perform defensive cloning to avoid leaking mutable references.
 */
export class InMemorySearchJobStore implements SearchJobStore {
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly mutex = new AsyncMutex();
  private readonly records = new Map<string, InternalRecord>();

  constructor(options: InMemorySearchJobStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  async create(job: JobMeta): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const jobId = job.id.trim();
      if (jobId.length === 0) {
        throw new Error("Job id must not be empty");
      }
      if (this.records.has(jobId)) {
        throw new Error(`Job with id ${jobId} already exists`);
      }

      const provenance = cloneProvenance(job.provenance);
      const meta: StoredJobMeta = {
        id: jobId,
        createdAt: job.createdAt,
        query: job.query,
        normalizedQuery: job.normalizedQuery,
        tags: normaliseTags(job.tags),
        requester: job.requester ?? null,
        budget: normaliseBudget(job.budget),
      };

      const initialState: JobState = {
        status: "pending",
        createdAt: meta.createdAt,
        updatedAt: meta.createdAt,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        progress: null,
        summary: null,
        errors: [],
      };

      this.records.set(jobId, {
        meta,
        provenance,
        state: initialState,
      });
    });
  }

  async update(jobId: string, patch: JobStatePatch): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const record = this.records.get(jobId);
      if (!record) {
        throw new Error(`Unknown job id ${jobId}`);
      }

      if (isTerminalStatus(record.state.status)) {
        throw new Error(`Job ${jobId} is immutable after reaching ${record.state.status}`);
      }

      const nextState = this.applyPatch(record.state, patch);
      this.records.set(jobId, {
        meta: record.meta,
        provenance: record.provenance,
        state: nextState,
      });
    });
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const record = this.records.get(jobId);
    if (!record) {
      return null;
    }
    return this.cloneRecord(record);
  }

  async list(filter: ListFilter = {}): Promise<JobRecord[]> {
    const { status, since, until, tag, tags, limit } = filter;
    let statuses: Set<JobStatus> | null = null;
    if (status !== undefined) {
      if (typeof status === "string") {
        statuses = new Set<JobStatus>([status]);
      } else {
        statuses = new Set<JobStatus>(status);
      }
    }
    const requiredTags = tags === undefined ? null : new Set(tags);

    const results: JobRecord[] = [];
    for (const record of this.records.values()) {
      if (statuses && !statuses.has(record.state.status)) {
        continue;
      }
      if (since !== undefined && record.state.updatedAt < since) {
        continue;
      }
      if (until !== undefined && record.state.updatedAt > until) {
        continue;
      }
      if (tag && !record.meta.tags.includes(tag)) {
        continue;
      }
      if (requiredTags) {
        const hasAll = [...requiredTags].every((entry) => record.meta.tags.includes(entry));
        if (!hasAll) {
          continue;
        }
      }
      results.push(this.cloneRecord(record));
    }

    results.sort((a, b) => b.state.updatedAt - a.state.updatedAt);
    if (limit !== undefined && results.length > limit) {
      return results.slice(0, limit);
    }
    return results;
  }

  async gc(now: number): Promise<number> {
    return this.mutex.runExclusive(async () => {
      let purged = 0;
      for (const [jobId, record] of this.records.entries()) {
        if (!isTerminalStatus(record.state.status)) {
          continue;
        }
        if (now - record.state.updatedAt < this.ttlMs) {
          continue;
        }
        this.records.delete(jobId);
        purged += 1;
      }
      return purged;
    });
  }

  private cloneRecord(record: InternalRecord): JobRecord {
    return {
      meta: {
        id: record.meta.id,
        createdAt: record.meta.createdAt,
        query: record.meta.query,
        normalizedQuery: record.meta.normalizedQuery,
        tags: [...record.meta.tags],
        requester: record.meta.requester,
        budget: { ...record.meta.budget },
      },
      provenance: cloneProvenance(record.provenance),
      state: this.cloneState(record.state),
    };
  }

  private cloneState(state: JobState): JobState {
    return {
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      failedAt: state.failedAt,
      progress: state.progress ? cloneProgress(state.progress) : null,
      summary: state.summary ? cloneSummary(state.summary) : null,
      errors: state.errors.map(cloneFailure),
    };
  }

  private applyPatch(current: JobState, patch: JobStatePatch): JobState {
    if (Object.prototype.hasOwnProperty.call(patch, "createdAt")) {
      throw new Error("createdAt is immutable");
    }

    const updatedAt = patch.updatedAt ?? this.clock();
    if (!Number.isFinite(updatedAt)) {
      throw new Error("updatedAt must be a finite number");
    }
    if (updatedAt < current.updatedAt) {
      throw new Error("updatedAt must be monotonically increasing");
    }

    const nextStatus = patch.status ?? current.status;
    if (nextStatus !== current.status && !this.isValidTransition(current.status, nextStatus)) {
      throw new Error(`Invalid status transition ${current.status} → ${nextStatus}`);
    }

    const startedAt = this.resolveTimestamp(patch.startedAt, current.startedAt, current.createdAt, updatedAt);
    const completedAt = this.resolveTimestamp(patch.completedAt, current.completedAt, current.createdAt, updatedAt);
    const failedAt = this.resolveTimestamp(patch.failedAt, current.failedAt, current.createdAt, updatedAt);

    if (nextStatus === "running" && startedAt === null) {
      throw new Error("running jobs must have a startedAt timestamp");
    }
    if (nextStatus === "completed" && completedAt === null) {
      throw new Error("completed jobs must have a completedAt timestamp");
    }
    if (nextStatus === "failed" && failedAt === null) {
      throw new Error("failed jobs must have a failedAt timestamp");
    }

    if (isTerminalStatus(nextStatus) && !isTerminalStatus(current.status)) {
      // Allow updating summary/errors alongside the transition.
    }

    return {
      status: nextStatus,
      createdAt: current.createdAt,
      updatedAt,
      startedAt,
      completedAt,
      failedAt,
      progress:
        patch.progress === undefined
          ? current.progress
          : patch.progress === null
          ? null
          : cloneProgress(patch.progress),
      summary:
        patch.summary === undefined
          ? current.summary
          : patch.summary === null
          ? null
          : cloneSummary(patch.summary),
      errors:
        patch.errors === undefined
          ? current.errors
          : patch.errors.map(cloneFailure),
    };
  }

  private resolveTimestamp(
    candidate: number | null | undefined,
    previous: number | null,
    lowerBound: number,
    fallback: number,
  ): number | null {
    if (candidate === undefined) {
      if (previous !== null) {
        return previous;
      }
      candidate = fallback;
    }
    if (candidate === null) {
      return null;
    }
    if (!Number.isFinite(candidate)) {
      throw new Error("timestamps must be finite numbers");
    }
    if (candidate < lowerBound) {
      throw new Error("timestamps must be greater than or equal to createdAt");
    }
    if (previous !== null && candidate < previous) {
      throw new Error("timestamps must be monotonically increasing");
    }
    return candidate;
  }

  private isValidTransition(from: JobStatus, to: JobStatus): boolean {
    if (from === to) {
      return true;
    }
    switch (from) {
      case "pending":
        return to === "running" || to === "failed";
      case "running":
        return to === "completed" || to === "failed";
      default:
        return false;
    }
  }
}
