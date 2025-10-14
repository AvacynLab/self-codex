import { createHash } from "node:crypto";

import { z } from "zod";

import {
  PlanCompileExecuteInputSchema,
  type PlanCompileExecuteInput,
} from "../tools/planTools.js";

/**
 * Schema validating numerical statistics derived from the planner compilation
 * pipeline. The façade exposes the values verbatim so dashboards can reuse the
 * numbers without recomputing them from the schedule payload.
 */
export const PlanCompileExecuteStatsSchema = z
  .object({
    total_tasks: z.number().int().nonnegative(),
    phases: z.number().int().nonnegative(),
    parallel_phases: z.number().int().nonnegative(),
    critical_path_length: z.number().int().nonnegative(),
    estimated_duration_ms: z.number().int().nonnegative(),
    slacky_tasks: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Summary of the plan schedule. Each phase includes a snapshot of the most
 * relevant tasks so operators understand the critical sections without needing
 * the full planner payload.
 */
export const PlanCompileExecuteSchedulePhaseSchema = z
  .object({
    index: z.number().int().nonnegative(),
    earliest_start_ms: z.number().int().nonnegative(),
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1).nullable(),
            slack_ms: z.number().int().nonnegative(),
            estimated_duration_ms: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/** Snapshot grouping schedule metadata surfaced by the façade. */
export const PlanCompileExecuteScheduleSummarySchema = z
  .object({
    critical_path: z.array(z.string().min(1)).max(100),
    phases: z.array(PlanCompileExecuteSchedulePhaseSchema).max(20),
  })
  .strict();

/**
 * Structure previewing the behaviour tree compiled from the planner document.
 * Only aggregated metrics are surfaced to keep responses compact.
 */
export const PlanCompileExecuteBehaviorTreeSummarySchema = z
  .object({
    id: z.string().min(1),
    root_type: z.string().min(1),
    total_nodes: z.number().int().nonnegative(),
    task_nodes: z.number().int().nonnegative(),
    leaf_tools: z.array(z.string().min(1)).max(32),
  })
  .strict();

/** Snapshot of the declarative plan emitted back to the caller. */
export const PlanCompileExecutePlanPreviewSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1).nullable(),
    title: z.string().min(1).nullable(),
    total_tasks: z.number().int().positive(),
    preview_tasks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1).nullable(),
            tool: z.string().min(1),
            depends_on: z.array(z.string().min(1)).max(10),
          })
          .strict(),
      )
      .max(20),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Summary describing derived bindings (variables, guards, postconditions). */
export const PlanCompileExecuteBindingSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    keys: z.array(z.string().min(1)).max(25),
  })
  .strict();

/** Diagnostic surfaced when the caller exhausts one of its budgets. */
export const PlanCompileExecuteBudgetDiagnosticSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

/** Error payload describing validation or runtime failures. */
export const PlanCompileExecuteErrorDiagnosticSchema = z
  .object({
    reason: z.enum(["plan_invalid", "plan_scheduling_failed", "execution_failed"]),
    message: z.string().min(1),
    code: z.string().min(1).optional(),
    details: z.unknown().optional(),
  })
  .strict();

/** Base details echoed in every façade response. */
export const PlanCompileExecuteOutputDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    run_id: z.string().min(1).optional(),
    op_id: z.string().min(1).optional(),
    plan_id: z.string().min(1).optional(),
    plan_version: z.string().min(1).nullable().optional(),
    dry_run: z.boolean().optional(),
    registered: z.boolean().optional(),
    idempotent: z.boolean().optional(),
    plan_hash: z.string().length(64).optional(),
    stats: PlanCompileExecuteStatsSchema.optional(),
    schedule: PlanCompileExecuteScheduleSummarySchema.optional(),
    behavior_tree: PlanCompileExecuteBehaviorTreeSummarySchema.optional(),
    plan_preview: PlanCompileExecutePlanPreviewSchema.optional(),
    variable_bindings: PlanCompileExecuteBindingSummarySchema.optional(),
    guard_conditions: PlanCompileExecuteBindingSummarySchema.optional(),
    postconditions: PlanCompileExecuteBindingSummarySchema.optional(),
    budget: PlanCompileExecuteBudgetDiagnosticSchema.optional(),
    error: PlanCompileExecuteErrorDiagnosticSchema.optional(),
  })
  .strict();

/** Output payload returned by the façade. */
export const PlanCompileExecuteOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string(),
    details: PlanCompileExecuteOutputDetailsSchema,
  })
  .strict();

/**
 * Input payload accepted by the façade. Extends the primitive planner schema
 * with an explicit idempotency key so requests can be replayed safely.
 */
export const PlanCompileExecuteInputSchemaFacade = PlanCompileExecuteInputSchema.extend({
  idempotency_key: z.string().trim().min(1).max(200).optional(),
});

export type PlanCompileExecuteFacadeInput = z.infer<typeof PlanCompileExecuteInputSchemaFacade>;
export type PlanCompileExecuteFacadeOutput = z.infer<typeof PlanCompileExecuteOutputSchema>;

/**
 * Compute a deterministic SHA-256 digest from the provided planner payload. The
 * helper is exported so tests can assert fingerprints without duplicating the
 * hashing logic in the façade implementation.
 */
export function hashPlanPayload(plan: PlanCompileExecuteInput["plan"]): string {
  const serialised =
    typeof plan === "string"
      ? plan
      : JSON.stringify(plan, (_key, value) => {
          if (value instanceof Map) {
            return Array.from(value.entries());
          }
          if (value instanceof Set) {
            return Array.from(value.values());
          }
          return value;
        });
  return createHash("sha256").update(serialised).digest("hex");
}
