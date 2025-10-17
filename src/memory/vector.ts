import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { safePath } from "../gateways/fsArtifacts.js";
import { normaliseProvenanceList, type Provenance } from "../types/provenance.js";

/** Normalised representation of a single vectorised memory document. */
export interface VectorMemoryDocument {
  /** Stable identifier assigned when the document is persisted. */
  id: string;
  /** Raw textual content indexed by the orchestrator. */
  text: string;
  /** Optional set of semantic tags applied by the caller. */
  tags: string[];
  /** Arbitrary metadata forwarded to downstream consumers. */
  metadata: Record<string, unknown>;
  /** Structured provenance pointing at the artefacts backing the document. */
  provenance: Provenance[];
  /** Timestamp (epoch milliseconds) captured when the entry was created. */
  createdAt: number;
  /** Timestamp (epoch milliseconds) captured when the entry was last updated. */
  updatedAt: number;
  /** Deterministic token frequency vector used when ranking results. */
  embedding: Record<string, number>;
  /** Pre-computed Euclidean norm of {@link embedding}. */
  norm: number;
  /** Total number of tokens extracted from {@link text}. */
  tokenCount: number;
}

/**
 * Configuration accepted by {@link VectorMemoryIndex}. The defaults favour
 * compact indexes so the orchestrator can ship with predictable resource usage
 * even on ephemeral runners.
 */
export interface VectorMemoryIndexOptions {
  /** Directory where the persistent index should be stored. */
  directory: string;
  /** Maximum number of documents kept in memory. Oldest entries are evicted. */
  maxDocuments?: number;
  /** Optional override for the JSON file name (defaults to `index.json`). */
  fileName?: string;
  /** Optional clock used by tests to inject deterministic timestamps. */
  now?: () => number;
}

/** Input payload accepted when storing a new vector document. */
export interface VectorDocumentInput {
  id?: string;
  text: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  provenance?: ReadonlyArray<Provenance | null | undefined>;
  createdAt?: number;
}

/** Options accepted when querying the vector index. */
export interface VectorSearchOptions {
  limit?: number;
  minScore?: number;
}

/** Hit returned when searching the vector index. */
export interface VectorSearchHit {
  document: VectorMemoryDocument;
  score: number;
}

interface SerializedVectorDocument {
  id: string;
  text: string;
  tags: string[];
  metadata: Record<string, unknown>;
  provenance?: Provenance[];
  created_at: number;
  updated_at: number;
  embedding: Record<string, number>;
  norm: number;
  token_count: number;
}

interface VectorDocumentRecord extends VectorMemoryDocument {}

/**
 * Simple JSON-backed vector index used to store long form orchestrator outputs.
 * The implementation intentionally favours determinism over model accuracy: a
 * lightweight token frequency embedding provides predictable scoring while
 * remaining trivial to persist and reload.
 */
export class VectorMemoryIndex {
  private readonly filePath: string;
  private readonly maxDocuments: number;
  private readonly now: () => number;
  private readonly records = new Map<string, VectorDocumentRecord>();

  private constructor(options: VectorMemoryIndexOptions) {
    // Persist the index inside the caller-provided directory while forbidding
    // any traversal via the optional `fileName` override. `safePath` mirrors the
    // artefact gateway guarantees so even crafted filenames ("../index.json")
    // cannot escape the configured directory.
    this.filePath = safePath(options.directory, options.fileName ?? "index.json");
    this.maxDocuments = Math.max(1, options.maxDocuments ?? 512);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Factory creating a vector index and loading any persisted entries from disk.
   * The directory is created lazily to avoid surprising the caller when the
   * feature is disabled in production environments.
   */
  static async create(options: VectorMemoryIndexOptions): Promise<VectorMemoryIndex> {
    await mkdir(options.directory, { recursive: true });
    const index = new VectorMemoryIndex(options);
    await index.loadFromDisk();
    return index;
  }

  /**
   * Synchronous factory mirroring {@link create} but relying on blocking IO.
   * Used by modules that need a fully initialised index during bootstrap.
   */
  static createSync(options: VectorMemoryIndexOptions): VectorMemoryIndex {
    mkdirSync(options.directory, { recursive: true });
    const index = new VectorMemoryIndex(options);
    index.loadFromDiskSync();
    return index;
  }

  /** Returns the number of stored documents. Exposed for tests and metrics. */
  size(): number {
    return this.records.size;
  }

  /**
   * Stores or updates a vector document and persists the index. The helper
   * returns the structured representation so tool handlers can enrich metadata
   * (for instance to link knowledge triples to the stored entry).
   */
  async upsert(input: VectorDocumentInput): Promise<VectorMemoryDocument> {
    const id = input.id ?? randomUUID();
    const timestamp = this.now();
    const tags = normaliseTags(input.tags);
    const text = input.text.trim();
    const metadata = input.metadata ? { ...input.metadata } : {};
    const provenance = normaliseProvenanceList(input.provenance);

    const tokens = tokenise(text);
    const embedding = buildEmbedding(tokens);
    const norm = computeNorm(embedding);

    const existing = this.records.get(id);
    const createdAt = input.createdAt ?? existing?.createdAt ?? timestamp;

    const record: VectorDocumentRecord = {
      id,
      text,
      tags,
      metadata,
      provenance,
      createdAt,
      updatedAt: timestamp,
      embedding,
      norm,
      tokenCount: tokens.length,
    };

    this.records.set(id, record);
    this.enforceCapacity();
    await this.persist();
    return { ...record, metadata: { ...record.metadata }, provenance: [...record.provenance] };
  }

  /** Searches the index using cosine similarity. Results are ranked descending. */
  search(query: string, options: VectorSearchOptions = {}): VectorSearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const tokens = tokenise(trimmed);
    if (tokens.length === 0) {
      return [];
    }

    const embedding = buildEmbedding(tokens);
    const norm = computeNorm(embedding);
    if (norm === 0) {
      return [];
    }

    const limit = Math.max(1, Math.min(options.limit ?? 10, this.records.size || 1));
    const minScore = clampScore(options.minScore ?? 0.1);

    const hits: VectorSearchHit[] = [];
    for (const record of this.records.values()) {
      if (record.norm === 0) {
        continue;
      }
      const score = cosineSimilarity(embedding, norm, record.embedding, record.norm);
      if (score >= minScore) {
        hits.push({
          document: {
            ...record,
            metadata: { ...record.metadata },
            provenance: [...record.provenance],
          },
          score,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || b.document.updatedAt - a.document.updatedAt);
    return hits.slice(0, limit);
  }

  /**
   * Deletes the provided document identifiers from the index. The helper
   * persists the truncated snapshot whenever at least one entry is removed and
   * returns the number of deleted documents so callers can emit accurate
   * telemetry.
   */
  async deleteMany(ids: Iterable<string>): Promise<number> {
    let removed = 0;
    const unique = new Set<string>();
    for (const id of ids) {
      if (typeof id === "string" && id.trim().length > 0) {
        unique.add(id);
      }
    }

    if (unique.size === 0) {
      return 0;
    }

    for (const id of unique) {
      if (this.records.delete(id)) {
        removed += 1;
      }
    }

    if (removed > 0) {
      await this.persist();
    }

    return removed;
  }

  /** Removes every stored document and truncates the on-disk index. */
  async clear(): Promise<void> {
    this.records.clear();
    await this.persist();
  }

  private enforceCapacity(): void {
    if (this.records.size <= this.maxDocuments) {
      return;
    }

    const sorted = Array.from(this.records.values()).sort((a, b) => a.createdAt - b.createdAt);
    const overflow = this.records.size - this.maxDocuments;
    for (let i = 0; i < overflow; i += 1) {
      this.records.delete(sorted[i].id);
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const payload = JSON.parse(raw) as SerializedVectorDocument[];
      this.ingestSerialized(payload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private loadFromDiskSync(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const raw = readFileSync(this.filePath, "utf8");
    const payload = JSON.parse(raw) as SerializedVectorDocument[];
    this.ingestSerialized(payload);
  }

  private ingestSerialized(payload: SerializedVectorDocument[]): void {
    for (const entry of payload) {
      const record: VectorDocumentRecord = {
        id: entry.id,
        text: entry.text,
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
        metadata: entry.metadata ?? {},
        provenance: normaliseProvenanceList(entry.provenance),
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
        embedding: entry.embedding ?? {},
        norm: typeof entry.norm === "number" ? entry.norm : computeNorm(entry.embedding ?? {}),
        tokenCount: entry.token_count ?? 0,
      };
      this.records.set(record.id, record);
    }
  }

  private async persist(): Promise<void> {
    const serialized: SerializedVectorDocument[] = Array.from(this.records.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => ({
        id: record.id,
        text: record.text,
        tags: [...record.tags],
        metadata: { ...record.metadata },
        provenance: [...record.provenance],
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        embedding: record.embedding,
        norm: record.norm,
        token_count: record.tokenCount,
      }));

    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(serialized, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }
}

function normaliseTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  const unique = new Set<string>();
  for (const tag of tags) {
    if (!tag) {
      continue;
    }
    unique.add(String(tag).trim().toLowerCase());
  }
  return Array.from(unique).filter((tag) => tag.length > 0).slice(0, 32);
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function buildEmbedding(tokens: string[]): Record<string, number> {
  const embedding: Record<string, number> = {};
  if (tokens.length === 0) {
    return embedding;
  }
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const total = tokens.length;
  for (const [token, count] of counts.entries()) {
    embedding[token] = count / total;
  }
  return embedding;
}

function computeNorm(embedding: Record<string, number>): number {
  let sum = 0;
  for (const value of Object.values(embedding)) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(
  query: Record<string, number>,
  queryNorm: number,
  doc: Record<string, number>,
  docNorm: number,
): number {
  let dot = 0;
  for (const [token, weight] of Object.entries(query)) {
    const docWeight = doc[token];
    if (docWeight !== undefined) {
      dot += weight * docWeight;
    }
  }
  if (dot === 0 || queryNorm === 0 || docNorm === 0) {
    return 0;
  }
  return clampScore(dot / (queryNorm * docNorm));
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
