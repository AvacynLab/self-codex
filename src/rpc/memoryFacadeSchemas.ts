import { z } from "zod";

/** Schema guarding the payload accepted by the `memory_upsert` façade. */
export const MemoryUpsertInputSchema = z
  .object({
    text: z.string().trim().min(1, "text must not be empty"),
    tags: z.array(z.string().trim().min(1)).max(32).optional(),
    metadata: z.record(z.unknown()).optional(),
    document_id: z.string().trim().min(1).optional(),
    created_at: z.number().int().min(0).optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();

/** Alias re-exported to the JSON-RPC layer when binding schemas. */
export const MemoryUpsertInputShape = MemoryUpsertInputSchema.shape;

const MemoryUpsertSuccessDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    document_id: z.string().min(1),
    created_at: z.number().int().min(0),
    updated_at: z.number().int().min(0),
    token_count: z.number().int().min(0),
    tags: z.array(z.string()),
    metadata: z.record(z.unknown()).optional(),
    idempotent: z.boolean(),
  })
  .strict();

const MemoryUpsertBudgetDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

const MemoryUpsertErrorDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("operation_failed"),
    message: z.string().min(1),
  })
  .strict();

/** Structured output returned by the `memory_upsert` façade. */
export const MemoryUpsertOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().min(1),
    details: z.union([
      MemoryUpsertSuccessDetailsSchema,
      MemoryUpsertBudgetDetailsSchema,
      MemoryUpsertErrorDetailsSchema,
    ]),
  })
  .strict();

/** Schema guarding the payload accepted by the `memory_search` façade. */
export const MemorySearchInputSchema = z
  .object({
    query: z.string().trim().min(1, "query must not be empty"),
    limit: z.number().int().min(1).max(50).default(8),
    min_score: z.number().min(0).max(1).default(0.1),
    include_metadata: z.boolean().default(true),
    tags_filter: z.array(z.string().trim().min(1)).max(32).optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();

/** Alias re-exported to the JSON-RPC layer when binding schemas. */
export const MemorySearchInputShape = MemorySearchInputSchema.shape;

/** Single hit returned by `memory_search`. */
export const MemorySearchHitSchema = z
  .object({
    document_id: z.string().min(1),
    text: z.string(),
    score: z.number().min(0).max(1),
    tags: z.array(z.string()),
    metadata: z.record(z.unknown()).nullable(),
    created_at: z.number().int().min(0),
    updated_at: z.number().int().min(0),
  })
  .strict();

const MemorySearchSuccessDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    query: z.string(),
    returned: z.number().int().min(0),
    total: z.number().int().min(0),
    took_ms: z.number().nonnegative(),
    hits: z.array(MemorySearchHitSchema),
  })
  .strict();

const MemorySearchBudgetDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

const MemorySearchErrorDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("operation_failed"),
    message: z.string().min(1),
  })
  .strict();

/** Structured output returned by the `memory_search` façade. */
export const MemorySearchOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().min(1),
    details: z.union([
      MemorySearchSuccessDetailsSchema,
      MemorySearchBudgetDetailsSchema,
      MemorySearchErrorDetailsSchema,
    ]),
  })
  .strict();

export type MemoryUpsertSuccessDetails = z.infer<typeof MemoryUpsertSuccessDetailsSchema>;
export type MemoryUpsertBudgetDetails = z.infer<typeof MemoryUpsertBudgetDetailsSchema>;
export type MemoryUpsertErrorDetails = z.infer<typeof MemoryUpsertErrorDetailsSchema>;
export type MemorySearchSuccessDetails = z.infer<typeof MemorySearchSuccessDetailsSchema>;
export type MemorySearchBudgetDetails = z.infer<typeof MemorySearchBudgetDetailsSchema>;
export type MemorySearchErrorDetails = z.infer<typeof MemorySearchErrorDetailsSchema>;

