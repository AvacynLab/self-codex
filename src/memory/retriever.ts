import { distance as levenshteinDistance } from "fastest-levenshtein";

import { StructuredLogger } from "../logger.js";
import type { Provenance } from "../types/provenance.js";
import type {
  LocalVectorMemoryOptions,
  VectorMemory,
  VectorMemorySearchHit,
  VectorMemorySearchOptions,
} from "./vectorMemory.js";

/**
 * Options accepted when instantiating {@link HybridRetriever}. The defaults are
 * intentionally conservative so environments without advanced indexes still
 * produce deterministic and explainable rankings.
 */
export interface HybridRetrieverOptions {
  /** Weight applied to cosine similarity scores. */
  vectorWeight?: number;
  /** Weight applied to lexical overlap scores. */
  lexicalWeight?: number;
  /**
   * Factor used when requesting candidates from the underlying vector memory.
   * A value of 2 means the retriever will fetch twice as many hits as the
   * requested limit before re-ranking them locally.
   */
  overfetchFactor?: number;
  /** Default limit applied when callers omit the `limit` search option. */
  defaultLimit?: number;
  /**
   * Minimum score forwarded to the vector memory backend. The threshold keeps
   * latency predictable by avoiding work on extremely low quality hits.
   */
  minVectorScore?: number;
}

/** Search options accepted by {@link HybridRetriever.search}. */
export interface HybridRetrieverSearchOptions {
  /** Maximum number of results returned (defaults to the configured limit). */
  limit?: number;
  /** Minimum cosine similarity score accepted. */
  minScore?: number;
  /** Optional set of tags every returned document must include. */
  requiredTags?: string[];
}

/** Structured representation of a single RAG hit. */
export interface HybridRetrieverHit {
  /** Identifier of the retrieved vector document. */
  id: string;
  /** Raw textual content stored in the vector memory. */
  text: string;
  /** Cosine similarity score returned by the vector backend. */
  vectorScore: number;
  /** Lexical overlap score computed locally. */
  lexicalScore: number;
  /** Weighted score combining vector and lexical signals. */
  score: number;
  /** Optional semantic tags assigned during ingestion. */
  tags: string[];
  /** Structured metadata forwarded by ingestion workflows. */
  metadata: Record<string, unknown>;
  /** Provenance entries attached to the stored chunk. */
  provenance: Provenance[];
  /** Tags matching the {@link HybridRetrieverSearchOptions.requiredTags} filter. */
  matchedTags: string[];
  /** Timestamp describing when the chunk was first stored. */
  createdAt: number;
  /** Timestamp describing when the chunk was last updated. */
  updatedAt: number;
}

interface RetrieverConfig {
  vectorWeight: number;
  lexicalWeight: number;
  overfetchFactor: number;
  defaultLimit: number;
  minVectorScore: number;
}

const DEFAULT_CONFIG: RetrieverConfig = {
  vectorWeight: 0.75,
  lexicalWeight: 0.25,
  overfetchFactor: 2,
  defaultLimit: 6,
  minVectorScore: 0.1,
};

/** Maximum amount of overfetching tolerated when combining scores. */
const MAX_OVERFETCH = 6;
/** Upper bound on the number of candidate tokens inspected for fuzzy matches. */
const MAX_FUZZY_CANDIDATES = 128;
/** Limits per-token comparisons when computing fuzzy scores to cap latency. */
const MAX_FUZZY_COMPARISONS = 96;

/**
 * Hybrid retrieval strategy combining cosine similarity and lexical overlap.
 * The helper wraps {@link VectorMemory} so callers can provide any backend
 * implementing the interface (local JSON index, external vector database...).
 */
export class HybridRetriever {
  private readonly config: RetrieverConfig;

  constructor(
    private readonly memory: VectorMemory,
    private readonly logger: StructuredLogger,
    options: HybridRetrieverOptions = {},
  ) {
    this.config = normaliseOptions(options);
  }

  /** Returns the number of stored documents for observability tooling. */
  size(): number {
    return this.memory.size();
  }

  /** Clears the underlying vector memory. Mainly used in integration tests. */
  async clear(): Promise<void> {
    await this.memory.clear();
  }

  /**
   * Executes a semantic search query and returns re-ranked candidates. When the
   * lexical overlap fails to provide a signal the method falls back to the raw
   * vector score. Results are sorted in descending order using the combined
   * score and use `updatedAt` as a deterministic tie-breaker.
   */
  async search(query: string, options: HybridRetrieverSearchOptions = {}): Promise<HybridRetrieverHit[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const limit = clampLimit(options.limit ?? this.config.defaultLimit);
    const minScore = clampScore(options.minScore ?? this.config.minVectorScore);
    const overfetch = Math.min(Math.max(1, Math.ceil(limit * this.config.overfetchFactor)), MAX_OVERFETCH * limit);

    const vectorOptions: VectorMemorySearchOptions = {
      limit: overfetch,
      minScore,
      requiredTags: options.requiredTags,
    };

    const started = Date.now();
    const hits = await this.memory.search(trimmedQuery, vectorOptions);
    const queryTokens = lexicalTokenise(trimmedQuery);

    const ranked = hits.map((hit) => {
      const lexicalScore = computeLexicalScore(queryTokens, hit.document.text);
      const combined = combineScores(hit.score, lexicalScore, this.config.vectorWeight, this.config.lexicalWeight);
      return buildHit(hit, combined, lexicalScore);
    });

    ranked.sort((left, right) =>
      right.score - left.score ||
      right.vectorScore - left.vectorScore ||
      right.updatedAt - left.updatedAt ||
      right.text.length - left.text.length,
    );

    const result = ranked.slice(0, limit);
    const elapsed = Date.now() - started;
    this.logger.info("rag_retriever_search", {
      query_length: trimmedQuery.length,
      limit,
      min_vector_score: minScore,
      returned: result.length,
      fetched: hits.length,
      took_ms: elapsed,
    });
    return result;
  }
}

/** Builds a {@link HybridRetrieverHit} from the underlying vector memory hit. */
function buildHit(hit: VectorMemorySearchHit, score: number, lexicalScore: number): HybridRetrieverHit {
  return {
    id: hit.document.id,
    text: hit.document.text,
    vectorScore: hit.score,
    lexicalScore,
    score,
    tags: [...hit.document.tags],
    metadata: { ...hit.document.metadata },
    provenance: [...hit.document.provenance],
    matchedTags: [...hit.matchedTags],
    createdAt: hit.document.createdAt,
    updatedAt: hit.document.updatedAt,
  };
}

/** Normalises retriever options by clamping weights and fetching factors. */
function normaliseOptions(options: HybridRetrieverOptions): RetrieverConfig {
  let vectorWeight = Number.isFinite(options.vectorWeight) ? Number(options.vectorWeight) : DEFAULT_CONFIG.vectorWeight;
  let lexicalWeight = Number.isFinite(options.lexicalWeight) ? Number(options.lexicalWeight) : DEFAULT_CONFIG.lexicalWeight;
  if (vectorWeight < 0) vectorWeight = DEFAULT_CONFIG.vectorWeight;
  if (lexicalWeight < 0) lexicalWeight = DEFAULT_CONFIG.lexicalWeight;
  if (vectorWeight === 0 && lexicalWeight === 0) {
    vectorWeight = DEFAULT_CONFIG.vectorWeight;
    lexicalWeight = DEFAULT_CONFIG.lexicalWeight;
  }

  const overfetchFactor = clampOverfetch(options.overfetchFactor ?? DEFAULT_CONFIG.overfetchFactor);
  const defaultLimit = clampLimit(options.defaultLimit ?? DEFAULT_CONFIG.defaultLimit);
  const minVectorScore = clampScore(options.minVectorScore ?? DEFAULT_CONFIG.minVectorScore);

  return {
    vectorWeight,
    lexicalWeight,
    overfetchFactor,
    defaultLimit,
    minVectorScore,
  };
}

/** Ensures the overfetch factor stays within sensible bounds. */
function clampOverfetch(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.overfetchFactor;
  }
  return Math.min(MAX_OVERFETCH, Math.max(1, value));
}

/** Keeps the limit in a pragmatic range for RAG workflows. */
function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.defaultLimit;
  }
  return Math.min(25, Math.max(1, Math.floor(value)));
}

/** Ensures scores remain in the inclusive [0, 1] range. */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.minVectorScore;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Combines vector and lexical scores using the configured weights. */
function combineScores(vectorScore: number, lexicalScore: number, vectorWeight: number, lexicalWeight: number): number {
  const weighted = vectorScore * vectorWeight + lexicalScore * lexicalWeight;
  const totalWeight = vectorWeight + lexicalWeight;
  if (totalWeight === 0) {
    return Math.max(0, Math.min(1, vectorScore));
  }
  const combined = weighted / totalWeight;
  if (!Number.isFinite(combined)) {
    return Math.max(0, Math.min(1, vectorScore));
  }
  return Math.max(0, Math.min(1, combined));
}

/** Tokenises a string into lowercase words for lexical comparisons. */
function lexicalTokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

/**
 * Computes the proportion of query tokens present in the provided text. The
 * metric stays in the [0, 1] range and favours passages covering the entire
 * query over partial matches.
 */
function computeLexicalScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const tokens = lexicalTokenise(text);
  if (tokens.length === 0) {
    return 0;
  }

  const uniqueTokens = new Set(tokens);
  const fuzzyCandidates = tokens.slice(0, MAX_FUZZY_CANDIDATES);

  let contribution = 0;
  for (const token of queryTokens) {
    if (uniqueTokens.has(token)) {
      contribution += 1;
      continue;
    }
    const similarity = computeBestTokenSimilarity(token, fuzzyCandidates);
    contribution += scoreForSimilarity(similarity);
  }

  const average = contribution / queryTokens.length;
  if (!Number.isFinite(average) || average <= 0) {
    return 0;
  }
  return Math.min(1, average);
}

/**
 * Evaluates fuzzy matches between the provided token and the candidate list
 * using the normalised Levenshtein distance. The helper bounds the number of
 * comparisons so retrieval latency stays predictable even for long passages.
 */
function computeBestTokenSimilarity(token: string, candidates: string[]): number {
  if (candidates.length === 0) {
    return 0;
  }

  const limit = Math.min(candidates.length, MAX_FUZZY_COMPARISONS);
  let best = 0;
  for (let index = 0; index < limit; index += 1) {
    const candidate = candidates[index];
    if (!candidate || candidate === token) {
      continue;
    }

    const maxLength = Math.max(token.length, candidate.length);
    if (maxLength === 0) {
      continue;
    }

    const distance = levenshteinDistance(token, candidate);
    const similarity = 1 - distance / maxLength;
    if (!Number.isFinite(similarity) || similarity <= best) {
      continue;
    }

    best = similarity;
    if (best >= 0.98) {
      break;
    }
  }
  return best;
}

/**
 * Converts a similarity score into a bounded contribution. Exact or near-exact
 * matches receive a full point while approximate matches contribute a fraction
 * of a point so the final average stays within the [0, 1] range.
 */
function scoreForSimilarity(similarity: number): number {
  if (!Number.isFinite(similarity) || similarity <= 0) {
    return 0;
  }
  if (similarity >= 0.97) {
    return 1;
  }
  if (similarity >= 0.9) {
    return 0.75;
  }
  if (similarity >= 0.8) {
    return 0.5;
  }
  if (similarity >= 0.7) {
    return 0.3;
  }
  if (similarity >= 0.6) {
    return 0.1;
  }
  return 0;
}

export type { LocalVectorMemoryOptions };
