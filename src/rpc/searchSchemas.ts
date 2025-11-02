import { z } from "zod";

import type { JobStatus, JsonValue } from "../search/jobStore.js";

const SEARCH_JOB_STATUS_VALUES = ["pending", "running", "completed", "failed"] as const satisfies readonly JobStatus[];

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
const SearchStatusJobStatusSchema = z.enum(SEARCH_JOB_STATUS_VALUES);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

const SearchStatusJobBudgetSchema = z
  .object({
    max_duration_ms: z.number().int().min(0).nullable(),
    max_tool_calls: z.number().int().min(0).nullable(),
    max_bytes_out: z.number().int().min(0).nullable(),
  })
  .strict();

const SearchStatusJobProgressSchema = z
  .object({
    step: z.string().min(1),
    message: z.string().nullable(),
    ratio: z.number().min(0).max(1).nullable(),
    updated_at: z.number().int().min(0),
  })
  .strict();

const SearchStatusJobSummarySchema = z
  .object({
    considered_results: z.number().int().min(0),
    fetched_documents: z.number().int().min(0),
    ingested_documents: z.number().int().min(0),
    skipped_documents: z.number().int().min(0),
    artifacts: z.array(z.string().min(1)),
    metrics: z.record(z.string(), z.number()),
    notes: z.string().nullable(),
  })
  .strict();

const SearchStatusJobFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    stage: z.string().min(1).nullable(),
    occurred_at: z.number().int().min(0),
    details: JsonValueSchema.nullable(),
  })
  .strict();

const SearchStatusJobStateSchema = z
  .object({
    status: SearchStatusJobStatusSchema,
    created_at: z.number().int().min(0),
    updated_at: z.number().int().min(0),
    started_at: z.number().int().min(0).nullable(),
    completed_at: z.number().int().min(0).nullable(),
    failed_at: z.number().int().min(0).nullable(),
    progress: SearchStatusJobProgressSchema.nullable(),
    summary: SearchStatusJobSummarySchema.nullable(),
    errors: z.array(SearchStatusJobFailureSchema),
  })
  .strict();

const SearchStatusJobProvenanceSchema = z
  .object({
    trigger: z.string().min(1),
    transport: z.string().min(1),
    request_id: z.string().min(1).nullable(),
    requester: z.string().min(1).nullable(),
    remote_address: z.string().min(1).nullable(),
    extra: z.record(JsonValueSchema),
  })
  .strict();

const SearchStatusJobMetaSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.number().int().min(0),
    query: z.string().min(1),
    normalized_query: z.string().min(1),
    tags: z.array(z.string().min(1)),
    requester: z.string().nullable(),
    budget: SearchStatusJobBudgetSchema,
  })
  .strict();

const SearchStatusJobRecordSchema = z
  .object({
    job_id: z.string().min(1),
    meta: SearchStatusJobMetaSchema,
    state: SearchStatusJobStateSchema,
    provenance: SearchStatusJobProvenanceSchema,
  })
  .strict();

const SearchStatusInputObject = z
  .object({
    job_id: z.string().trim().min(1).optional(),
    status: z.union([SearchStatusJobStatusSchema, z.array(SearchStatusJobStatusSchema)]).optional(),
    tag: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    since: z.number().int().min(0).optional(),
    until: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const SearchStatusInputSchema = SearchStatusInputObject.refine((value) => {
    const hasJobId = typeof value.job_id === "string";
    const hasFilters =
      value.status !== undefined ||
      value.tag !== undefined ||
      value.tags !== undefined ||
      value.since !== undefined ||
      value.until !== undefined ||
      value.limit !== undefined;
    return hasJobId !== hasFilters;
  }, {
    message: "fournir soit job_id, soit des filtres (status/tag/since/until/limit)",
    path: ["job_id"],
  });

export const SearchStatusInputShape = SearchStatusInputObject.shape;

const SearchStatusErrorSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(["persistence_unavailable", "not_found"]),
    message: z.string().min(1),
  })
  .strict();

const SearchStatusSingleSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: SearchStatusJobRecordSchema,
  })
  .strict();

const SearchStatusListSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z.array(SearchStatusJobRecordSchema),
  })
  .strict();

/** Output returned by the `search.status` façade. */
export const SearchStatusOutputSchema = z.union([
  SearchStatusSingleSuccessSchema,
  SearchStatusListSuccessSchema,
  SearchStatusErrorSchema,
]);

export type SearchStatusInput = z.infer<typeof SearchStatusInputSchema>;
export type SearchStatusOutput = z.infer<typeof SearchStatusOutputSchema>;
export type SearchStatusJobRecord = z.infer<typeof SearchStatusJobRecordSchema>;
