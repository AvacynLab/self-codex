import { z } from "zod";

import { VectorMemoryIndex } from "../memory/vector.js";
import { StructuredLogger } from "../logger.js";

/** Context injected when serving memory-oriented tools. */
export interface MemoryVectorToolContext {
  /** Persistent vector index storing long form orchestrator artefacts. */
  vectorIndex: VectorMemoryIndex;
  /** Structured logger used to correlate search diagnostics. */
  logger: StructuredLogger;
}

/** Schema guarding the payload accepted by `memory_vector_search`. */
export const MemoryVectorSearchInputSchema = z
  .object({
    query: z.string().min(1, "query must not be empty"),
    limit: z.number().int().min(1).max(25).default(8),
    min_score: z.number().min(0).max(1).default(0.15),
    include_metadata: z.boolean().default(true),
  })
  .strict();
export const MemoryVectorSearchInputShape = MemoryVectorSearchInputSchema.shape;

/** Structured hit returned to callers when searching the vector index. */
export interface MemoryVectorSearchHit {
  id: string;
  text: string;
  tags: string[];
  metadata: Record<string, unknown> | null;
  score: number;
  created_at: number;
  updated_at: number;
}

/** Result returned by {@link handleMemoryVectorSearch}. */
export interface MemoryVectorSearchResult {
  query: string;
  hits: MemoryVectorSearchHit[];
  total: number;
  took_ms: number;
}

/**
 * Executes a cosine similarity search against the vector index and returns the
 * top candidates alongside lightweight telemetry to help operators tune
 * thresholds.
 */
export function handleMemoryVectorSearch(
  context: MemoryVectorToolContext,
  input: z.infer<typeof MemoryVectorSearchInputSchema>,
): MemoryVectorSearchResult {
  const started = Date.now();
  const hits = context.vectorIndex.search(input.query, {
    limit: input.limit,
    minScore: input.min_score,
  });
  const elapsed = Date.now() - started;

  const serialised: MemoryVectorSearchHit[] = hits.map((hit) => ({
    id: hit.document.id,
    text: hit.document.text,
    tags: [...hit.document.tags],
    metadata: input.include_metadata ? { ...hit.document.metadata } : null,
    score: hit.score,
    created_at: hit.document.createdAt,
    updated_at: hit.document.updatedAt,
  }));

  context.logger.info("memory_vector_search", {
    query_length: input.query.length,
    limit: input.limit,
    returned: serialised.length,
    took_ms: elapsed,
    min_score: input.min_score,
  });

  return {
    query: input.query,
    hits: serialised,
    total: serialised.length,
    took_ms: elapsed,
  };
}
