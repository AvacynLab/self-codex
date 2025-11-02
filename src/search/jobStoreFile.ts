import { promises as fs } from "node:fs";
import { open as openFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
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

/** Default TTL (7 days) applied to terminal jobs before GC purges them. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Default interval (in milliseconds) between best-effort fsync operations. */
const DEFAULT_FSYNC_INTERVAL_MS = 1_000;

/** Guard returning `true` when the provided status is terminal. */
const isTerminalStatus = (status: JobStatus): boolean =>
  status === "completed" || status === "failed";

/** Simple async mutex providing coarse-grained critical sections. */
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

/** Configuration accepted by {@link FileSearchJobStore}. */
export interface FileSearchJobStoreOptions {
  /** Directory holding the JSONL journal and compaction artefacts. */
  readonly directory: string;
  /** Time-to-live applied to terminal jobs during garbage collection. */
  readonly ttlMs?: number;
  /** Clock used for deterministic testing. */
  readonly clock?: () => number;
  /**
   * Strategy governing when `fsync` is invoked. `interval` batches disk flushes
   * behind a timer to amortise I/O costs while still providing durability.
   */
  readonly fsyncMode?: "always" | "interval" | "never";
  /** Interval used when `fsyncMode === "interval"`. */
  readonly fsyncIntervalMs?: number;
  /** Optional logger used to surface locking or recovery warnings. */
  readonly log?: (level: "warn" | "info", message: string) => void;
}

interface InternalRecord {
  readonly meta: StoredJobMeta;
  readonly provenance: JobProvenance;
  readonly state: JobState;
}

interface SnapshotEntry {
  readonly type: "snapshot";
  readonly job: SerializedRecord;
}

interface UpdateEntry {
  readonly type: "update";
  readonly jobId: string;
  readonly state: SerializedState;
}

type JournalEntry = SnapshotEntry | UpdateEntry;

interface SerializedRecord {
  readonly meta: SerializedMeta;
  readonly provenance: SerializedProvenance;
  readonly state: SerializedState;
}

type SerializedMeta = StoredJobMeta;
type SerializedProvenance = JobProvenance;
type SerializedState = JobState;

/** Utility converting unknown inputs to a clean {@link StoredJobMeta}. */
const normaliseMeta = (meta: JobMeta): StoredJobMeta => ({
  id: meta.id,
  createdAt: meta.createdAt,
  query: meta.query,
  normalizedQuery: meta.normalizedQuery,
  tags: [...meta.tags],
  requester: meta.requester ?? null,
  budget: {
    maxDurationMs: meta.budget.maxDurationMs ?? null,
    maxToolCalls: meta.budget.maxToolCalls ?? null,
    maxBytesOut: meta.budget.maxBytesOut ?? null,
  },
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
 * Serialize a record to a JSON-friendly payload. The structure only contains
 * primitives, arrays and plain objects to guarantee `JSON.stringify` fidelity.
 */
const serialiseRecord = (record: InternalRecord): SerializedRecord => ({
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
  state: serialiseState(record.state),
});

/** Serialise a job state ensuring nested data is copied defensively. */
const serialiseState = (state: JobState): JobState => ({
  status: state.status,
  createdAt: state.createdAt,
  updatedAt: state.updatedAt,
  startedAt: state.startedAt,
  completedAt: state.completedAt,
  failedAt: state.failedAt,
  progress: state.progress ? cloneProgress(state.progress) : null,
  summary: state.summary ? cloneSummary(state.summary) : null,
  errors: state.errors.map(cloneFailure),
});

/** Reconstruct an in-memory record from a snapshot entry. */
const hydrateRecord = (snapshot: SerializedRecord): InternalRecord => ({
  meta: {
    id: snapshot.meta.id,
    createdAt: snapshot.meta.createdAt,
    query: snapshot.meta.query,
    normalizedQuery: snapshot.meta.normalizedQuery,
    tags: [...snapshot.meta.tags],
    requester: snapshot.meta.requester,
    budget: { ...snapshot.meta.budget },
  },
  provenance: cloneProvenance(snapshot.provenance),
  state: serialiseState(snapshot.state),
});

/**
 * File-backed job store persisting records in an append-only JSONL journal. The
 * implementation keeps an in-memory index for quick lookups while flushing
 * mutations to disk based on the configured fsync policy.
 */
export class FileSearchJobStore implements SearchJobStore {
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly fsyncMode: "always" | "interval" | "never";
  private readonly fsyncIntervalMs: number;
  private readonly log: (level: "warn" | "info", message: string) => void;
  private readonly directory: string;
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly mutex = new AsyncMutex();
  private readonly records = new Map<string, InternalRecord>();

  private journalHandle: FileHandle | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private pendingSync = false;
  private hasLock = false;

  constructor(options: FileSearchJobStoreOptions) {
    this.directory = options.directory;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.fsyncMode = options.fsyncMode ?? "interval";
    this.fsyncIntervalMs = options.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS;
    this.log = options.log ?? (() => {});
    this.journalPath = path.join(this.directory, "jobs.active.jsonl");
    this.lockPath = path.join(this.directory, "jobs.lock");
  }

  /** Initialise the store by loading the existing journal from disk. */
  async initialise(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await this.acquireLock();
    await this.recoverFromJournal();
    this.journalHandle = await openFile(this.journalPath, "a");
    if (this.fsyncMode === "interval") {
      this.syncTimer = setInterval(() => {
        void this.flushPendingSync().catch((error) => {
          this.log("warn", `Failed to fsync job journal: ${String(error)}`);
        });
      }, this.fsyncIntervalMs);
      this.syncTimer.unref();
    }
  }

  async create(job: JobMeta): Promise<void> {
    await this.ensureReady();
    await this.mutex.runExclusive(async () => {
      const jobId = job.id.trim();
      if (jobId.length === 0) {
        throw new Error("Job id must not be empty");
      }
      if (this.records.has(jobId)) {
        throw new Error(`Job with id ${jobId} already exists`);
      }

      const meta: StoredJobMeta = {
        ...normaliseMeta(job),
        tags: normaliseTags(job.tags),
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

      const provenance = cloneProvenance(job.provenance);
      const record: InternalRecord = { meta, provenance, state: initialState };
      this.records.set(jobId, record);

      await this.appendEntry({
        type: "snapshot",
        job: serialiseRecord(record),
      });
    });
  }

  async update(jobId: string, patch: JobStatePatch): Promise<void> {
    await this.ensureReady();
    await this.mutex.runExclusive(async () => {
      const record = this.records.get(jobId);
      if (!record) {
        throw new Error(`Unknown job id ${jobId}`);
      }
      if (isTerminalStatus(record.state.status)) {
        throw new Error(`Job ${jobId} is immutable after reaching ${record.state.status}`);
      }

      const nextState = this.applyPatch(record.state, patch);
      const nextRecord: InternalRecord = {
        meta: record.meta,
        provenance: record.provenance,
        state: nextState,
      };
      this.records.set(jobId, nextRecord);

      await this.appendEntry({
        type: "update",
        jobId,
        state: serialiseState(nextState),
      });
    });
  }

  async get(jobId: string): Promise<JobRecord | null> {
    await this.ensureReady();
    const record = this.records.get(jobId);
    if (!record) {
      return null;
    }
    return this.cloneRecord(record);
  }

  async list(filter: ListFilter = {}): Promise<JobRecord[]> {
    await this.ensureReady();
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
    await this.ensureReady();
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

      if (purged > 0) {
        await this.rewriteJournal();
      }

      return purged;
    });
  }

  /** Flush and close resources. Primarily used by tests. */
  async dispose(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    await this.flushPendingSync();
    if (this.journalHandle) {
      await this.journalHandle.close();
      this.journalHandle = null;
    }
    if (this.hasLock) {
      await fs.rm(this.lockPath, { force: true });
      this.hasLock = false;
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.journalHandle) {
      await this.initialise();
    }
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
      state: serialiseState(record.state),
    };
  }

  private async appendEntry(entry: JournalEntry): Promise<void> {
    if (!this.journalHandle) {
      throw new Error("Job journal is not initialised");
    }
    const payload = `${JSON.stringify(entry)}\n`;
    await this.journalHandle.write(payload);
    switch (this.fsyncMode) {
      case "always":
        await this.journalHandle.sync();
        break;
      case "interval":
        this.pendingSync = true;
        break;
      case "never":
        break;
    }
  }

  private async flushPendingSync(): Promise<void> {
    if (!this.pendingSync) {
      return;
    }
    if (!this.journalHandle) {
      return;
    }
    try {
      await this.journalHandle.sync();
    } finally {
      this.pendingSync = false;
    }
  }

  private async rewriteJournal(): Promise<void> {
    if (!this.journalHandle) {
      throw new Error("Job journal is not initialised");
    }
    await this.flushPendingSync();
    await this.journalHandle.close();
    this.journalHandle = null;

    const tempPath = path.join(this.directory, `jobs.compacted.${Date.now()}.jsonl`);
    const handle = await openFile(tempPath, "w");
    try {
      const sorted = [...this.records.values()].sort(
        (a, b) => a.state.updatedAt - b.state.updatedAt,
      );
      for (const record of sorted) {
        const entry: SnapshotEntry = { type: "snapshot", job: serialiseRecord(record) };
        await handle.write(`${JSON.stringify(entry)}\n`);
      }
      if (this.fsyncMode !== "never") {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, this.journalPath);
    this.journalHandle = await openFile(this.journalPath, "a");
  }

  private async recoverFromJournal(): Promise<void> {
    try {
      const content = await fs.readFile(this.journalPath, "utf8");
      if (content.length === 0) {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as JournalEntry;
          if (parsed.type === "snapshot") {
            const record = hydrateRecord(parsed.job);
            this.records.set(record.meta.id, record);
          } else if (parsed.type === "update") {
            const record = this.records.get(parsed.jobId);
            if (!record) {
              throw new Error(`Missing base record for job ${parsed.jobId}`);
            }
            this.records.set(parsed.jobId, {
              meta: record.meta,
              provenance: record.provenance,
              state: serialiseState(parsed.state),
            });
          }
        } catch (error) {
          this.log(
            "warn",
            `Failed to parse job journal entry: ${(error as Error).message ?? String(error)}`,
          );
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
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
    const completedAt = this.resolveTimestamp(
      patch.completedAt,
      current.completedAt,
      current.createdAt,
      updatedAt,
    );
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

  private async acquireLock(): Promise<void> {
    try {
      const handle = await openFile(this.lockPath, "wx");
      await handle.write(`${process.pid}`);
      await handle.close();
      this.hasLock = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        this.log(
          "warn",
          "Job journal lock already exists. Continuing without exclusive ownership.",
        );
        this.hasLock = false;
        return;
      }
      throw error;
    }
  }
}

