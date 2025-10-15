import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  IdempotencyConflictError,
  type IdempotencyStore,
  type PersistedIdempotencyEntry,
  resolveIdempotencyDirectory,
} from "./idempotencyStore.js";

/** Options accepted when creating a {@link FileIdempotencyStore}. */
export interface FileIdempotencyStoreOptions {
  /** Directory containing the JSONL ledger. Defaults to `runs/idempotency`. */
  directory?: string;
  /** Name of the JSONL file storing the ledger. Defaults to `index.jsonl`. */
  fileName?: string;
  /** Override the clock primarily for unit tests. */
  clock?: () => number;
  /** Default TTL used when callers provide invalid values. */
  defaultTtlMs?: number;
  /** Number of live entries tolerated before scheduling a compaction pass. */
  maxEntriesBeforeCompaction?: number;
}

/** Internal entry format retained in memory. */
interface InMemoryEntry {
  status: number;
  body: string;
  exp: number;
}

/** Default TTL (10 minutes) mirroring the in-memory registry. */
const DEFAULT_TTL_MS = 600_000;
/** Default compaction threshold keeping the ledger reasonably small. */
const DEFAULT_COMPACTION_THRESHOLD = 2_000;
/** Number of hexadecimal characters produced by a SHA-256 digest. */
const SHA256_HEX_LENGTH = 64;
/** Suffix appended to the JSONL ledger file to create the offset index sidecar. */
const INDEX_SUFFIX = ".idx";

/** Lightweight description of where a cached entry resides in the ledger. */
interface OffsetRecord {
  offset: number;
  length: number;
}

interface CacheKeyMetadata {
  method: string;
  idempotencyKey: string;
  fingerprint: string;
  methodKey: string;
}

/**
 * Persistent idempotency store backed by a JSON Lines ledger on disk. The store
 * keeps a compact in-memory index for quick lookups, mirrors the offsets in a
 * sidecar file so restarts can hydrate efficiently, and appends immutable
 * records for each completed request. Periodic compaction rewrites the ledger
 * with the surviving entries so storage stays bounded.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly cacheMetadata = new Map<string, CacheKeyMetadata>();
  private readonly methodKeyIndex = new Map<string, { fingerprint: string; cacheKey: string }>();
  private readonly filePath: string;
  private readonly indexFilePath: string;
  private readonly clock: () => number;
  private readonly defaultTtlMs: number;
  private readonly compactionThreshold: number;
  private readonly offsetIndex = new Map<string, OffsetRecord>();
  private writeQueue: Promise<void> = Promise.resolve();
  private compactionPromise: Promise<void> | null = null;
  private entriesSinceCompaction = 0;
  private ledgerSize = 0;

  private constructor(
    filePath: string,
    indexFilePath: string,
    clock: () => number,
    defaultTtlMs: number,
    compactionThreshold: number,
  ) {
    this.filePath = filePath;
    this.indexFilePath = indexFilePath;
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs > 0 ? defaultTtlMs : DEFAULT_TTL_MS;
    this.compactionThreshold = compactionThreshold >= 0 ? compactionThreshold : DEFAULT_COMPACTION_THRESHOLD;
  }

  /**
   * Instantiates the store by replaying the JSONL ledger into memory. The
   * method ensures the storage directory exists so callers can interact with the
   * instance immediately after awaiting the returned promise.
   */
  public static async create(options: FileIdempotencyStoreOptions = {}): Promise<FileIdempotencyStore> {
    const directory = options.directory ?? resolveIdempotencyDirectory();
    await mkdir(directory, { recursive: true });
    const fileName = options.fileName ?? "index.jsonl";
    const filePath = resolvePath(directory, fileName);
    const indexFilePath = resolvePath(directory, `${fileName}${INDEX_SUFFIX}`);
    const clock = options.clock ?? (() => Date.now());
    const defaultTtl = normalisePositiveInteger(options.defaultTtlMs, DEFAULT_TTL_MS);
    const compactionThreshold = normaliseThreshold(options.maxEntriesBeforeCompaction);
    const store = new FileIdempotencyStore(filePath, indexFilePath, clock, defaultTtl, compactionThreshold);
    await store.loadFromDisk();
    store.entriesSinceCompaction = store.entries.size;
    if (store.entries.size >= store.compactionThreshold && store.compactionThreshold > 0) {
      store.scheduleCompaction();
    }
    return store;
  }

  /** Retrieves a cached response when it is still valid. */
  public async get(key: string): Promise<{ status: number; body: string } | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    const now = this.clock();
    if (entry.exp <= now) {
      this.entries.delete(key);
      this.dropFingerprintForKey(key);
      return null;
    }
    return { status: entry.status, body: entry.body };
  }

  /** Stores or refreshes a response snapshot. */
  public async set(key: string, status: number, body: string, ttlMs: number): Promise<void> {
    const ttl = this.normaliseTtl(ttlMs);
    const expiresAt = this.clock() + ttl;
    const metadata = this.registerMetadata(key);
    const existing = this.entries.get(key);
    if (existing && (existing.status !== status || existing.body !== body)) {
      throw new IdempotencyConflictError(metadata.method, metadata.idempotencyKey);
    }

    this.entries.set(key, { status, body, exp: expiresAt });
    try {
      await this.enqueue(async () => {
        const record: PersistedIdempotencyEntry = {
          key,
          status,
          body,
          exp: expiresAt,
          meta: { fingerprint: metadata.fingerprint },
        };
        const serialised = `${JSON.stringify(record)}\n`;
        const length = Buffer.byteLength(serialised, "utf8");
        const offset = await this.ensureLedgerSize();
        await appendFile(this.filePath, serialised, "utf8");
        this.ledgerSize += length;
        this.offsetIndex.set(key, { offset, length });
        await this.writeIndexSnapshotLocked();
      });
    } catch (error) {
      this.entries.delete(key);
      this.dropFingerprintForKey(key);
      throw error;
    }

    this.entriesSinceCompaction += 1;
    this.maybeScheduleCompaction();
  }

  /**
   * Compacts the ledger by removing expired entries and rewriting the file with
   * the surviving records. The method can be invoked periodically by
   * housekeeping routines.
   */
  public async purge(now: number = this.clock()): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.exp <= now) {
        this.entries.delete(key);
        this.dropFingerprintForKey(key);
      }
    }

    const survivors: Array<{ key: string; entry: InMemoryEntry; metadata: CacheKeyMetadata }> = [];
    for (const [key, entry] of this.entries) {
      const metadata = this.cacheMetadata.get(key) ?? extractCacheKeyMetadata(key);
      survivors.push({ key, entry, metadata });
    }

    await this.enqueue(async () => {
      if (survivors.length === 0) {
        this.offsetIndex.clear();
        this.ledgerSize = 0;
        await writeFile(this.filePath, "", "utf8");
        await writeFile(this.indexFilePath, "", "utf8");
        return;
      }

      const ledgerLines: string[] = [];
      this.offsetIndex.clear();
      let offset = 0;
      for (const { key, entry, metadata } of survivors) {
        const record: PersistedIdempotencyEntry = {
          key,
          status: entry.status,
          body: entry.body,
          exp: entry.exp,
          meta: { fingerprint: metadata.fingerprint },
        };
        const serialised = `${JSON.stringify(record)}\n`;
        ledgerLines.push(serialised);
        const length = Buffer.byteLength(serialised, "utf8");
        this.offsetIndex.set(key, { offset, length });
        offset += length;
      }

      this.ledgerSize = offset;
      await writeFile(this.filePath, ledgerLines.join(""), "utf8");
      await this.writeIndexSnapshotLocked();
    });
  }

  /**
   * Lightweight readiness probe ensuring the ledger remains writable. The
   * implementation piggybacks on the write queue so concurrent appends are
   * preserved while the health check verifies filesystem availability.
   */
  public async checkHealth(): Promise<void> {
    await this.enqueue(async () => {
      await appendFile(this.filePath, "", "utf8");
    });
  }

  /** Ensures callers do not reuse an idempotency key with a different payload. */
  public assertKeySemantics(cacheKey: string): void {
    this.ensureConsistentFingerprint(cacheKey);
  }

  /** Replays existing JSONL entries into the in-memory index. */
  private async loadFromDisk(): Promise<void> {
    let buffer: Buffer;
    try {
      buffer = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(this.filePath, "", "utf8");
        await writeFile(this.indexFilePath, "", "utf8");
        return;
      }
      throw error;
    }

    this.offsetIndex.clear();
    this.ledgerSize = buffer.length;
    const now = this.clock();
    let offset = 0;
    while (offset < buffer.length) {
      const newlineIndex = buffer.indexOf(0x0a, offset);
      const lineEnd = newlineIndex === -1 ? buffer.length : newlineIndex;
      const lineBuffer = buffer.subarray(offset, lineEnd);
      const nextOffset = newlineIndex === -1 ? buffer.length : lineEnd + 1;
      if (lineBuffer.length === 0) {
        offset = nextOffset;
        continue;
      }
      try {
        const parsed = JSON.parse(lineBuffer.toString("utf8")) as PersistedIdempotencyEntry;
        if (typeof parsed.key !== "string" || typeof parsed.status !== "number" || typeof parsed.exp !== "number") {
          continue;
        }
        if (parsed.exp <= now) {
          continue;
        }
        const body = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body);
        try {
          const metadata = this.registerMetadata(
            parsed.key,
            typeof (parsed.meta as { fingerprint?: unknown } | undefined)?.fingerprint === "string"
              ? ((parsed.meta as { fingerprint?: string }).fingerprint as string)
              : undefined,
          );
          this.entries.set(parsed.key, { status: parsed.status, body, exp: parsed.exp });
          this.cacheMetadata.set(parsed.key, metadata);
          const length = lineBuffer.length + (newlineIndex === -1 ? 0 : 1);
          this.offsetIndex.set(parsed.key, { offset, length });
        } catch (error) {
          if (error instanceof IdempotencyConflictError) {
            // Skip conflicting legacy entries while keeping the oldest payload.
            continue;
          }
          throw error;
        }
      } catch {
        // Ignore malformed lines so a single bad entry does not poison the cache.
        continue;
      }
      offset = nextOffset;
    }

    await this.writeIndexSnapshotLocked();
  }

  private normaliseTtl(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return this.defaultTtlMs;
    }
    return Math.max(1, Math.floor(ttlMs));
  }

  private ensureConsistentFingerprint(cacheKey: string): CacheKeyMetadata {
    const metadata = extractCacheKeyMetadata(cacheKey);
    const existing = this.methodKeyIndex.get(metadata.methodKey);
    if (existing && existing.fingerprint !== metadata.fingerprint) {
      throw new IdempotencyConflictError(metadata.method, metadata.idempotencyKey);
    }
    return metadata;
  }

  private registerMetadata(cacheKey: string, fingerprintOverride?: string): CacheKeyMetadata {
    const metadata = extractCacheKeyMetadata(cacheKey, fingerprintOverride);
    const existing = this.methodKeyIndex.get(metadata.methodKey);
    if (existing && existing.fingerprint !== metadata.fingerprint) {
      throw new IdempotencyConflictError(metadata.method, metadata.idempotencyKey);
    }
    this.methodKeyIndex.set(metadata.methodKey, { fingerprint: metadata.fingerprint, cacheKey });
    this.cacheMetadata.set(cacheKey, metadata);
    return metadata;
  }

  private dropFingerprintForKey(cacheKey: string): void {
    const metadata = this.cacheMetadata.get(cacheKey);
    if (!metadata) {
      return;
    }
    this.cacheMetadata.delete(cacheKey);
    const existing = this.methodKeyIndex.get(metadata.methodKey);
    if (existing && existing.cacheKey === cacheKey) {
      this.methodKeyIndex.delete(metadata.methodKey);
    }
    this.offsetIndex.delete(cacheKey);
  }

  private maybeScheduleCompaction(): void {
    if (this.compactionThreshold <= 0) {
      return;
    }
    if (this.entriesSinceCompaction < this.compactionThreshold) {
      return;
    }
    if (this.compactionPromise) {
      return;
    }
    this.scheduleCompaction();
  }

  private scheduleCompaction(): void {
    const pending = this.purge(this.clock());
    this.compactionPromise = pending
      .catch(() => {
        // Errors are surfaced to callers via the returned promise.
      })
      .finally(() => {
        this.compactionPromise = null;
        this.entriesSinceCompaction = 0;
      });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.catch((error) => {
      this.writeQueue = Promise.resolve();
      throw error;
    });
    return run;
  }

  /**
   * Persists the current offset index to the sidecar file, ensuring restarts can
   * rebuild the in-memory ledger without scanning the entire JSONL payload.
   * Callers must run this method while holding the write queue lock.
   */
  private async writeIndexSnapshotLocked(): Promise<void> {
    const lines: string[] = [];
    for (const [key, location] of this.offsetIndex) {
      if (!this.entries.has(key)) {
        continue;
      }
      lines.push(
        JSON.stringify({
          key,
          offset: location.offset,
          length: location.length,
        }),
      );
    }
    const payload = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    await writeFile(this.indexFilePath, payload, "utf8");
  }

  /**
   * Ensures the cached ledger size is accurate, performing a stat when the
   * current instance was freshly created. Subsequent appends simply update the
   * tracked byte count.
   */
  private async ensureLedgerSize(): Promise<number> {
    if (this.ledgerSize > 0) {
      return this.ledgerSize;
    }
    try {
      const descriptor = await stat(this.filePath);
      this.ledgerSize = descriptor.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.ledgerSize = 0;
      } else {
        throw error;
      }
    }
    return this.ledgerSize;
  }
}

function extractCacheKeyMetadata(cacheKey: string, fingerprintOverride?: string): CacheKeyMetadata {
  const trimmed = cacheKey.trim();
  if (trimmed.length === 0) {
    return { method: "unknown", idempotencyKey: "", fingerprint: "", methodKey: "unknown:" };
  }

  const fingerprint =
    typeof fingerprintOverride === "string" && fingerprintOverride.length === SHA256_HEX_LENGTH
      ? fingerprintOverride
      : trimmed.slice(-SHA256_HEX_LENGTH);
  const hasStructuredSegments = trimmed.length > SHA256_HEX_LENGTH + 1;
  if (!hasStructuredSegments) {
    const method = "unknown";
    const idempotencyKey = trimmed;
    const methodKey = `${method}:${idempotencyKey}`;
    return { method, idempotencyKey, fingerprint, methodKey };
  }

  const prefix = trimmed.slice(0, Math.max(0, trimmed.length - SHA256_HEX_LENGTH - 1));
  const separatorIndex = prefix.indexOf(":");
  const method = separatorIndex === -1 ? "unknown" : prefix.slice(0, separatorIndex);
  const idempotencyKey = separatorIndex === -1 ? prefix : prefix.slice(separatorIndex + 1);
  const methodKey = `${method}:${idempotencyKey}`;
  return { method, idempotencyKey, fingerprint, methodKey };
}

function normalisePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normaliseThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_COMPACTION_THRESHOLD;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
