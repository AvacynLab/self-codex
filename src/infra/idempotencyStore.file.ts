import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

interface CacheKeyMetadata {
  method: string;
  idempotencyKey: string;
  fingerprint: string;
  methodKey: string;
}

/**
 * Persistent idempotency store backed by a JSON Lines ledger on disk. The store
 * keeps a compact in-memory index for quick lookups and appends immutable
 * records for each completed request. Periodic compaction rewrites the ledger
 * with the surviving entries so storage stays bounded.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly cacheMetadata = new Map<string, CacheKeyMetadata>();
  private readonly methodKeyIndex = new Map<string, { fingerprint: string; cacheKey: string }>();
  private readonly filePath: string;
  private readonly clock: () => number;
  private readonly defaultTtlMs: number;
  private readonly compactionThreshold: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private compactionPromise: Promise<void> | null = null;
  private entriesSinceCompaction = 0;

  private constructor(filePath: string, clock: () => number, defaultTtlMs: number, compactionThreshold: number) {
    this.filePath = filePath;
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
    const clock = options.clock ?? (() => Date.now());
    const defaultTtl = normalisePositiveInteger(options.defaultTtlMs, DEFAULT_TTL_MS);
    const compactionThreshold = normaliseThreshold(options.maxEntriesBeforeCompaction);
    const store = new FileIdempotencyStore(filePath, clock, defaultTtl, compactionThreshold);
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
        await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
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

    const lines: string[] = [];
    for (const [key, entry] of this.entries) {
      const metadata = this.cacheMetadata.get(key) ?? extractCacheKeyMetadata(key);
      const record: PersistedIdempotencyEntry = {
        key,
        status: entry.status,
        body: entry.body,
        exp: entry.exp,
        meta: { fingerprint: metadata.fingerprint },
      };
      lines.push(JSON.stringify(record));
    }

    await this.enqueue(async () => {
      if (lines.length === 0) {
        await writeFile(this.filePath, "", "utf8");
        return;
      }
      await writeFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
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
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(this.filePath, "", "utf8");
        return;
      }
      throw error;
    }

    const now = this.clock();
    const lines = contents.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw || raw.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as PersistedIdempotencyEntry;
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
    }
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
