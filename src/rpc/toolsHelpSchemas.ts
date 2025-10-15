import { z } from "zod";

/**
 * Canonical list of categories exposed through the Tool-OS manifest model. The
 * array mirrors the union declared in `ToolManifestCategory` so schema
 * validation can stay aligned without depending on TypeScript-specific
 * constructs at runtime.
 */
export const TOOL_HELP_CATEGORIES = [
  "project",
  "artifact",
  "graph",
  "plan",
  "child",
  "runtime",
  "memory",
  "admin",
] as const;

/** Schema describing the category filters accepted by the tools_help façade. */
export const ToolsHelpCategorySchema = z.enum(TOOL_HELP_CATEGORIES);

/** Valid visibility modes surfaced by the façade results. */
export const ToolsHelpVisibilityModeSchema = z.enum(["basic", "pro"]);

/** Valid pack identifiers surfaced by the façade results. */
export const ToolsHelpPackSchema = z.enum(["basic", "authoring", "ops", "all"]);

/**
 * Schema describing the input payload accepted by the tools_help façade.
 *
 * The structure intentionally keeps all fields optional so callers can discover
 * the catalogue without having to provide additional context. Filters can be
 * combined to narrow down the manifest list when the orchestrator exposes a
 * large number of primitives.
 */
export const ToolsHelpInputSchema = z
  .object({
    mode: ToolsHelpVisibilityModeSchema.optional(),
    pack: ToolsHelpPackSchema.optional(),
    include_hidden: z.boolean().optional(),
    categories: z.array(ToolsHelpCategorySchema).min(1).max(8).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).min(1).max(10).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().positive().max(50).optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string().trim().min(1), z.unknown()).optional(),
  })
  .strict();

/** Shape used when registering the façade with the MCP transport. */
export const ToolsHelpInputShape = ToolsHelpInputSchema.shape;

/** Schema describing the budget diagnostic object attached to degraded results. */
export const ToolsHelpBudgetDiagnosticSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

/** Schema describing an individual manifest entry surfaced by the façade. */
export const ToolsHelpToolSummarySchema = z
  .object({
    name: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().max(2000).optional(),
    category: ToolsHelpCategorySchema,
    tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    hidden: z.boolean().optional(),
    deprecated: z
      .object({
        since: z.string().trim().min(1),
        replace_with: z.string().trim().min(1).optional(),
      })
      .optional(),
    budgets: z
      .object({
        time_ms: z.number().int().nonnegative().optional(),
        tool_calls: z.number().int().nonnegative().optional(),
        bytes_out: z.number().int().nonnegative().optional(),
      })
      .optional(),
    example: z.unknown().optional(),
    common_errors: z.array(z.string().trim().min(1)).max(10).optional(),
  })
  .strict();

/** Schema describing the structured details returned by the façade. */
export const ToolsHelpOutputDetailsSchema = z
  .object({
    idempotency_key: z.string().trim().min(1),
    mode: ToolsHelpVisibilityModeSchema,
    pack: ToolsHelpPackSchema,
    include_hidden: z.boolean(),
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    filters: z
      .object({
        categories: z.array(ToolsHelpCategorySchema).optional(),
        tags: z.array(z.string().trim().min(1).max(100)).optional(),
        search: z.string().trim().min(1).optional(),
        limit: z.number().int().positive().optional(),
      })
      .partial()
      .strict(),
    tools: z.array(ToolsHelpToolSummarySchema),
    metadata: z.record(z.string().trim().min(1), z.unknown()).optional(),
    budget: ToolsHelpBudgetDiagnosticSchema.optional(),
  })
  .strict();

/** Complete schema validated by the façade before returning a result. */
export const ToolsHelpOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().trim().min(1),
    details: ToolsHelpOutputDetailsSchema,
  })
  .strict();

export type ToolsHelpInput = z.infer<typeof ToolsHelpInputSchema>;
export type ToolsHelpOutput = z.infer<typeof ToolsHelpOutputSchema>;
export type ToolsHelpToolSummary = z.infer<typeof ToolsHelpToolSummarySchema>;
export type ToolsHelpBudgetDiagnostic = z.infer<typeof ToolsHelpBudgetDiagnosticSchema>;
