import { estimateTokenUsage } from "../../infra/budget.js";
import {
  embedText,
  type EmbedTextOptions,
  type EmbedTextResult,
  type VectorMemoryDocument,
} from "../../memory/vector.js";
import type {
  VectorMemory,
  VectorMemoryUpsertInput,
} from "../../memory/vectorMemory.js";
import type { StructuredDocument, StructuredSegment } from "../types.js";

/** Allowed segment kinds when generating RAG chunks. */
const CHUNK_KINDS = new Set<StructuredSegment["kind"]>(["title", "paragraph", "list"]);

/** Default token budget per chunk. Tuned to keep prompts concise. */
const DEFAULT_MAX_TOKENS_PER_CHUNK = 220;

/** Tags automatically attached to search sourced vector entries. */
const DEFAULT_VECTOR_TAGS = ["search", "web"] as const;

/**
 * Dependencies required to persist structured documents into the vector store.
 * The embedder can be overridden in tests to capture intermediate payloads
 * without relying on the deterministic tokeniser.
 */
export interface VectorStoreIngestDependencies {
  readonly memory: VectorMemory;
  readonly embed?: (options: EmbedTextOptions) => EmbedTextResult;
  readonly maxTokensPerChunk?: number;
}

/** Descriptor summarising a chunk stored in the vector memory. */
export interface VectorChunkDescriptor {
  readonly chunkId: string;
  readonly tokenCount: number;
  readonly segmentIds: readonly string[];
  readonly metadata: Record<string, unknown>;
}

/** Result returned by {@link VectorStoreIngestor.ingest}. */
export interface VectorStoreIngestResult {
  readonly chunks: readonly VectorMemoryDocument[];
  readonly descriptors: readonly VectorChunkDescriptor[];
}

/**
 * Converts structured documents into vector chunks suitable for downstream RAG
 * retrieval.  The helper keeps chunk sizes predictable by relying on a token
 * budget and preserves provenance metadata so answers can be grounded back to
 * their originating web documents.
 */
export class VectorStoreIngestor {
  private readonly memory: VectorMemory;
  private readonly embed: (options: EmbedTextOptions) => EmbedTextResult;
  private readonly maxTokensPerChunk: number;

  constructor(dependencies: VectorStoreIngestDependencies) {
    this.memory = dependencies.memory;
    this.embed = dependencies.embed ?? embedText;
    const limit = dependencies.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK;
    this.maxTokensPerChunk = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_TOKENS_PER_CHUNK;
  }

  async ingest(document: StructuredDocument): Promise<VectorStoreIngestResult> {
    const chunks = buildChunks(document, this.maxTokensPerChunk);
    if (chunks.length === 0) {
      return { chunks: [], descriptors: [] };
    }

    const inputs: VectorMemoryUpsertInput[] = [];
    const descriptors: VectorChunkDescriptor[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkId = buildChunkId(document.id, index);
      const metadata = buildChunkMetadata(document, chunk.segmentIds, index, chunks.length);
      const provenance = buildChunkProvenance(document, chunkId);

      const embedded = this.embed({
        idHint: chunkId,
        text: chunk.text,
        metadata,
        provenance,
        tags: [...DEFAULT_VECTOR_TAGS],
        createdAt: document.fetchedAt,
      });

      const payload = embedded.payload;
      const upsertPayload: VectorMemoryUpsertInput = { text: payload.text };
      if (payload.id) {
        upsertPayload.id = payload.id;
      }
      if (payload.tags) {
        upsertPayload.tags = [...payload.tags];
      }
      if (payload.metadata) {
        upsertPayload.metadata = { ...payload.metadata };
      }
      if (payload.provenance) {
        upsertPayload.provenance = [...payload.provenance];
      }
      if (payload.createdAt !== undefined) {
        upsertPayload.createdAt = payload.createdAt;
      }

      inputs.push(upsertPayload);
      descriptors.push({
        chunkId: payload.id ?? chunkId,
        tokenCount: embedded.tokenCount,
        segmentIds: [...chunk.segmentIds],
        metadata: { ...metadata },
      });
    }

    const stored = await this.memory.upsert(inputs);
    return { chunks: stored, descriptors };
  }
}

interface ChunkCandidate {
  readonly text: string;
  readonly segmentIds: readonly string[];
}

function buildChunks(document: StructuredDocument, maxTokens: number): ChunkCandidate[] {
  const segments = document.segments
    .filter((segment) => CHUNK_KINDS.has(segment.kind))
    .map((segment) => ({ id: segment.id, text: segment.text.trim() }))
    .filter((entry) => entry.text.length > 0);

  if (segments.length === 0) {
    const fallbackText = document.description ?? document.title;
    if (!fallbackText) {
      return [];
    }
    return splitTextIntoChunks(fallbackText, maxTokens).map((text, index) => ({
      text,
      segmentIds: [`${document.id}:fallback:${index}`],
    }));
  }

  const candidates: ChunkCandidate[] = [];
  let buffer: string[] = [];
  let segmentIds: string[] = [];
  let tokenBudget = 0;

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    candidates.push({ text: buffer.join("\n\n"), segmentIds: [...segmentIds] });
    buffer = [];
    segmentIds = [];
    tokenBudget = 0;
  };

  for (const segment of segments) {
    const tokens = estimateTokenUsage(segment.text);
    if (tokens === 0) {
      continue;
    }

    if (tokens > maxTokens && buffer.length === 0) {
      const pieces = splitTextIntoChunks(segment.text, maxTokens);
      for (const piece of pieces) {
        const pieceTokens = estimateTokenUsage(piece);
        if (pieceTokens === 0) {
          continue;
        }
        if (tokenBudget + pieceTokens > maxTokens && buffer.length > 0) {
          flush();
        }
        buffer.push(piece);
        segmentIds.push(segment.id);
        tokenBudget += pieceTokens;
        flush();
      }
      continue;
    }

    if (tokenBudget > 0 && tokenBudget + tokens > maxTokens) {
      flush();
    }

    buffer.push(segment.text);
    segmentIds.push(segment.id);
    tokenBudget += tokens;
  }

  flush();
  return candidates;
}

function splitTextIntoChunks(text: string, maxTokens: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/u).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length === 0) {
    return splitByLength(text);
  }

  const chunks: string[] = [];
  let current = "";
  let tokens = 0;

  const push = () => {
    if (current.trim().length === 0) {
      current = "";
      tokens = 0;
      return;
    }
    chunks.push(current.trim());
    current = "";
    tokens = 0;
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokenUsage(sentence);
    if (sentenceTokens === 0) {
      continue;
    }
    if (sentenceTokens > maxTokens) {
      if (current) {
        push();
      }
      chunks.push(...splitByLength(sentence));
      continue;
    }
    if (tokens + sentenceTokens > maxTokens && current) {
      push();
    }
    current = current ? `${current} ${sentence}` : sentence;
    tokens += sentenceTokens;
  }

  if (current) {
    push();
  }

  return chunks.length > 0 ? chunks : splitByLength(text);
}

function splitByLength(text: string): string[] {
  const MAX_CHAR = 480;
  const result: string[] = [];
  for (let index = 0; index < text.length; index += MAX_CHAR) {
    result.push(text.slice(index, index + MAX_CHAR));
  }
  return result;
}

function buildChunkId(documentId: string, index: number): string {
  return `search:chunk:${documentId}:${index}`;
}

function buildChunkMetadata(
  document: StructuredDocument,
  segmentIds: readonly string[],
  chunkIndex: number,
  chunkCount: number,
): Record<string, unknown> {
  return {
    document_id: document.id,
    document_url: document.url,
    source_url: document.provenance.sourceUrl,
    fetched_at: document.fetchedAt,
    checksum: document.checksum,
    mime_type: document.mimeType ?? null,
    language: document.language ?? null,
    title: document.title ?? null,
    description: document.description ?? null,
    searx_query: document.provenance.searxQuery,
    searx_engines: [...document.provenance.engines],
    searx_categories: [...document.provenance.categories],
    searx_position: document.provenance.position ?? null,
    chunk_index: chunkIndex,
    chunk_count: chunkCount,
    segment_ids: [...segmentIds],
    size: document.size,
  };
}

function buildChunkProvenance(document: StructuredDocument, chunkId: string) {
  return [
    { sourceId: document.url, type: "url" as const },
    { sourceId: document.provenance.sourceUrl, type: "url" as const },
    { sourceId: chunkId, type: "rag" as const },
    { sourceId: `sha256:${document.checksum}`, type: "file" as const },
  ];
}
