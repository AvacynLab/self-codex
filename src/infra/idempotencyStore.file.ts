import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { IdempotencyStore, PersistedIdempotencyEntry } from "./idempotencyStore.js";
import { resolveIdempotencyDirectory } from "./idempotencyStore.js";

/** Options accepted when creating a {@link FileIdempotencyStore}. */
export interface FileIdempotencyStoreOptions {
  /** Directory containing the JSONL ledger. Defaults to `runs/idempotency`. */
  directory?: string;
  /** Name of the JSONL file storing the ledger. Defaults to `index.jsonl`. */
  fileName?: string;
  /** Override the clock primarily for unit tests. */
  clock?: () => number;
}

/** Internal entry format retained in memory. */
interface InMemoryEntry {
  status: number;
  body: string;
  exp: number;
}

/** Default TTL (10 minutes) mirroring the in-memory registry. */
const DEFAULT_TTL_MS = 600_000;

/**
 * Persistent idempotency store backed by a JSON Lines ledger on disk. The store
 * keeps a compact in-memory index for quick lookups and appends immutable
 * records for each completed request. Periodic compaction rewrites the ledger
 * with the surviving entries so storage stays bounded.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly filePath: string;
  private readonly clock: () => number;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, clock: () => number) {
    this.filePath = filePath;
    this.clock = clock;
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
    const store = new FileIdempotencyStore(filePath, options.clock ?? (() => Date.now()));
    await store.loadFromDisk();
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
      return null;
    }
    return { status: entry.status, body: entry.body };
  }

  /** Stores or refreshes a response snapshot. */
  public async set(key: string, status: number, body: string, ttlMs: number): Promise<void> {
    const ttl = this.normaliseTtl(ttlMs);
    const expiresAt = this.clock() + ttl;
    this.entries.set(key, { status, body, exp: expiresAt });
    const record: PersistedIdempotencyEntry = { key, status, body, exp: expiresAt };
    await this.enqueue(async () => {
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
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
      }
    }

    const lines: string[] = [];
    for (const [key, entry] of this.entries) {
      const record: PersistedIdempotencyEntry = { key, status: entry.status, body: entry.body, exp: entry.exp };
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
        this.entries.set(parsed.key, { status: parsed.status, body, exp: parsed.exp });
      } catch {
        // Ignore malformed lines so a single bad entry does not poison the cache.
        continue;
      }
    }
  }

  private normaliseTtl(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return DEFAULT_TTL_MS;
    }
    return Math.max(1, Math.floor(ttlMs));
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
