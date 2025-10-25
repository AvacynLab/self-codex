import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  BudgetExceededError,
  type BudgetCharge,
} from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import {
  buildIdempotencyCacheKey,
  IdempotencyRegistry,
} from "../infra/idempotency.js";
import type {
  ToolBudgets,
  ToolImplementation,
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
} from "../mcp/registry.js";
import {
  PlanCompileExecuteInputSchemaFacade,
  PlanCompileExecuteOutputSchema,
  PlanCompileExecuteStatsSchema,
  hashPlanPayload,
  type PlanCompileExecuteDryRunReport,
  type PlanCompileExecuteFacadeInput,
  type PlanCompileExecuteFacadeOutput,
} from "../rpc/schemas.js";
import { buildToolErrorResult, buildToolSuccessResult } from "./shared.js";
import {
  PlanSpecificationError,
  type PlannerPlan,
} from "../planner/domain.js";
import {
  PlanSchedulingError,
  type PlanSchedule,
} from "../planner/schedule.js";
import { coerceNullToUndefined } from "../utils/object.js";
import {
  handlePlanCompileExecute,
  type PlanCompileExecuteInput,
  type PlanCompileExecuteResult,
  type PlanToolContext,
} from "./planTools.js";
import type { CompiledBehaviorTree, BehaviorNodeDefinition } from "../executor/bt/types.js";

/** Canonical façade identifier registered in the MCP catalogue. */
export const PLAN_COMPILE_EXECUTE_TOOL_NAME = "plan_compile_execute" as const;

/**
 * Manifest draft exposed to the {@link ToolRegistry}. Budgets are conservative
 * yet generous enough for sizeable plans while keeping responses under 32 KiB by
 * default so the façade remains usable over constrained transports.
 */
export const PlanCompileExecuteManifestDraft: ToolManifestDraft = {
  name: PLAN_COMPILE_EXECUTE_TOOL_NAME,
  title: "Compiler et planifier un document de plan",
  description:
    "Compile un plan déclaratif en Behaviour Tree exécutable, calcule le calendrier critique et enregistre l'exécution dans le registre lifecycle.",
  kind: "dynamic",
  category: "plan",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 10_000,
    tool_calls: 1,
    bytes_out: 32_768,
  },
};

/** Context dependencies injected by the orchestrator when registering the façade. */
export interface PlanCompileExecuteToolContext {
  /** Planner runtime exposing compilation and lifecycle coordination primitives. */
  readonly plan: PlanToolContext;
  /** Structured logger used for observability and audit trails. */
  readonly logger: StructuredLogger;
  /** Optional idempotency registry replaying cached compilation results. */
  readonly idempotency?: IdempotencyRegistry;
  /** Optional helper returning manifest budgets for downstream dry-run previews. */
  readonly resolveBudget?: (tool: string) => ToolBudgets | undefined;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Snapshot persisted in the idempotency registry. */
interface PlanCompileExecuteSnapshot {
  readonly output: PlanCompileExecuteFacadeOutput;
}

/** Fingerprint persisted alongside idempotency entries. */
interface PlanCompileExecuteFingerprint {
  readonly plan_hash: string;
  readonly dry_run: boolean;
  readonly run_id?: string;
  readonly op_id?: string;
  readonly job_id?: string;
  readonly graph_id?: string;
  readonly node_id?: string;
  readonly child_id?: string;
}

/**
 * Builds the idempotency fingerprint while omitting optional identifiers when the
 * façade input leaves them undefined. Returning a compact object keeps the
 * computed hash stable once `exactOptionalPropertyTypes` enforces strict
 * optional semantics.
 */
export function createPlanCompileExecuteFingerprint(
  planHash: string,
  input: PlanCompileExecuteInput,
): PlanCompileExecuteFingerprint {
  const runId = coerceNullToUndefined(input.run_id);
  const opId = coerceNullToUndefined(input.op_id);
  const jobId = coerceNullToUndefined(input.job_id);
  const graphId = coerceNullToUndefined(input.graph_id);
  const nodeId = coerceNullToUndefined(input.node_id);
  const childId = coerceNullToUndefined(input.child_id);

  return {
    plan_hash: planHash,
    dry_run: input.dry_run ?? true,
    ...(runId !== undefined ? { run_id: runId } : {}),
    ...(opId !== undefined ? { op_id: opId } : {}),
    ...(jobId !== undefined ? { job_id: jobId } : {}),
    ...(graphId !== undefined ? { graph_id: graphId } : {}),
    ...(nodeId !== undefined ? { node_id: nodeId } : {}),
    ...(childId !== undefined ? { child_id: childId } : {}),
  };
}

/** Serialises the structured output for the textual MCP channel. */
function asJsonPayload(output: PlanCompileExecuteFacadeOutput): string {
  return JSON.stringify({ tool: PLAN_COMPILE_EXECUTE_TOOL_NAME, result: output }, null, 2);
}

/**
 * Estimate the request footprint in bytes so the budget tracker can account for
 * inbound payload pressure even when the caller provided a structured document.
 */
function estimatePlanBytes(plan: PlanCompileExecuteFacadeInput["plan"]): number {
  if (typeof plan === "string") {
    return Buffer.byteLength(plan, "utf8");
  }
  return Buffer.byteLength(JSON.stringify(plan), "utf8");
}

/** Map façade input to the primitive schema expected by {@link handlePlanCompileExecute}. */
function mapFacadeInputToPrimitive(
  input: PlanCompileExecuteFacadeInput,
): PlanCompileExecuteInput {
  const { idempotency_key: _ignored, ...rest } = input;
  return rest as PlanCompileExecuteInput;
}

/** Limit preview arrays to keep responses compact while remaining informative. */
const MAX_PREVIEW_ITEMS = 10;

type DryRunReport = PlanCompileExecuteDryRunReport;
type DryRunBudget = NonNullable<DryRunReport["cumulative_budget"]>;
type DryRunToolEstimate = DryRunReport["estimated_tool_calls"][number];

/**
 * Returns `true` when the manifest budgets expose at least one numerical
 * dimension. Prevents the dry-run report from emitting empty objects rejected by
 * the Zod schema guarding the façade output.
 */
function hasBudgetSignal(budget: ToolBudgets | undefined): budget is ToolBudgets {
  if (!budget) {
    return false;
  }
  return [budget.time_ms, budget.tool_calls, budget.bytes_out].some(
    (dimension) => typeof dimension === "number" && Number.isFinite(dimension) && dimension >= 0,
  );
}

/**
 * Multiplies the manifest budget by the expected number of invocations and
 * coerces the result into a safe integer, clamping negative values that could
 * otherwise trip the façade validation logic.
 */
function normaliseBudgetValue(value: number | undefined, multiplier: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const scaled = value * multiplier;
  const rounded = Math.round(scaled);
  return rounded < 0 ? 0 : rounded;
}

/**
 * Folds manifest budgets into a cumulative accumulator so dry-run responses can
 * surface an overall envelope while keeping the per-tool estimates intact.
 */
function accumulateBudget(
  totals: Partial<DryRunBudget>,
  budget: ToolBudgets | undefined,
  multiplier: number,
): void {
  if (!hasBudgetSignal(budget)) {
    return;
  }
  const time = normaliseBudgetValue(budget.time_ms, multiplier);
  const bytes = normaliseBudgetValue(budget.bytes_out, multiplier);
  if (typeof time === "number") {
    totals.time_ms = (totals.time_ms ?? 0) + time;
  }
  if (typeof bytes === "number") {
    totals.bytes_out = (totals.bytes_out ?? 0) + bytes;
  }
}

/**
 * Builds the dry-run analytics exposed to agents when they request a preview of
 * the orchestration cost. The helper remains side-effect free so it can be used
 * safely before the idempotency layer captures a snapshot.
 */
function computeDryRunReport(
  plan: PlannerPlan,
  resolveBudget: PlanCompileExecuteToolContext["resolveBudget"],
): DryRunReport | undefined {
  if (!plan.tasks.length) {
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const task of plan.tasks) {
    if (!task.tool) {
      continue;
    }
    counts.set(task.tool, (counts.get(task.tool) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return undefined;
  }

  const totals: Partial<DryRunBudget> = {};
  const estimates: DryRunToolEstimate[] = Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([tool, calls]) => {
      const manifestBudget = resolveBudget?.(tool);
      const estimate: DryRunToolEstimate = { tool, estimated_calls: calls };
      if (hasBudgetSignal(manifestBudget)) {
        const budget: DryRunToolEstimate["budget"] = {};
        const time = normaliseBudgetValue(manifestBudget.time_ms, calls);
        if (typeof time === "number") {
          budget.time_ms = time;
        }
        const bytes = normaliseBudgetValue(manifestBudget.bytes_out, calls);
        if (typeof bytes === "number") {
          budget.bytes_out = bytes;
        }
        const toolCalls = normaliseBudgetValue(manifestBudget.tool_calls, calls);
        if (typeof toolCalls === "number") {
          budget.tool_calls = toolCalls;
        }
        if (Object.keys(budget).length > 0) {
          estimate.budget = budget;
        }
        accumulateBudget(totals, manifestBudget, calls);
      }
      return estimate;
    });

  const totalCalls = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  const cumulative: DryRunBudget = { tool_calls: totalCalls, ...totals } as DryRunBudget;
  if (typeof cumulative.tool_calls !== "number" || Number.isNaN(cumulative.tool_calls)) {
    cumulative.tool_calls = totalCalls;
  }

  return {
    estimated_tool_calls: estimates,
    cumulative_budget: cumulative,
  } satisfies DryRunReport;
}

/** Build a concise plan preview emphasising tooling oriented metadata. */
function summarisePlan(plan: PlannerPlan) {
  const preview = plan.tasks.slice(0, MAX_PREVIEW_ITEMS).map((task) => ({
    id: task.id,
    name: task.name ?? null,
    tool: task.tool,
    depends_on: task.depends_on.slice(0, MAX_PREVIEW_ITEMS),
  }));
  return {
    id: plan.id,
    version: plan.version ?? null,
    title: plan.title ?? null,
    total_tasks: plan.tasks.length,
    preview_tasks: preview,
    ...(plan.metadata ? { metadata: structuredClone(plan.metadata) } : {}),
  };
}

/** Extract a lightweight view of the schedule phases. */
function summariseSchedule(schedule: PlanSchedule) {
  const phases = schedule.phases.slice(0, MAX_PREVIEW_ITEMS).map((phase) => ({
    index: phase.index,
    earliest_start_ms: phase.earliestStartMs,
    tasks: phase.tasks.slice(0, MAX_PREVIEW_ITEMS).map((task) => ({
      id: task.id,
      name: task.name ?? null,
      slack_ms: task.slackMs,
      estimated_duration_ms: task.estimatedDurationMs,
    })),
  }));
  return {
    critical_path: schedule.criticalPath.slice(0, 100),
    phases,
  };
}

/** Visit the behaviour tree to gather aggregated metrics. */
function summariseBehaviorTree(tree: CompiledBehaviorTree) {
  let totalNodes = 0;
  let taskNodes = 0;
  const leafTools = new Set<string>();
  const queue: BehaviorNodeDefinition[] = [tree.root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    totalNodes += 1;
    switch (node.type) {
      case "sequence":
      case "selector":
      case "parallel": {
        for (const child of node.children) {
          queue.push(child);
        }
        break;
      }
      case "retry":
      case "timeout":
      case "guard":
      case "cancellable": {
        queue.push(node.child);
        break;
      }
      case "task": {
        taskNodes += 1;
        if (node.tool) {
          leafTools.add(node.tool);
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  return {
    id: tree.id,
    root_type: tree.root.type,
    total_nodes: totalNodes,
    task_nodes: taskNodes,
    leaf_tools: Array.from(leafTools).slice(0, 32),
  };
}

/** Summarise binding maps by returning deterministic key samples. */
function summariseBindings(record: Record<string, unknown>) {
  const keys = Object.keys(record).sort();
  return {
    total: keys.length,
    keys: keys.slice(0, MAX_PREVIEW_ITEMS),
  };
}

/** Build the structured success payload returned by the façade. */
function buildSuccessOutput(
  idempotencyKey: string,
  result: PlanCompileExecuteResult,
  dryRunReport?: DryRunReport,
): PlanCompileExecuteFacadeOutput {
  const structured = PlanCompileExecuteOutputSchema.parse({
    ok: true,
    summary: `plan ${result.plan_id} compilé (${result.stats.total_tasks} tâches)`,
    details: {
      idempotency_key: idempotencyKey,
      run_id: result.run_id,
      op_id: result.op_id,
      plan_id: result.plan_id,
      plan_version: result.plan_version,
      dry_run: result.dry_run,
      registered: result.registered,
      idempotent: false,
      plan_hash: hashPlanPayload(result.plan),
      stats: PlanCompileExecuteStatsSchema.parse(result.stats),
      schedule: summariseSchedule(result.schedule),
      behavior_tree: summariseBehaviorTree(result.behavior_tree),
      plan_preview: summarisePlan(result.plan),
      variable_bindings: summariseBindings(result.variable_bindings),
      guard_conditions: summariseBindings(result.guard_conditions),
      postconditions: summariseBindings(result.postconditions),
      ...(dryRunReport ? { dry_run_report: dryRunReport } : {}),
    },
  });
  return structured;
}

/** Build a degraded output when budgets are exhausted. */
function buildBudgetExceededOutput(
  idempotencyKey: string,
  input: PlanCompileExecuteFacadeInput,
  error: BudgetExceededError,
): PlanCompileExecuteFacadeOutput {
  return PlanCompileExecuteOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant la compilation du plan",
    details: {
      idempotency_key: idempotencyKey,
      // Only surface the explicit plan identifier when the façade input carried
      // a structured document. Callers may provide raw JSON strings which omit
      // the `id` field; emitting `plan_id: undefined` would violate the
      // optional-field contract we are enforcing ahead of
      // `exactOptionalPropertyTypes`.
      ...(typeof input.plan === "object" && input.plan !== null && "id" in input.plan
        ? { plan_id: input.plan.id }
        : {}),
      budget: {
        reason: "budget_exhausted",
        dimension: error.dimension,
        attempted: error.attempted,
        remaining: error.remaining,
        limit: error.limit,
      },
    },
  });
}

/** Build diagnostics when the planner specification validation fails. */
function buildSpecificationErrorOutput(
  idempotencyKey: string,
  error: PlanSpecificationError,
): PlanCompileExecuteFacadeOutput {
  return PlanCompileExecuteOutputSchema.parse({
    ok: false,
    summary: "plan invalide, impossible de le compiler",
    details: {
      idempotency_key: idempotencyKey,
      error: {
        reason: "plan_invalid",
        message: error.message,
        code: error.code,
        details: error.details,
      },
    },
  });
}

/** Build diagnostics when the scheduler cannot compute a critical path. */
function buildSchedulingErrorOutput(
  idempotencyKey: string,
  error: PlanSchedulingError,
): PlanCompileExecuteFacadeOutput {
  return PlanCompileExecuteOutputSchema.parse({
    ok: false,
    summary: "échec de l'ordonnancement du plan",
    details: {
      idempotency_key: idempotencyKey,
      error: {
        reason: "plan_scheduling_failed",
        message: error.message,
        code: error.code,
        details: error.details,
      },
    },
  });
}

/** Build diagnostics for unexpected runtime errors. */
function buildExecutionErrorOutput(
  idempotencyKey: string,
  error: unknown,
): PlanCompileExecuteFacadeOutput {
  return PlanCompileExecuteOutputSchema.parse({
    ok: false,
    summary: "échec de la compilation du plan",
    details: {
      idempotency_key: idempotencyKey,
      error: {
        reason: "execution_failed",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && "code" in error && typeof (error as { code?: string }).code === "string"
          ? { code: (error as { code: string }).code }
          : {}),
      },
    },
  });
}

/**
 * Create the asynchronous MCP handler powering the façade. The handler handles
 * validation, budgets, idempotency and structured logging before delegating to
 * the lower level planner primitives.
 */
export function createPlanCompileExecuteHandler(
  context: PlanCompileExecuteToolContext,
): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = PlanCompileExecuteInputSchemaFacade.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, bytesIn: estimatePlanBytes(parsed.plan) },
          { actor: "facade", operation: PLAN_COMPILE_EXECUTE_TOOL_NAME, detail: "compile_plan" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          context.logger.warn("plan_compile_execute_budget_exhausted", {
            request_id: rpcContext.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          const degraded = buildBudgetExceededOutput(idempotencyKey, parsed, error);
          return buildToolErrorResult(asJsonPayload(degraded), degraded);
        }
        throw error;
      }
    }

    const primitiveInput = mapFacadeInputToPrimitive(parsed);
    const fingerprint = createPlanCompileExecuteFingerprint(
      hashPlanPayload(parsed.plan),
      primitiveInput,
    );

    const execute = async (): Promise<PlanCompileExecuteSnapshot> => {
      try {
        const result = handlePlanCompileExecute(context.plan, primitiveInput);
        const dryRunReport = result.dry_run ? computeDryRunReport(result.plan, context.resolveBudget) : undefined;
        return { output: buildSuccessOutput(idempotencyKey, result, dryRunReport) };
      } catch (error) {
        if (rpcContext?.budget && charge) {
          rpcContext.budget.snapshot();
        }
        if (error instanceof PlanSpecificationError) {
          const degraded = buildSpecificationErrorOutput(idempotencyKey, error);
          return { output: degraded };
        }
        if (error instanceof PlanSchedulingError) {
          const degraded = buildSchedulingErrorOutput(idempotencyKey, error);
          return { output: degraded };
        }
        const degraded = buildExecutionErrorOutput(idempotencyKey, error);
        return { output: degraded };
      }
    };

    try {
      let snapshot: PlanCompileExecuteSnapshot;
      let idempotent = false;
      if (context.idempotency) {
        const cacheKey = buildIdempotencyCacheKey(
          PLAN_COMPILE_EXECUTE_TOOL_NAME,
          idempotencyKey,
          fingerprint,
        );
        const hit = await context.idempotency.remember(cacheKey, execute);
        snapshot = hit.value;
        idempotent = hit.idempotent;
      } else {
        snapshot = await execute();
      }

      let structured = snapshot.output;
      if (structured.ok && structured.details.idempotent !== idempotent) {
        structured = PlanCompileExecuteOutputSchema.parse({
          ok: true,
          summary: structured.summary,
          details: { ...structured.details, idempotent },
        });
      }

      if (rpcContext?.budget && charge) {
        rpcContext.budget.snapshot();
      }

      if (structured.ok) {
        context.logger.info("plan_compile_execute_completed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          plan_id: structured.details.plan_id ?? null,
          run_id: structured.details.run_id ?? null,
          op_id: structured.details.op_id ?? null,
          dry_run: structured.details.dry_run ?? null,
          idempotent,
        });
      } else {
        const error = structured.details.error;
        context.logger.warn("plan_compile_execute_degraded", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          plan_id: structured.details.plan_id ?? null,
          reason: error?.reason ?? structured.details.budget?.reason ?? "unknown",
        });
      }

      const payload = asJsonPayload(structured);
      return structured.ok
        ? buildToolSuccessResult(payload, structured)
        : buildToolErrorResult(payload, structured);
    } catch (error) {
      if (rpcContext?.budget && charge) {
        rpcContext.budget.refund(charge);
      }
      context.logger.error("plan_compile_execute_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/** Register the façade inside the {@link ToolRegistry}. */
export async function registerPlanCompileExecuteTool(
  registry: ToolRegistry,
  context: PlanCompileExecuteToolContext,
): Promise<ToolManifest> {
  return await registry.register(PlanCompileExecuteManifestDraft, createPlanCompileExecuteHandler(context), {
    inputSchema: PlanCompileExecuteInputSchemaFacade.shape,
    outputSchema: PlanCompileExecuteOutputSchema.shape,
    annotations: { intent: PLAN_COMPILE_EXECUTE_TOOL_NAME },
  });
}
