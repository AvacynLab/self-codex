import { z } from "zod";

import type { KnowledgeGraph, KnowledgeTripleSnapshot } from "../knowledge/knowledgeGraph.js";
import { StructuredLogger } from "../logger.js";

/** Context injected by the server when invoking knowledge graph tools. */
export interface KnowledgeToolContext {
  /** Shared knowledge graph storing task and plan triples. */
  knowledgeGraph: KnowledgeGraph;
  /** Structured logger used for auditability. */
  logger: StructuredLogger;
}

/** Schema describing a single triple accepted by the insert tool. */
const KnowledgeTripleInputSchema = z
  .object({
    subject: z.string().min(1, "subject must not be empty"),
    predicate: z.string().min(1, "predicate must not be empty"),
    object: z.string().min(1, "object must not be empty"),
    source: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

/** Schema validating the payload accepted by the `kg_insert` tool. */
export const KgInsertInputSchema = z
  .object({
    triples: z.array(KnowledgeTripleInputSchema).min(1).max(256),
  })
  .strict();
export const KgInsertInputShape = KgInsertInputSchema.shape;

/** Schema validating the payload accepted by the `kg_query` tool. */
export const KgQueryInputSchema = z
  .object({
    subject: z.string().min(1).optional(),
    predicate: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(500).default(50),
    order: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export const KgQueryInputShape = KgQueryInputSchema.shape;

/** Schema validating the payload accepted by the `kg_export` tool. */
export const KgExportInputSchema = z.object({}).strict();
export const KgExportInputShape = KgExportInputSchema.shape;

interface SerializedTriple extends Record<string, unknown> {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  source: string | null;
  confidence: number;
  inserted_at: number;
  updated_at: number;
  revision: number;
  ordinal: number;
}

/** Result returned by {@link handleKgInsert}. */
export interface KgInsertResult extends Record<string, unknown> {
  inserted: SerializedTriple[];
  created: number;
  updated: number;
  total: number;
}

/** Result returned by {@link handleKgQuery}. */
export interface KgQueryResult extends Record<string, unknown> {
  triples: SerializedTriple[];
  total: number;
  next_cursor: number | null;
}

/** Result returned by {@link handleKgExport}. */
export interface KgExportResult extends Record<string, unknown> {
  triples: SerializedTriple[];
  total: number;
}

/** Stores or updates a batch of triples on the knowledge graph. */
export function handleKgInsert(
  context: KnowledgeToolContext,
  input: z.infer<typeof KgInsertInputSchema>,
): KgInsertResult {
  let created = 0;
  let updated = 0;
  const inserted = input.triples.map((triple) => {
    const result = context.knowledgeGraph.insert(triple);
    if (result.created) created += 1;
    if (result.updated) updated += 1;
    return serializeTriple(result.snapshot);
  });
  const total = context.knowledgeGraph.count();
  context.logger.info("kg_insert", {
    triples: input.triples.length,
    created,
    updated,
    total,
  });
  return { inserted, created, updated, total };
}

/** Queries triples matching the provided motif and returns deterministic slices. */
export function handleKgQuery(
  context: KnowledgeToolContext,
  input: z.infer<typeof KgQueryInputSchema>,
): KgQueryResult {
  const triples = context.knowledgeGraph.query(
    {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      source: input.source,
      minConfidence: input.min_confidence,
    },
    { limit: input.limit, order: input.order },
  );
  const serialised = triples.map(serializeTriple);
  const nextCursor = serialised.length ? serialised[serialised.length - 1].ordinal : null;
  context.logger.info("kg_query", {
    subject: input.subject ?? null,
    predicate: input.predicate ?? null,
    object: input.object ?? null,
    source: input.source ?? null,
    returned: serialised.length,
    limit: input.limit,
  });
  return { triples: serialised, total: serialised.length, next_cursor: nextCursor };
}

/** Dumps the entire knowledge graph in insertion order. */
export function handleKgExport(
  context: KnowledgeToolContext,
  _input: z.infer<typeof KgExportInputSchema>,
): KgExportResult {
  const triples = context.knowledgeGraph.exportAll().map(serializeTriple);
  context.logger.info("kg_export", { total: triples.length });
  return { triples, total: triples.length };
}

function serializeTriple(snapshot: KnowledgeTripleSnapshot): SerializedTriple {
  return {
    id: snapshot.id,
    subject: snapshot.subject,
    predicate: snapshot.predicate,
    object: snapshot.object,
    source: snapshot.source,
    confidence: snapshot.confidence,
    inserted_at: snapshot.insertedAt,
    updated_at: snapshot.updatedAt,
    revision: snapshot.revision,
    ordinal: snapshot.ordinal,
  };
}
