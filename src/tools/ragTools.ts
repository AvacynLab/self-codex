import { z } from "zod";

import { StructuredLogger } from "../logger.js";
import { normaliseProvenanceList, PROVENANCE_TYPES, type Provenance } from "../types/provenance.js";
import { HybridRetriever } from "../memory/retriever.js";
import type { VectorMemory } from "../memory/vectorMemory.js";
import { omitUndefinedEntries } from "../utils/object.js";

/** Context supplied when serving RAG-oriented tools. */
export interface RagToolContext {
  /** Vector memory backend storing the ingested chunks. */
  memory: VectorMemory;
  /** Hybrid retriever combining cosine and lexical scores. */
  retriever: HybridRetriever;
  /** Structured logger capturing ingestion and query telemetry. */
  logger: StructuredLogger;
}

const ProvenanceSchema = z
  .object({
    sourceId: z.string().min(1, "sourceId must not be empty"),
    type: z.enum(PROVENANCE_TYPES as ["url", "file", "db", "kg", "rag"]),
    span: z
      .tuple([z.number(), z.number()])
      .refine((value) => value.every((entry) => Number.isFinite(entry)), "span must only contain finite numbers")
      .refine((value) => value[1] >= value[0], "span end must be >= start")
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const RagDocumentSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    text: z.string().min(1, "text must not be empty"),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    provenance: z.array(ProvenanceSchema).max(50).optional(),
  })
  .strict();

/** Schema validating the payload accepted by the `rag_ingest` tool. */
export const RagIngestInputSchema = z
  .object({
    documents: z.array(RagDocumentSchema).min(1).max(100),
    chunk_size: z.number().int().min(200).max(2000).optional(),
    chunk_overlap: z.number().int().min(0).max(800).optional(),
    default_tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
export const RagIngestInputShape = RagIngestInputSchema.shape;

/** Schema validating the payload accepted by the `rag_query` tool. */
export const RagQueryInputSchema = z
  .object({
    query: z.string().min(1, "query must not be empty"),
    limit: z.number().int().min(1).max(20).default(6),
    min_score: z.number().min(0).max(1).default(0.1),
    required_tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    include_metadata: z.boolean().default(true),
  })
  .strict();
export const RagQueryInputShape = RagQueryInputSchema.shape;

/** Structured chunk returned by {@link handleRagIngest}. */
export interface RagIngestedChunk {
  id: string;
  text: string;
  tags: string[];
  metadata: Record<string, unknown>;
  provenance: Provenance[];
  created_at: number;
  updated_at: number;
}

/** Result returned after the ingestion pipeline stores new chunks. */
export interface RagIngestResult extends Record<string, unknown> {
  documents: number;
  chunks: number;
  stored: RagIngestedChunk[];
}

/** Structured hit returned by {@link handleRagQuery}. */
export interface RagQueryHit {
  id: string;
  text: string;
  score: number;
  vector_score: number;
  lexical_score: number;
  tags: string[];
  metadata: Record<string, unknown> | null;
  provenance: Provenance[];
  matched_tags: string[];
  created_at: number;
  updated_at: number;
}

/** Result returned when executing a semantic query. */
export interface RagQueryResult extends Record<string, unknown> {
  query: string;
  hits: RagQueryHit[];
  total: number;
  took_ms: number;
}

interface ChunkOptions {
  maxCharacters: number;
  overlap: number;
}

interface TextChunk {
  text: string;
  start: number;
  end: number;
}

/** Default chunk size used when clients omit explicit directives. */
const DEFAULT_CHUNK_SIZE = 800;
/** Default overlap between consecutive chunks to preserve context continuity. */
const DEFAULT_CHUNK_OVERLAP = 120;

/**
 * Ingests documents into the vector memory after chunking them deterministically.
 * The helper normalises provenance metadata so downstream citations stay
 * consistent across retries.
 */
export async function handleRagIngest(
  context: RagToolContext,
  input: z.infer<typeof RagIngestInputSchema>,
): Promise<RagIngestResult> {
  const maxCharacters = clampChunkSize(input.chunk_size ?? DEFAULT_CHUNK_SIZE);
  const overlap = clampChunkOverlap(input.chunk_overlap ?? DEFAULT_CHUNK_OVERLAP, maxCharacters);
  const defaultTags = normaliseTags(input.default_tags);

  let totalChunks = 0;
  const stored: RagIngestedChunk[] = [];

  for (const [docIndex, document] of input.documents.entries()) {
    const chunks = chunkText(document.text, { maxCharacters, overlap });
    if (chunks.length === 0) {
      continue;
    }

    // Remove optional provenance properties when callers leave them undefined so the
    // downstream vector memory never observes `{ span: undefined }` once exact optional
    // property semantics are enforced.
    const provenanceInput = document.provenance?.map((entry) =>
      sanitiseProvenanceEntry({
        sourceId: entry.sourceId,
        type: entry.type,
        span: entry.span,
        confidence: entry.confidence,
      }),
    );
    const provenance = normaliseProvenanceList(provenanceInput);
    const tags = normaliseTags([...(document.tags ?? []), ...defaultTags]);
    const metadata = document.metadata ? { ...document.metadata } : {};

    const upserts = chunks.map((chunk, chunkIndex) => {
      const chunkId =
        document.id && document.id.length > 0
          ? `${document.id}#${chunkIndex + 1}`
          : undefined;
      return {
        // Only persist the vector identifier when callers provided a base
        // document id. Emitting `id: undefined` would break once
        // `exactOptionalPropertyTypes` is enforced on the vector memory input.
        ...(chunkId ? { id: chunkId } : {}),
        text: chunk.text,
        tags,
        metadata: {
          ...metadata,
          chunk: {
            index: chunkIndex,
            start: chunk.start,
            end: chunk.end,
            source_id: document.id ?? null,
            document_index: docIndex,
          },
        },
        provenance,
      };
    });

    const snapshots = await context.memory.upsert(upserts);
    totalChunks += snapshots.length;
    for (const snapshot of snapshots) {
      stored.push({
        id: snapshot.id,
        text: snapshot.text,
        tags: [...snapshot.tags],
        metadata: { ...snapshot.metadata },
        provenance: [...snapshot.provenance],
        created_at: snapshot.createdAt,
        updated_at: snapshot.updatedAt,
      });
    }
  }

  context.logger.info("rag_ingest", {
    documents: input.documents.length,
    chunks: totalChunks,
    chunk_size: maxCharacters,
    chunk_overlap: overlap,
    default_tags: defaultTags,
  });

  return { documents: input.documents.length, chunks: totalChunks, stored };
}

/**
 * Executes a semantic retrieval query and returns ranked hits with provenance
 * metadata so orchestrators can cite supporting artefacts.
 */
export async function handleRagQuery(
  context: RagToolContext,
  input: z.infer<typeof RagQueryInputSchema>,
): Promise<RagQueryResult> {
  const requiredTags = normaliseTags(input.required_tags);
  const started = Date.now();
  const hits = await context.retriever.search(input.query, {
    limit: input.limit,
    minScore: input.min_score,
    requiredTags,
  });
  const elapsed = Date.now() - started;

  const serialised: RagQueryHit[] = hits.map((hit) => ({
    id: hit.id,
    text: hit.text,
    score: hit.score,
    vector_score: hit.vectorScore,
    lexical_score: hit.lexicalScore,
    tags: [...hit.tags],
    // Only surface metadata when the caller explicitly opts in. Returning
    // `null` keeps the contract explicit without leaking `undefined` once
    // `exactOptionalPropertyTypes` is enforced.
    metadata: input.include_metadata ? { ...hit.metadata } : null,
    provenance: [...hit.provenance],
    matched_tags: [...hit.matchedTags],
    created_at: hit.createdAt,
    updated_at: hit.updatedAt,
  }));

  context.logger.info("rag_query", {
    query_length: input.query.length,
    limit: input.limit,
    returned: serialised.length,
    took_ms: elapsed,
    required_tags: requiredTags,
  });

  return { query: input.query, hits: serialised, total: serialised.length, took_ms: elapsed };
}

/** Splits text into deterministic overlapping chunks based on character counts. */
function chunkText(text: string, options: ChunkOptions): TextChunk[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const chunks: TextChunk[] = [];
  const length = trimmed.length;
  let start = 0;

  while (start < length) {
    const tentativeEnd = Math.min(length, start + options.maxCharacters);
    let end = tentativeEnd;

    const window = trimmed.slice(start, tentativeEnd);
    const newlineBreak = window.lastIndexOf("\n\n");
    if (newlineBreak >= options.maxCharacters / 3) {
      end = start + newlineBreak + 2;
    } else {
      const sentenceBreak = window.lastIndexOf(". ");
      if (sentenceBreak >= options.maxCharacters / 3) {
        end = Math.min(length, start + sentenceBreak + 2);
      }
    }

    if (end <= start) {
      end = Math.min(length, start + options.maxCharacters);
    }

    const chunkTextValue = trimmed.slice(start, end).trim();
    if (chunkTextValue) {
      chunks.push({ text: chunkTextValue, start, end });
    }

    if (end >= length) {
      break;
    }

    const nextStart = end - options.overlap;
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks;
}

/** Normalises optional tag arrays into a deduplicated lowercase list. */
function normaliseTags(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of raw) {
    if (!entry) continue;
    const normalised = entry.trim().toLowerCase();
    if (normalised) {
      unique.add(normalised);
    }
  }
  return Array.from(unique).slice(0, 32);
}

/** Keeps the chunk size within reasonable bounds. */
function clampChunkSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHUNK_SIZE;
  }
  return Math.min(2000, Math.max(200, Math.floor(value)));
}

/** Ensures the chunk overlap never exceeds the configured size. */
function clampChunkOverlap(value: number, chunkSize: number): number {
  if (!Number.isFinite(value)) {
    return Math.min(chunkSize - 1, DEFAULT_CHUNK_OVERLAP);
  }
  if (value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), Math.max(0, chunkSize - 1));
}

/**
 * Drops optional provenance fields that were left undefined by callers.
 * Leveraging {@link omitUndefinedEntries} keeps the ingestion payloads fully
 * compatible with `exactOptionalPropertyTypes` while avoiding mutable clones
 * of the provided entries.
 */
function sanitiseProvenanceEntry(entry: {
  sourceId: string;
  type: Provenance["type"];
  span?: Provenance["span"];
  confidence?: Provenance["confidence"];
}): Provenance {
  return {
    sourceId: entry.sourceId,
    type: entry.type,
    ...omitUndefinedEntries({ span: entry.span, confidence: entry.confidence }),
  };
}
