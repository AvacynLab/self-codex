import { appendFile, mkdir, rename, rm, stat } from "fs/promises";
import { Buffer } from "buffer";
import { dirname, resolve } from "path";
import type { ErrnoException } from "../nodePrimitives.js";

import { resolveWithin } from "../paths.js";

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
  /** Component that emitted the log entry (scheduler, plan_executor, ...). */
  component: string;
  /** Lifecycle stage associated with the log entry. */
  stage: string;
  /** Optional duration associated with the log entry. */
  elapsedMs?: number | null;
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
  component?: string | null;
  stage?: string | null;
  elapsedMs?: number | null;
}

/** Result returned by {@link LogJournal.tail}. */
export interface LogTailResult {
  entries: CorrelatedLogEntry[];
  nextSeq: number;
}

/**
 * Optional correlated filters restricting the set of identifiers and
 * timestamps that must be matched for an entry to be included in a tail
 * request.
 */
export interface LogTailFilters {
  readonly runIds?: readonly string[];
  readonly jobIds?: readonly string[];
  readonly opIds?: readonly string[];
  readonly graphIds?: readonly string[];
  readonly nodeIds?: readonly string[];
  readonly childIds?: readonly string[];
  readonly components?: readonly string[];
  readonly stages?: readonly string[];
  readonly minElapsedMs?: number;
  readonly maxElapsedMs?: number;
  /** Case-insensitive substrings that must be present in the log message. */
  readonly messageIncludes?: readonly string[];
  /** Inclusive lower bound applied to entry timestamps. */
  readonly sinceTs?: number;
  /** Inclusive upper bound applied to entry timestamps. */
  readonly untilTs?: number;
}

interface NormalisedTailFilters {
  readonly runIds?: Set<string>;
  readonly jobIds?: Set<string>;
  readonly opIds?: Set<string>;
  readonly graphIds?: Set<string>;
  readonly nodeIds?: Set<string>;
  readonly childIds?: Set<string>;
  readonly components?: Set<string>;
  readonly stages?: Set<string>;
  readonly minElapsedMs?: number;
  readonly maxElapsedMs?: number;
  readonly messageIncludes?: readonly string[];
  readonly sinceTs?: number;
  readonly untilTs?: number;
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
      return resolveWithin(rootDir, "server");
    case "run":
      return resolveWithin(rootDir, "runs");
    case "child":
      return resolveWithin(rootDir, "children");
    default:
      return resolveWithin(rootDir, stream);
  }
}

/** Normalises optional textual tags to non-empty strings when possible. */
function normaliseTag(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Maps log streams to their default orchestrator component identifier. */
function inferDefaultComponent(stream: LogStream): string {
  switch (stream) {
    case "run":
      return "run";
    case "child":
      return "child";
    default:
      return "server";
  }
}

/** Normalises optional duration values expressed in milliseconds. */
function normaliseElapsed(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  return Math.round(value);
}

/**
 * Creates the JSONL file path for a bucket while delegating sandbox enforcement to
 * {@link resolveWithin}. This guarantees that even crafted bucket identifiers remain
 * confined to the configured journal root and cannot traverse upwards.
 */
function resolveBucketPath(rootDir: string, stream: LogStream, bucketId: string): string {
  const baseDir = resolveStreamDir(rootDir, stream);
  const safeId = sanitiseBucketId(bucketId);
  return resolveWithin(baseDir, `${safeId}.jsonl`);
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
    const component = normaliseTag(input.component ?? null) ?? inferDefaultComponent(input.stream);
    const stage = normaliseTag(input.stage ?? input.message) ?? input.message;
    const elapsedMs = normaliseElapsed(input.elapsedMs ?? null);
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
      component,
      stage,
      elapsedMs,
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

  /**
   * Retrieves a slice of log entries ordered by their sequence number.
   *
   * The helper also supports optional severity and correlation filters so
   * callers can focus on the most relevant entries without having to
   * post-process the entire page. Filters include timestamp windows that are
   * applied in-memory before pagination to keep slices deterministic. Severity
   * comparisons remain case-insensitive to align with the structured logger.
   */
  tail(input: {
    stream: LogStream;
    bucketId?: string | null;
    fromSeq?: number;
    limit?: number;
    levels?: readonly string[] | null;
    filters?: LogTailFilters | null;
  }): LogTailResult {
    const bucketId = input.bucketId?.trim() && input.bucketId.trim().length > 0 ? input.bucketId.trim() : "orchestrator";
    const key = this.buildBucketKey(input.stream, bucketId);
    const state = this.buckets.get(key);
    if (!state) {
      return { entries: [], nextSeq: 0 };
    }

    const fromSeq = typeof input.fromSeq === "number" && input.fromSeq >= 0 ? input.fromSeq : 0;
    const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), this.maxEntries) : this.maxEntries;

    const levelSet = Array.isArray(input.levels) && input.levels.length > 0
      ? new Set(input.levels.map((level) => level.toLowerCase()))
      : null;

    const filterSets = this.normaliseTailFilters(input.filters);

    const filtered = state.entries.filter((entry) => {
      if (entry.seq <= fromSeq) {
        return false;
      }
      if (levelSet && !levelSet.has(entry.level.toLowerCase())) {
        return false;
      }
      if (filterSets?.messageIncludes && filterSets.messageIncludes.length > 0) {
        const message = entry.message.toLowerCase();
        for (const needle of filterSets.messageIncludes) {
          if (!message.includes(needle)) {
            return false;
          }
        }
      }
      if (filterSets?.sinceTs !== undefined && entry.ts < filterSets.sinceTs) {
        return false;
      }
      if (filterSets?.untilTs !== undefined && entry.ts > filterSets.untilTs) {
        return false;
      }
      if (filterSets?.runIds && (!entry.runId || !filterSets.runIds.has(entry.runId))) {
        return false;
      }
      if (filterSets?.jobIds && (!entry.jobId || !filterSets.jobIds.has(entry.jobId))) {
        return false;
      }
      if (filterSets?.opIds && (!entry.opId || !filterSets.opIds.has(entry.opId))) {
        return false;
      }
      if (filterSets?.graphIds && (!entry.graphId || !filterSets.graphIds.has(entry.graphId))) {
        return false;
      }
      if (filterSets?.nodeIds && (!entry.nodeId || !filterSets.nodeIds.has(entry.nodeId))) {
        return false;
      }
      if (filterSets?.childIds && (!entry.childId || !filterSets.childIds.has(entry.childId))) {
        return false;
      }
      if (filterSets?.components && !filterSets.components.has(entry.component)) {
        return false;
      }
      if (filterSets?.stages && !filterSets.stages.has(entry.stage)) {
        return false;
      }
      if (filterSets?.minElapsedMs !== undefined) {
        const elapsed = entry.elapsedMs ?? null;
        if (elapsed === null || elapsed < filterSets.minElapsedMs) {
          return false;
        }
      }
      if (filterSets?.maxElapsedMs !== undefined) {
        const elapsed = entry.elapsedMs ?? null;
        if (elapsed === null || elapsed > filterSets.maxElapsedMs) {
          return false;
        }
      }
      return true;
    });
    const ordered = filtered.sort((a, b) => a.seq - b.seq).slice(0, limit);
    const nextSeq = ordered.length ? ordered[ordered.length - 1].seq : state.lastSeq;
    return { entries: ordered, nextSeq };
  }

  /** Waits for all pending file writes to complete. */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.writeQueue));
  }

  /**
   * Normalises identifier filters so membership checks remain efficient while
   * ignoring empty or whitespace-only entries supplied by callers.
   */
  private normaliseTailFilters(filters?: LogTailFilters | null): NormalisedTailFilters | null {
    if (!filters) {
      return null;
    }
    const toSet = (values?: readonly string[]) => {
      if (!values || values.length === 0) {
        return null;
      }
      const collected = new Set<string>();
      for (const value of values) {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          collected.add(trimmed);
        }
      }
      return collected.size > 0 ? collected : null;
    };

    const runIds = toSet(filters.runIds);
    const jobIds = toSet(filters.jobIds);
    const opIds = toSet(filters.opIds);
    const graphIds = toSet(filters.graphIds);
    const nodeIds = toSet(filters.nodeIds);
    const childIds = toSet(filters.childIds);
    const components = toSet(filters.components);
    const stages = toSet(filters.stages);
    const messageIncludes = this.normaliseMessageNeedles(filters.messageIncludes);
    const minElapsedMs =
      typeof filters.minElapsedMs === "number" && Number.isFinite(filters.minElapsedMs) && filters.minElapsedMs >= 0
        ? Math.floor(filters.minElapsedMs)
        : undefined;
    const maxElapsedMs =
      typeof filters.maxElapsedMs === "number" && Number.isFinite(filters.maxElapsedMs) && filters.maxElapsedMs >= 0
        ? Math.floor(filters.maxElapsedMs)
        : undefined;
    const sinceTs =
      typeof filters.sinceTs === "number" && Number.isFinite(filters.sinceTs) && filters.sinceTs >= 0
        ? Math.floor(filters.sinceTs)
        : undefined;
    const untilTs =
      typeof filters.untilTs === "number" && Number.isFinite(filters.untilTs) && filters.untilTs >= 0
        ? Math.floor(filters.untilTs)
        : undefined;

    if (
      !runIds &&
      !jobIds &&
      !opIds &&
      !graphIds &&
      !nodeIds &&
      !childIds &&
      !components &&
      !stages &&
      minElapsedMs === undefined &&
      maxElapsedMs === undefined &&
      !messageIncludes &&
      sinceTs === undefined &&
      untilTs === undefined
    ) {
      return null;
    }

    return {
      ...(runIds ? { runIds } : null),
      ...(jobIds ? { jobIds } : null),
      ...(opIds ? { opIds } : null),
      ...(graphIds ? { graphIds } : null),
      ...(nodeIds ? { nodeIds } : null),
      ...(childIds ? { childIds } : null),
      ...(components ? { components } : null),
      ...(stages ? { stages } : null),
      ...(minElapsedMs !== undefined ? { minElapsedMs } : null),
      ...(maxElapsedMs !== undefined ? { maxElapsedMs } : null),
      ...(messageIncludes ? { messageIncludes } : null),
      ...(sinceTs !== undefined ? { sinceTs } : null),
      ...(untilTs !== undefined ? { untilTs } : null),
    };
  }

  /**
   * Normalises message substring filters so comparisons stay case-insensitive
   * while preserving caller intent order for deterministic assertions.
   */
  private normaliseMessageNeedles(values?: readonly string[] | null): readonly string[] | null {
    if (!values || values.length === 0) {
      return null;
    }
    const seen = new Set<string>();
    const needles: string[] = [];
    for (const value of values) {
      const trimmed = value.trim().toLowerCase();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      needles.push(trimmed);
    }
    return needles.length > 0 ? needles : null;
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
      if ((error as ErrnoException).code === "ENOENT") {
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
        if ((error as ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    try {
      await rename(target, `${target}.1`);
    } catch (error) {
      if ((error as ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
