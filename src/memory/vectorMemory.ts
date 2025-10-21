import {
  VectorMemoryIndex,
  type VectorDocumentInput,
  type VectorMemoryDocument,
  type VectorMemoryIndexOptions,
} from "./vector.js";
import type { VectorSearchOptions, VectorSearchHit } from "./vector.js";
import { normaliseProvenanceList, type Provenance } from "../types/provenance.js";

/**
 * Input payload accepted by {@link VectorMemory.upsert}. Each entry is
 * normalised before being delegated to the underlying {@link VectorMemoryIndex}
 * so callers can provide partially-formed provenance lists without worrying
 * about validation.
 */
export interface VectorMemoryUpsertInput {
  /** Optional identifier allowing deterministic updates of existing documents. */
  id?: string;
  /** Raw textual content that should be embedded into the vector index. */
  text: string;
  /** Optional semantic tags attached to the entry for downstream filtering. */
  tags?: string[];
  /** Arbitrary structured metadata forwarded to tool consumers. */
  metadata?: Record<string, unknown>;
  /** Structured provenance pointing back to the artefacts supporting the text. */
  provenance?: ReadonlyArray<Provenance | null | undefined>;
  /** Optional timestamp overriding the creation date used for eviction policies. */
  createdAt?: number;
}

/** Additional options controlling the ranking behaviour of {@link VectorMemory.search}. */
export interface VectorMemorySearchOptions {
  /** Maximum number of hits returned by the search. */
  limit?: number;
  /** Minimum cosine similarity score accepted in the results. */
  minScore?: number;
  /** Optional set of tags that must all be present on matching documents. */
  requiredTags?: string[];
}

/** Search hit returned by {@link VectorMemory.search}. */
export interface VectorMemorySearchHit {
  /** Document retrieved from the vector index. */
  document: VectorMemoryDocument;
  /** Cosine similarity score in the inclusive [0, 1] range. */
  score: number;
  /** Subset of tags that matched the {@link VectorMemorySearchOptions.requiredTags} filter. */
  matchedTags: string[];
}

/** Contract implemented by vector memory backends. */
export interface VectorMemory {
  /** Stores or updates a batch of documents and returns their snapshots. */
  upsert(inputs: VectorMemoryUpsertInput[]): Promise<VectorMemoryDocument[]>;
  /** Executes a cosine similarity search against the stored documents. */
  search(query: string, options?: VectorMemorySearchOptions): Promise<VectorMemorySearchHit[]>;
  /** Deletes the provided identifiers and returns the number of removed documents. */
  delete(ids: Iterable<string>): Promise<number>;
  /** Clears the entire index. */
  clear(): Promise<void>;
  /** Returns the number of stored documents. */
  size(): number;
}

/** Options accepted when creating {@link LocalVectorMemory}. */
export interface LocalVectorMemoryOptions extends VectorMemoryIndexOptions {}

/**
 * Default {@link VectorMemory} implementation backed by
 * {@link VectorMemoryIndex}. The helper adds tag filtering, provenance
 * normalisation and defensive cloning so higher level modules can focus on RAG
 * orchestration instead of persistence concerns.
 */
export class LocalVectorMemory implements VectorMemory {
  private constructor(private readonly index: VectorMemoryIndex) {}

  /** Factory initialising the underlying {@link VectorMemoryIndex}. */
  static async create(options: LocalVectorMemoryOptions): Promise<LocalVectorMemory> {
    const index = await VectorMemoryIndex.create(options);
    return new LocalVectorMemory(index);
  }

  /** Exposes the number of stored documents. Mainly useful in tests. */
  size(): number {
    return this.index.size();
  }

  /** Clears the underlying index and persists the truncated snapshot. */
  async clear(): Promise<void> {
    await this.index.clear();
  }

  /**
   * Stores or updates documents in the persistent index. Provenance metadata is
   * normalised eagerly to keep the persisted snapshots canonical and
   * deterministic.
   */
  async upsert(inputs: VectorMemoryUpsertInput[]): Promise<VectorMemoryDocument[]> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return [];
    }

    const snapshots: VectorMemoryDocument[] = [];
    for (const input of inputs) {
      // Forward optional fields selectively so the underlying index never
      // receives `undefined` entries once exact optional property typing is
      // enabled.
      const payload: VectorDocumentInput = {
        text: input.text,
        provenance: normaliseProvenanceList(input.provenance),
      };
      if (typeof input.id === "string") {
        payload.id = input.id;
      }
      if (Array.isArray(input.tags)) {
        payload.tags = input.tags;
      }
      if (input.metadata !== undefined) {
        payload.metadata = input.metadata;
      }
      if (typeof input.createdAt === "number") {
        payload.createdAt = input.createdAt;
      }
      const stored = await this.index.upsert(payload);
      snapshots.push({
        ...stored,
        metadata: { ...stored.metadata },
        provenance: [...stored.provenance],
      });
    }
    return snapshots;
  }

  /**
   * Executes a cosine similarity search and applies optional tag filtering.
   * Matching tags are returned alongside the score so downstream heuristics can
   * reason about coverage.
   */
  async search(query: string, options: VectorMemorySearchOptions = {}): Promise<VectorMemorySearchHit[]> {
    // Clamp search options while omitting fields callers did not provide so the
    // exact optional property typing check remains satisfied.
    const vectorOptions: VectorSearchOptions = {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    };
    const hits: VectorSearchHit[] = this.index.search(query, vectorOptions);
    if (hits.length === 0) {
      return [];
    }

    const requiredTags = normaliseTags(options.requiredTags);
    const results: VectorMemorySearchHit[] = [];
    for (const hit of hits) {
      const documentTags = new Set(hit.document.tags.map((tag) => tag.toLowerCase()));
      const matchedTags = requiredTags.filter((tag) => documentTags.has(tag));
      if (requiredTags.length > 0 && matchedTags.length !== requiredTags.length) {
        continue;
      }
      results.push({
        document: {
          ...hit.document,
          metadata: { ...hit.document.metadata },
          provenance: [...hit.document.provenance],
        },
        score: hit.score,
        matchedTags,
      });
    }
    return results;
  }

  /** Deletes the provided identifiers and persists the truncated snapshot. */
  async delete(ids: Iterable<string>): Promise<number> {
    return this.index.deleteMany(ids);
  }
}

/** Utility converting arbitrary tags into a deduplicated lowercase list. */
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
  return Array.from(unique).filter((tag) => tag.length > 0);
}

