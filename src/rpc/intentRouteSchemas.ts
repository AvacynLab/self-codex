import { z } from "zod";

/**
 * Diagnostics emitted by the intent router façade. The structure deliberately
 * avoids free-form text so test assertions and observability pipelines can
 * remain deterministic across locales.
 */
export const IntentRouteDiagnosticsSchema = z
  .array(
    z
      .object({
        label: z.string().min(1),
        tool: z.string().min(1),
        matched: z.boolean(),
      })
      .strict(),
  )
  .max(32);

/** Input payload accepted by the `intent_route` façade. */
export const IntentRouteInputSchema = z
  .object({
    natural_language_goal: z.string().trim().min(1, "natural_language_goal must not be empty"),
    metadata: z.record(z.unknown()).optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();

/** Alias used by the RPC middleware when wiring the JSON schema. */
export const IntentRouteInputShape = IntentRouteInputSchema.shape;

const IntentRouteSuccessDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    chosen: z.string().min(1).optional(),
    candidates: z.array(z.string().min(1)).max(12).optional(),
    diagnostics: IntentRouteDiagnosticsSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const IntentRouteBudgetDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
    diagnostics: IntentRouteDiagnosticsSchema.optional(),
  })
  .strict();

/** Structured result returned by the façade. */
export const IntentRouteOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().min(1),
    details: z.union([IntentRouteSuccessDetailsSchema, IntentRouteBudgetDetailsSchema]),
  })
  .strict();
