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

/**
 * Individual recommendation surfaced by the intent router. Scores follow a
 * normalised [0, 1] scale where higher values indicate a stronger match. The
 * estimated budget mirrors the façade manifest budgets so orchestrators can
 * anticipate the runtime cost of following the suggestion.
 */
export const IntentRouteRecommendationSchema = z
  .object({
    tool: z.string().min(1),
    score: z.number().min(0).max(1),
    rationale: z.string().min(1),
    estimated_budget: z
      .object({
        time_ms: z.number().nonnegative().optional(),
        tool_calls: z.number().nonnegative().optional(),
        bytes_out: z.number().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

const IntentRouteSuccessDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    recommendations: z.array(IntentRouteRecommendationSchema).min(1).max(3),
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

/**
 * Structured diagnostic entries surfaced alongside façade recommendations.
 * Keeping the type alias close to the schema allows downstream modules to
 * import it directly from the aggregated registry without recomputing
 * `z.infer` every time the diagnostics are consumed.
 */
export type IntentRouteDiagnostics = z.infer<typeof IntentRouteDiagnosticsSchema>;

/** Input payload accepted by the `intent_route` façade. */
export type IntentRouteInput = z.infer<typeof IntentRouteInputSchema>;

/** Recommendation entry returned when the façade successfully matches tools. */
export type IntentRouteRecommendation = z.infer<typeof IntentRouteRecommendationSchema>;

/** Structured payload returned to callers (success and degraded branches). */
export type IntentRouteOutput = z.infer<typeof IntentRouteOutputSchema>;
