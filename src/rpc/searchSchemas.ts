import { z } from "zod";

/**
 * Schema guarding the payload accepted by the `search.run` façade.
 * The structure mirrors the `SearchJobParameters` contract while
 * applying conservative limits to avoid overwhelming the pipeline.
 */
export const SearchRunInputSchema = z
  .object({
    query: z.string().trim().min(1, "query must not be empty"),
    categories: z.array(z.string().trim().min(1)).max(16).optional(),
    engines: z.array(z.string().trim().min(1)).max(16).optional(),
    max_results: z.number().int().min(1).max(20).default(6),
    language: z.string().trim().min(2).max(16).optional(),
    safe_search: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    fetch_content: z.boolean().optional(),
    inject_graph: z.boolean().optional(),
    inject_vector: z.boolean().optional(),
    job_id: z.string().trim().min(1).optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();

/** Aliases re-exported to the JSON-RPC layer when binding schemas. */
export const SearchRunInputShape = SearchRunInputSchema.shape;

/** Lightweight document summary returned by `search.run`. */
export const SearchRunDocumentSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    title: z.string().nullable(),
    language: z.string().nullable(),
  })
  .strict();

/** Structured error surfaced when a pipeline stage fails. */
export const SearchRunErrorSchema = z
  .object({
    stage: z.enum(["search", "fetch", "extract", "ingest_graph", "ingest_vector"]),
    url: z.string().url().nullable(),
    message: z.string().min(1),
    code: z.string().min(1).nullable(),
  })
  .strict();

/** Aggregated statistics summarising a finished search job. */
export const SearchRunStatsSchema = z
  .object({
    requested: z.number().int().min(0),
    received: z.number().int().min(0),
    fetched: z.number().int().min(0),
    structured: z.number().int().min(0),
    graph_ingested: z.number().int().min(0),
    vector_ingested: z.number().int().min(0),
  })
  .strict();

const SearchRunSuccessSchema = z
  .object({
    ok: z.literal(true),
    idempotency_key: z.string().min(1),
    summary: z.string().min(1),
    job_id: z.string().min(1).nullable(),
    count: z.number().int().min(0),
    docs: z.array(SearchRunDocumentSchema),
    warnings: z.array(SearchRunErrorSchema).min(1).optional(),
    stats: SearchRunStatsSchema,
    budget_used: z
      .object({
        time_ms: z.number().nonnegative().optional(),
        tokens: z.number().nonnegative().optional(),
        tool_calls: z.number().nonnegative().optional(),
        bytes_in: z.number().nonnegative().optional(),
        bytes_out: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SearchRunBudgetExhaustedSchema = z
  .object({
    ok: z.literal(false),
    idempotency_key: z.string().min(1),
    summary: z.string().min(1),
    reason: z.literal("budget_exhausted"),
    count: z.literal(0),
    docs: z.array(SearchRunDocumentSchema).max(0),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

const SearchRunOperationFailedSchema = z
  .object({
    ok: z.literal(false),
    idempotency_key: z.string().min(1),
    summary: z.string().min(1),
    reason: z.literal("operation_failed"),
    count: z.number().int().min(0),
    docs: z.array(SearchRunDocumentSchema),
    message: z.string().min(1),
  })
  .strict();

/** Structured output returned by the `search.run` façade. */
export const SearchRunOutputSchema = z.union([
  SearchRunSuccessSchema,
  SearchRunBudgetExhaustedSchema,
  SearchRunOperationFailedSchema,
]);

export type SearchRunInput = z.infer<typeof SearchRunInputSchema>;
export type SearchRunOutput = z.infer<typeof SearchRunOutputSchema>;
export type SearchRunDocument = z.infer<typeof SearchRunDocumentSchema>;
export type SearchRunError = z.infer<typeof SearchRunErrorSchema>;
export type SearchRunStats = z.infer<typeof SearchRunStatsSchema>;

/** Payload accepted by the `search.index` façade. */
export const SearchIndexInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            url: z.string().url(),
            title: z.string().trim().min(1).nullable().optional(),
            snippet: z.string().trim().min(1).nullable().optional(),
            categories: z.array(z.string().trim().min(1)).max(16).optional(),
            engines: z.array(z.string().trim().min(1)).max(16).optional(),
            position: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    label: z.string().trim().min(1).optional(),
    job_id: z.string().trim().min(1).optional(),
    inject_graph: z.boolean().optional(),
    inject_vector: z.boolean().optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();

/** Short descriptor representing a document indexed manually. */
export const SearchIndexDocumentSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    title: z.string().nullable(),
  })
  .strict();

const SearchIndexSuccessSchema = z
  .object({
    ok: z.literal(true),
    idempotency_key: z.string().min(1),
    summary: z.string().min(1),
    job_id: z.string().min(1),
    count: z.number().int().min(0),
    docs: z.array(SearchIndexDocumentSchema),
    errors: z.array(SearchRunErrorSchema).min(1).optional(),
    stats: SearchRunStatsSchema,
    budget_used: z
      .object({
        time_ms: z.number().nonnegative().optional(),
        tokens: z.number().nonnegative().optional(),
        tool_calls: z.number().nonnegative().optional(),
        bytes_in: z.number().nonnegative().optional(),
        bytes_out: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SearchIndexBudgetExhaustedSchema = z
  .object({
    ok: z.literal(false),
    idempotency_key: z.string().min(1),
    summary: z.string().min(1),
    reason: z.literal("budget_exhausted"),
    count: z.literal(0),
    docs: z.array(SearchIndexDocumentSchema).max(0),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

const SearchIndexOperationFailedSchema = z
  .object({
    ok: z.literal(false),
    idempotency_key: z.string().min(1),
    summary: z.string().min(1),
    reason: z.literal("operation_failed"),
    count: z.number().int().min(0),
    docs: z.array(SearchIndexDocumentSchema),
    message: z.string().min(1),
  })
  .strict();

/** Output returned by the `search.index` façade. */
export const SearchIndexOutputSchema = z.union([
  SearchIndexSuccessSchema,
  SearchIndexBudgetExhaustedSchema,
  SearchIndexOperationFailedSchema,
]);

export type SearchIndexInput = z.infer<typeof SearchIndexInputSchema>;
export type SearchIndexOutput = z.infer<typeof SearchIndexOutputSchema>;
export type SearchIndexDocument = z.infer<typeof SearchIndexDocumentSchema>;

/** Input accepted by the `search.status` façade. */
export const SearchStatusInputSchema = z
  .object({
    job_id: z.string().trim().min(1).optional(),
  })
  .strict();

const SearchStatusNotImplementedSchema = z
  .object({
    ok: z.literal(false),
    code: z.literal("not_implemented"),
    message: z.string().min(1),
  })
  .strict();

const SearchStatusSuccessSchema = z
  .object({
    ok: z.literal(true),
    job_id: z.string().min(1),
    status: z.enum(["pending", "running", "completed", "failed"]),
    summary: z.string().min(1),
  })
  .strict();

/** Output returned by the `search.status` façade. */
export const SearchStatusOutputSchema = z.union([
  SearchStatusSuccessSchema,
  SearchStatusNotImplementedSchema,
]);

export type SearchStatusInput = z.infer<typeof SearchStatusInputSchema>;
export type SearchStatusOutput = z.infer<typeof SearchStatusOutputSchema>;
