import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Streams supported by the log journal. */
export type LogStream = "server" | "run" | "child";

/**
 * Options accepted when instantiating the {@link LogJournal}. They control how many entries are
 * retained in memory and how JSONL persistence is rotated on disk.
 */
export interface LogJournalOptions {
  /** Root directory where JSONL artefacts are persisted. */
  readonly rootDir: string;
  /** Maximum number of entries preserved in memory for a given bucket. */
  readonly maxEntriesPerBucket?: number;
  /** Maximum size in bytes of a JSONL file before rotation occurs. */
  readonly maxFileSizeBytes?: number;
  /** Number of rotated files kept per bucket. */
  readonly maxFileCount?: number;
}

/** Base shape shared by all correlated log entries. */
export interface BaseCorrelatedLogEntry {
  /** Monotonic sequence used for paging. */
  seq: number;
  /** Timestamp expressed in epoch milliseconds. */
  ts: number;
  /** Stream category the entry belongs to. */
  stream: LogStream;
  /** Identifier of the underlying bucket (run id, child id or fixed name). */
  bucketId: string;
  /** Severity level surfaced by the orchestrator. */
  level: string;
  /** Human readable message. */
  message: string;
  /** Optional structured payload carried alongside the message. */
  data?: unknown;
  /** Optional job identifier associated with the log entry. */
  jobId?: string | null;
  /** Optional run identifier. */
  runId?: string | null;
  /** Optional operation identifier. */
  opId?: string | null;
  /** Optional graph identifier. */
  graphId?: string | null;
  /** Optional node identifier. */
  nodeId?: string | null;
  /** Optional child identifier. */
  childId?: string | null;
}

/** Entry shape persisted in memory and on disk. */
export interface CorrelatedLogEntry extends BaseCorrelatedLogEntry {}

/** Input accepted when recording a new log entry. */
export interface LogRecordInput {
  stream: LogStream;
  bucketId?: string | null;
  ts?: number;
  seq?: number;
  level: string;
  message: string;
  data?: unknown;
  jobId?: string | null;
  runId?: string | null;
  opId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  childId?: string | null;
}

/** Result returned by {@link LogJournal.tail}. */
export interface LogTailResult {
  entries: CorrelatedLogEntry[];
  nextSeq: number;
}

/** Error raised when a log operation fails. */
export class LogJournalError extends Error {
  constructor(message: string, readonly code: string = "E-LOG-JOURNAL") {
    super(message);
    this.name = "LogJournalError";
  }
}

/** Internal state tracked for a log bucket. */
interface LogBucketState {
  entries: CorrelatedLogEntry[];
  lastSeq: number;
  writeQueue: Promise<void>;
  bytesWritten: number;
  writerReady: boolean;
  readonly filePath: string;
}

/** Constants controlling memory usage and rotation defaults. */
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB keeps artefacts small.
const DEFAULT_MAX_FILE_COUNT = 5;

/** Ensures a string bucket identifier is safe to use within file paths. */
function sanitiseBucketId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.length) {
    return "default";
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "-");
  return safe.slice(0, 120) || "default";
}

/** Resolve the base directory for a given stream. */
function resolveStreamDir(rootDir: string, stream: LogStream): string {
  switch (stream) {
    case "server":
      return join(rootDir, "server");
    case "run":
      return join(rootDir, "runs");
    case "child":
      return join(rootDir, "children");
    default:
      return rootDir;
  }
}

/** Creates the JSONL file path for a bucket. */
function resolveBucketPath(rootDir: string, stream: LogStream, bucketId: string): string {
  const baseDir = resolveStreamDir(rootDir, stream);
  const safeId = sanitiseBucketId(bucketId);
  return join(baseDir, `${safeId}.jsonl`);
}

/**
 * Maintains correlated log entries for the orchestrator. Entries are preserved in memory for fast
 * access and mirrored to JSONL artefacts with size-based rotation.
 */
export class LogJournal {
  private readonly rootDir: string;
  private readonly maxEntries: number;
  private readonly maxFileSize: number;
  private readonly maxFileCount: number;
  private readonly buckets = new Map<string, LogBucketState>();

  constructor(options: LogJournalOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxEntries = Math.max(1, options.maxEntriesPerBucket ?? DEFAULT_MAX_ENTRIES);
    this.maxFileSize = Math.max(64 * 1024, options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE);
    this.maxFileCount = Math.max(1, options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT);
  }

  /** Clears all in-memory entries and resets sequence counters. */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Records a new correlated entry. The write is synchronous from the caller perspective while file
   * persistence is enqueued to guarantee ordering without blocking orchestrator hot paths.
   */
  record(input: LogRecordInput): CorrelatedLogEntry {
    const bucketId = input.bucketId?.trim() && input.bucketId.trim().length > 0 ? input.bucketId.trim() : "orchestrator";
    const key = this.buildBucketKey(input.stream, bucketId);
    const state = this.getOrCreateBucket(input.stream, bucketId, key);

    const seq = input.seq && input.seq > state.lastSeq ? input.seq : state.lastSeq + 1;
    state.lastSeq = Math.max(state.lastSeq, seq);

    const ts = typeof input.ts === "number" && Number.isFinite(input.ts) ? Math.floor(input.ts) : Date.now();
    const entry: CorrelatedLogEntry = {
      seq,
      ts,
      stream: input.stream,
      bucketId,
      level: input.level,
      message: input.message,
      data: input.data,
      jobId: input.jobId ?? null,
      runId: input.runId ?? null,
      opId: input.opId ?? null,
      graphId: input.graphId ?? null,
      nodeId: input.nodeId ?? null,
      childId: input.childId ?? null,
    };

    state.entries.push(entry);
    if (state.entries.length > this.maxEntries) {
      state.entries.splice(0, state.entries.length - this.maxEntries);
    }

    state.writeQueue = state.writeQueue
      .then(() => this.appendToFile(state, entry))
      .catch(() => {
        // Reset the queue so subsequent writes are not blocked by transient errors.
        state.writeQueue = Promise.resolve();
      });

    this.buckets.set(key, state);
    return entry;
  }

  /** Retrieves a slice of log entries ordered by their sequence number. */
  tail(input: { stream: LogStream; bucketId?: string | null; fromSeq?: number; limit?: number }): LogTailResult {
    const bucketId = input.bucketId?.trim() && input.bucketId.trim().length > 0 ? input.bucketId.trim() : "orchestrator";
    const key = this.buildBucketKey(input.stream, bucketId);
    const state = this.buckets.get(key);
    if (!state) {
      return { entries: [], nextSeq: 0 };
    }

    const fromSeq = typeof input.fromSeq === "number" && input.fromSeq >= 0 ? input.fromSeq : 0;
    const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), this.maxEntries) : this.maxEntries;

    const filtered = state.entries.filter((entry) => entry.seq > fromSeq);
    const ordered = filtered.sort((a, b) => a.seq - b.seq).slice(0, limit);
    const nextSeq = ordered.length ? ordered[ordered.length - 1].seq : state.lastSeq;
    return { entries: ordered, nextSeq };
  }

  /** Waits for all pending file writes to complete. */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.writeQueue));
  }

  private buildBucketKey(stream: LogStream, bucketId: string): string {
    return `${stream}:${bucketId}`;
  }

  private getOrCreateBucket(stream: LogStream, bucketId: string, key: string): LogBucketState {
    const existing = this.buckets.get(key);
    if (existing) {
      return existing;
    }
    const filePath = resolveBucketPath(this.rootDir, stream, bucketId);
    return {
      entries: [],
      lastSeq: 0,
      writeQueue: Promise.resolve(),
      bytesWritten: 0,
      writerReady: false,
      filePath,
    };
  }

  private async appendToFile(state: LogBucketState, entry: CorrelatedLogEntry): Promise<void> {
    try {
      if (!state.writerReady) {
        await this.ensureWriter(state);
      }
      const line = `${JSON.stringify(entry)}\n`;
      await this.rotateIfNeeded(state, Buffer.byteLength(line, "utf8"));
      await appendFile(state.filePath, line, "utf8");
      state.bytesWritten += Buffer.byteLength(line, "utf8");
    } catch (error) {
      // On persistence failure, attempt to reset the bucket so future writes can retry.
      state.writerReady = false;
      state.bytesWritten = 0;
      throw new LogJournalError(
        error instanceof Error ? error.message : `log_persist_failed:${String(error)}`,
        "E-LOG-WRITE",
      );
    }
  }

  private async ensureWriter(state: LogBucketState): Promise<void> {
    const directory = dirname(state.filePath);
    await mkdir(directory, { recursive: true });
    try {
      const stats = await stat(state.filePath);
      state.bytesWritten = stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state.bytesWritten = 0;
      } else {
        throw error;
      }
    }
    state.writerReady = true;
  }

  private async rotateIfNeeded(state: LogBucketState, nextWriteBytes: number): Promise<void> {
    if (state.bytesWritten + nextWriteBytes <= this.maxFileSize) {
      return;
    }
    await this.rotateFiles(state.filePath);
    state.bytesWritten = 0;
  }

  private async rotateFiles(target: string): Promise<void> {
    const directory = dirname(target);
    await mkdir(directory, { recursive: true });
    // Remove the oldest file if needed so rotation can proceed.
    const oldest = `${target}.${this.maxFileCount}`;
    try {
      await rm(oldest, { force: true });
    } catch {
      // Ignore removal errors: the file may not exist on the first rotations.
    }

    for (let index = this.maxFileCount - 1; index >= 1; index -= 1) {
      const source = `${target}.${index}`;
      const destination = `${target}.${index + 1}`;
      try {
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    try {
      await rename(target, `${target}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
