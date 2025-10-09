import { randomUUID } from "crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { compileHierGraphToBehaviorTree } from "../executor/bt/compiler.js";
import { BehaviorTreeInterpreter, buildBehaviorTree } from "../executor/bt/interpreter.js";
import { CompiledBehaviorTreeSchema, } from "../executor/bt/types.js";
import { ReactiveScheduler, } from "../executor/reactiveScheduler.js";
import { ExecutionLoop } from "../executor/loop.js";
import { PlanLifecycleFeatureDisabledError, } from "../executor/planLifecycle.js";
import { BbSetInputSchema } from "./coordTools.js";
import { ConsensusConfigSchema, majority as computeConsensusMajority, normaliseConsensusOptions, publishConsensusEvent, quorum as computeConsensusQuorum, weighted as computeConsensusWeighted, } from "../coord/consensus.js";
import { ensureDirectory, resolveWithin } from "../paths.js";
import { PromptTemplateSchema, PromptVariablesSchema, renderPromptTemplate, } from "../prompts.js";
import { applyAll, createInlineSubgraphRule, createRerouteAvoidRule, createSplitParallelRule } from "../graph/rewrite.js";
import { resolveOperationId } from "./operationIds.js";
import { flatten } from "../graph/hierarchy.js";
import { registerCancellation, unregisterCancellation, OperationCancelledError, } from "../executor/cancel.js";
import { BehaviorTreeCancellationError } from "../executor/bt/nodes.js";
import { GraphDescriptorSchema, normaliseGraphDescriptor } from "./graphTools.js";
/** Error raised when Behaviour Tree tasks require a disabled blackboard module. */
class BlackboardFeatureDisabledError extends Error {
    code = "E-BB-DISABLED";
    hint = "enable_blackboard";
    constructor() {
        super("blackboard module disabled");
        this.name = "BlackboardFeatureDisabledError";
    }
}
/** Ensure a blackboard is available before Behaviour Tree tasks attempt to use it. */
function requireBlackboard(context) {
    if (!context.blackboard) {
        throw new BlackboardFeatureDisabledError();
    }
    return context.blackboard;
}
/**
 * Guard helper ensuring that lifecycle-aware tools are only invoked when the
 * lifecycle registry is available. Logging at warn level makes it easier for
 * operators to diagnose why a request degraded to an explicit lifecycle
 * feature error when the toggle is disabled.
 */
function requirePlanLifecycle(context, tool, runId) {
    if (!context.planLifecycle || context.planLifecycleFeatureEnabled === false) {
        context.logger.warn("plan_lifecycle_feature_unavailable", {
            tool,
            run_id: runId,
        });
        throw new PlanLifecycleFeatureDisabledError();
    }
    return context.planLifecycle;
}
/** Serialise a blackboard entry using the public API shape expected by callers. */
function serialiseBlackboardEntry(snapshot) {
    return {
        key: snapshot.key,
        value: snapshot.value,
        tags: snapshot.tags,
        created_at: snapshot.createdAt,
        updated_at: snapshot.updatedAt,
        expires_at: snapshot.expiresAt,
        version: snapshot.version,
    };
}
/** Derive a scheduling importance score from a blackboard event. */
function deriveBlackboardImportance(event) {
    const tags = event.entry?.tags ?? event.previous?.tags ?? [];
    const lowered = new Set(tags.map((tag) => tag.toLowerCase()));
    if (lowered.has("critical") || lowered.has("urgent")) {
        return 3;
    }
    if (lowered.has("high") || lowered.has("priority")) {
        return 2;
    }
    return event.kind === "set" ? 1 : 0.5;
}
/**
 * Produces a compact JSON-serialisable summary suitable for causal memory
 * storage. Large strings are truncated and deep objects are collapsed to keep
 * artefacts lightweight while preserving signal for diagnostics.
 */
function summariseForCausalMemory(value, depth = 0) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    if (Array.isArray(value)) {
        if (depth >= 2) {
            return `array(${value.length})`;
        }
        const window = value.slice(0, 5).map((item) => summariseForCausalMemory(item, depth + 1));
        if (value.length > 5) {
            window.push(`…${value.length - 5} more`);
        }
        return window;
    }
    if (typeof value === "object" && value !== undefined) {
        if (depth >= 2) {
            return "object";
        }
        const entries = Object.entries(value);
        const summary = {};
        for (const [key, entry] of entries.slice(0, 6)) {
            summary[key] = summariseForCausalMemory(entry, depth + 1);
        }
        if (entries.length > 6) {
            summary.__truncated__ = `${entries.length - 6} more`;
        }
        return summary;
    }
    if (typeof value === "undefined") {
        return null;
    }
    return String(value);
}
/**
 * Await for a duration while respecting cooperative cancellation. The helper
 * removes listeners eagerly to keep fake timers based tests deterministic and
 * leak-free.
 */
async function waitWithCancellation(handle, ms) {
    handle.throwIfCancelled();
    if (ms <= 0) {
        return;
    }
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(handle.toError());
        };
        const cleanup = () => {
            clearTimeout(timer);
            handle.signal.removeEventListener("abort", onAbort);
        };
        handle.signal.addEventListener("abort", onAbort, { once: true });
    });
}
/**
 * Normalise cancellation reasons exposed by the Behaviour Tree runtime so the
 * MCP tools can surface consistent telemetry and error payloads.
 */
function extractCancellationReason(error) {
    if (error instanceof OperationCancelledError) {
        return error.details.reason ?? null;
    }
    const candidate = error.cause;
    if (candidate instanceof OperationCancelledError) {
        return candidate.details.reason ?? null;
    }
    if (candidate instanceof Error) {
        const trimmed = candidate.message.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    const message = error.message.trim();
    return message.length > 0 ? message : null;
}
/**
 * Convert Behaviour Tree level cancellations into structured operation errors
 * carrying the run/op identifiers managed by the plan tooling.
 */
function normalisePlanCancellationError(handle, error) {
    if (error instanceof OperationCancelledError) {
        return { reason: extractCancellationReason(error), operationError: error };
    }
    const reason = extractCancellationReason(error);
    const operationError = new OperationCancelledError({
        opId: handle.opId,
        runId: handle.runId,
        jobId: handle.jobId,
        graphId: handle.graphId,
        nodeId: handle.nodeId,
        childId: handle.childId,
        reason,
    });
    return { reason, operationError };
}
function serialiseValueGuardDecision(decision) {
    if (!decision) {
        return null;
    }
    return {
        allowed: decision.allowed,
        score: decision.score,
        total: decision.total,
        threshold: decision.threshold,
        violations: decision.violations,
    };
}
/** Error raised when every fan-out branch violates the configured values. */
export class ValueGuardRejectionError extends Error {
    code = "E-VALUES-VIOLATION";
    rejections;
    constructor(rejections) {
        super("All planned children were rejected by the value guard");
        this.name = "ValueGuardRejectionError";
        this.rejections = rejections;
    }
}
/**
 * Error raised when a plan declares risky impacts while the value guard module
 * is disabled. The orchestrator refuses to execute such plans so unvetted
 * network or file side effects never occur without the guard explicitly
 * enabled.
 */
export class ValueGuardRequiredError extends Error {
    code = "E-VALUES-REQUIRED";
    hint = "enable_value_guard";
    children;
    constructor(children) {
        const label = children.length === 1 ? `child "${children[0]}"` : `${children.length} children`;
        super(`value guard must be enabled before dispatching ${label} with declared risks`);
        this.name = "ValueGuardRequiredError";
        this.children = [...children];
    }
}
/**
 * Error raised when consensus-based reducers cannot reach the required quorum.
 * The decision payload is embedded so operators can inspect tallies when
 * debugging the rejection.
 */
export class ConsensusNoQuorumError extends Error {
    code = "E-CONSENSUS-NO-QUORUM";
    details;
    constructor(decision) {
        super("Consensus reducer failed to reach the required quorum");
        this.name = "ConsensusNoQuorumError";
        this.details = { decision };
    }
}
/**
 * Error raised when Behaviour Tree execution exceeds the configured runtime
 * budget. The caller receives the timeout so it can adjust thresholds or retry
 * with a simplified plan.
 */
export class BehaviorTreeRunTimeoutError extends Error {
    code = "E-BT-RUN-TIMEOUT";
    details;
    constructor(timeoutMs) {
        super(`Behaviour Tree execution timed out after ${timeoutMs}ms`);
        this.name = "BehaviorTreeRunTimeoutError";
        this.details = { timeoutMs };
    }
}
/** Schema validating scalar graph attribute values used by the BT compiler. */
const GraphAttributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);
/** Schema describing task nodes within a hierarchical graph. */
const HierTaskNodeSchema = z.object({
    id: z.string().min(1),
    kind: z.literal("task"),
    label: z.string().optional(),
    attributes: z.record(GraphAttributeValueSchema).default({}),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
});
/** Schema describing sub-graph nodes within a hierarchical graph. */
const HierSubgraphNodeSchema = z.object({
    id: z.string().min(1),
    kind: z.literal("subgraph"),
    ref: z.string().min(1),
    params: z.record(z.unknown()).optional(),
});
/** Schema describing hierarchical graph edges. */
const HierEdgeSchema = z.object({
    id: z.string().min(1),
    from: z.object({ nodeId: z.string().min(1), port: z.string().optional() }),
    to: z.object({ nodeId: z.string().min(1), port: z.string().optional() }),
    label: z.string().optional(),
    attributes: z.record(GraphAttributeValueSchema).optional(),
});
/** Schema validating hierarchical graph payloads. */
const HierGraphSchema = z.object({
    id: z.string().min(1),
    nodes: z
        .array(z.discriminatedUnion("kind", [HierTaskNodeSchema, HierSubgraphNodeSchema]))
        .min(1),
    edges: z.array(HierEdgeSchema).default([]),
});
/** Schema validating plan rewrite options accepted by the dry-run tool. */
const PlanDryRunRewriteOptionsSchema = z
    .object({
    avoid_node_ids: z.array(z.string().min(1)).max(64).optional(),
    avoid_labels: z.array(z.string().min(1)).max(64).optional(),
})
    .strict();
/** Schema allowing callers to explicitly declare reroute avoid lists. */
const PlanDryRunRerouteAvoidSchema = z
    .object({
    node_ids: z.array(z.string().min(1)).max(64).optional(),
    labels: z.array(z.string().min(1)).max(64).optional(),
})
    .strict();
/** Schema allowing callers to provide either hierarchical or normalised graphs. */
const PlanDryRunGraphSchema = z.union([HierGraphSchema, GraphDescriptorSchema]);
/** Declarative impact payload plugged into the value guard. */
const ValueImpactSchema = z
    .object({
    value: z.string().min(1, "value impact must reference a value id"),
    impact: z.enum(["support", "risk"]).default("risk"),
    severity: z.number().min(0).max(1).optional(),
    rationale: z.string().min(1).max(240).optional(),
    source: z.string().min(1).optional(),
})
    .strict();
/** Schema describing a value impact declared directly on a plan node. */
const PlanNodeImpactSchema = z
    .object({
    value: z.string().min(1, "value impact must reference a value id"),
    impact: z.enum(["support", "risk"]).default("risk"),
    severity: z.number().min(0).max(1).optional(),
    rationale: z.string().min(1).max(240).optional(),
    source: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
})
    .strict();
/** Blueprint for a single child produced by the fan-out planner. */
const ChildPlanSchema = z.object({
    name: z.string().min(1, "child name must not be empty"),
    runtime: z.string().optional(),
    system: z.string().optional(),
    goals: z.array(z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    manifest_extras: z.record(z.unknown()).optional(),
    prompt_variables: PromptVariablesSchema.optional(),
    ttl_s: z.number().int().positive().optional(),
    value_impacts: z.array(ValueImpactSchema).max(32).optional(),
});
/** List-based specification of the clones that must be spawned. */
const ChildrenListSpecSchema = z.object({
    list: z.array(ChildPlanSchema).min(1, "at least one child must be defined"),
});
/** Count-based specification used when the caller only provides a target size. */
const ChildrenCountSpecSchema = z.object({
    count: z.number().int().positive(),
    name_prefix: z.string().default("clone"),
    runtime: z.string().optional(),
    system: z.string().optional(),
    goals: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    manifest_extras: z.record(z.unknown()).optional(),
    prompt_variables: PromptVariablesSchema.optional(),
    value_impacts: z.array(ValueImpactSchema).max(32).optional(),
});
/** Union describing the two accepted ways of declaring the fan-out. */
const ChildrenSpecSchema = z.union([
    ChildrenListSpecSchema,
    ChildrenCountSpecSchema,
]);
/** Schema configuring retries performed while spawning the clones. */
const RetryPolicySchema = z.object({
    max_attempts: z.number().int().min(1).max(5).default(1),
    delay_ms: z.number().int().min(0).max(60_000).default(200),
});
/**
 * Optional correlation metadata shared across plan tooling. The identifiers
 * mirror the hints exposed by the value guard APIs so orchestration systems
 * can stitch dry-runs, live executions and downstream telemetry together.
 */
const PlanCorrelationHintsSchema = z
    .object({
    run_id: z.string().min(1).optional(),
    op_id: z.string().min(1).optional(),
    job_id: z.string().min(1).optional(),
    graph_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    child_id: z.string().min(1).optional(),
})
    .strict();
/** Input payload accepted by the `plan_fanout` tool. */
export const PlanFanoutInputSchema = z
    .object({
    goal: z.string().optional(),
    prompt_template: PromptTemplateSchema,
    children_spec: ChildrenSpecSchema.optional(),
    /** Legacy field preserved for backward compatibility with earlier tasks. */
    children: z.array(ChildPlanSchema).optional(),
    parallelism: z.number().int().positive().max(16).optional(),
    retry: RetryPolicySchema.optional(),
    run_label: z
        .string()
        .regex(/^[a-zA-Z0-9_.-]+$/, "run_label must remain filesystem friendly")
        .optional(),
})
    .extend(PlanCorrelationHintsSchema.shape);
export const PlanFanoutInputShape = PlanFanoutInputSchema.shape;
/** Schema describing the supported join policies. */
const JoinPolicySchema = z.enum(["all", "first_success", "quorum"]);
/** Input payload accepted by the `plan_join` tool. */
export const PlanJoinInputSchema = z
    .object({
    children: z.array(z.string().min(1)).min(1),
    join_policy: JoinPolicySchema.default("all"),
    timeout_sec: z.number().int().positive().optional(),
    quorum_count: z.number().int().positive().optional(),
    consensus: ConsensusConfigSchema.optional(),
})
    .extend(PlanCorrelationHintsSchema.shape);
export const PlanJoinInputShape = PlanJoinInputSchema.shape;
/** Input payload accepted by the `plan_reduce` tool. */
export const PlanReduceInputSchema = z
    .object({
    children: z.array(z.string().min(1)).min(1),
    reducer: z.enum(["concat", "merge_json", "vote", "custom"]),
    spec: z.record(z.unknown()).optional(),
})
    .extend(PlanCorrelationHintsSchema.shape);
export const PlanReduceInputShape = PlanReduceInputSchema.shape;
/**
 * Input payload accepted by the `plan_compile_bt` tool.
 *
 * The schema is marked as strict to ensure CI catches payloads that carry
 * unexpected properties which would otherwise be silently ignored during
 * behaviour tree compilation.
 */
export const PlanCompileBTInputSchema = z
    .object({
    graph: HierGraphSchema,
})
    .strict();
export const PlanCompileBTInputShape = PlanCompileBTInputSchema.shape;
/**
 * Input payload accepted by the `plan_run_bt` tool.
 *
 * Extra keys are rejected via `.strict()` so orchestration payloads cannot leak
 * unintended flags into the execution loop.
 */
export const PlanRunBTInputSchema = z
    .object({
    tree: CompiledBehaviorTreeSchema,
    variables: z.record(z.unknown()).default({}),
    dry_run: z.boolean().default(false),
    timeout_ms: z.number().int().min(1).max(60_000).optional(),
})
    .extend(PlanCorrelationHintsSchema.shape)
    .extend({ idempotency_key: z.string().min(1).optional() })
    .strict();
export const PlanRunBTInputShape = PlanRunBTInputSchema.shape;
/**
 * Input payload accepted by the `plan_run_reactive` tool.
 *
 * `.strict()` keeps the scheduler loop deterministic by preventing stray fields
 * from slipping into the runtime budget configuration.
 */
export const PlanRunReactiveInputSchema = z
    .object({
    tree: CompiledBehaviorTreeSchema,
    variables: z.record(z.unknown()).default({}),
    tick_ms: z.number().int().min(10).max(5_000).default(100),
    budget_ms: z.number().int().min(1).max(5_000).optional(),
    timeout_ms: z.number().int().min(1).max(300_000).optional(),
    dry_run: z.boolean().default(false),
})
    .extend(PlanCorrelationHintsSchema.shape)
    .extend({ idempotency_key: z.string().min(1).optional() })
    .strict();
export const PlanRunReactiveInputShape = PlanRunReactiveInputSchema.shape;
/**
 * Schema validating the payload accepted by the `plan_dry_run` tool.
 *
 * The dry-run accepts either a hierarchical graph (compiled on the fly) or an
 * explicit Behaviour Tree along with optional per-node value impacts. At least
 * one of `graph`, `tree`, `nodes`, or `impacts` must be provided so the helper
 * can build a meaningful preview for operators.
 */
const PlanDryRunBaseSchema = z
    .object({
    plan_id: z.string().min(1, "plan identifier must not be empty"),
    plan_label: z.string().min(1).max(200).optional(),
    threshold: z.number().min(0).max(1).optional(),
    graph: PlanDryRunGraphSchema.optional(),
    tree: CompiledBehaviorTreeSchema.optional(),
    nodes: z
        .array(z
        .object({
        id: z.string().min(1, "node identifier must not be empty"),
        label: z.string().min(1).max(200).optional(),
        value_impacts: z.array(PlanNodeImpactSchema).max(32).optional(),
    })
        .strict())
        .max(128)
        .optional(),
    impacts: z.array(PlanNodeImpactSchema).max(128).optional(),
    rewrite: PlanDryRunRewriteOptionsSchema.optional(),
    reroute_avoid: PlanDryRunRerouteAvoidSchema.optional(),
})
    .extend(PlanCorrelationHintsSchema.shape)
    .strict();
export const PlanDryRunInputSchema = PlanDryRunBaseSchema.superRefine((value, ctx) => {
    if (!value.graph && !value.tree && !value.nodes && !value.impacts) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "at least one of graph, tree, nodes or impacts must be provided",
            path: [],
        });
    }
});
export const PlanDryRunInputShape = PlanDryRunBaseSchema.shape;
/**
 * Schema validating plan lifecycle tool inputs that reference a specific run.
 */
const PlanLifecycleRunSchema = z
    .object({
    run_id: z.string().min(1, "run_id must not be empty"),
})
    .strict();
export const PlanStatusInputSchema = PlanLifecycleRunSchema;
export const PlanStatusInputShape = PlanStatusInputSchema.shape;
export const PlanPauseInputSchema = PlanLifecycleRunSchema;
export const PlanPauseInputShape = PlanPauseInputSchema.shape;
export const PlanResumeInputSchema = PlanLifecycleRunSchema;
export const PlanResumeInputShape = PlanResumeInputSchema.shape;
/** Default schema registry used by the Behaviour Tree interpreter. */
const BehaviorTaskSchemas = {
    noop: z.any(),
    bb_set: BbSetInputSchema,
    wait: z
        .object({
        duration_ms: z.number().int().min(1).max(60_000).default(100),
    })
        .strict(),
};
/** Estimate the amount of work a Behaviour Tree represents for progress heuristics. */
function estimateBehaviorTreeWorkload(definition) {
    switch (definition.type) {
        case "sequence":
        case "selector":
        case "parallel": {
            return (1 +
                definition.children.reduce((sum, child) => sum + estimateBehaviorTreeWorkload(child), 0));
        }
        case "retry":
        case "timeout":
        case "guard":
        case "cancellable": {
            return 1 + estimateBehaviorTreeWorkload(definition.child);
        }
        case "task": {
            return 1;
        }
        default: {
            return 1;
        }
    }
}
function registerPlanLifecycleRun(context, options) {
    if (!context.planLifecycle) {
        return;
    }
    try {
        context.planLifecycle.registerRun({
            runId: options.runId,
            opId: options.opId,
            mode: options.mode,
            dryRun: options.dryRun,
            correlation: options.correlation ?? null,
            estimatedWork: options.estimatedWork ?? null,
        });
    }
    catch (error) {
        context.logger.warn("plan_lifecycle_register_failed", {
            run_id: options.runId,
            op_id: options.opId,
            mode: options.mode,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
function recordPlanLifecycleEvent(context, runId, phase, payload) {
    if (!context.planLifecycle) {
        return;
    }
    try {
        context.planLifecycle.recordEvent(runId, { phase, payload });
    }
    catch (error) {
        context.logger.warn("plan_lifecycle_event_failed", {
            run_id: runId,
            phase,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
function attachPlanLifecycleControls(context, runId, controls) {
    if (!context.planLifecycle) {
        return;
    }
    try {
        context.planLifecycle.attachControls(runId, controls);
    }
    catch (error) {
        context.logger.warn("plan_lifecycle_attach_failed", {
            run_id: runId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
/**
 * Serialises scheduler events into a JSON-friendly structure so lifecycle
 * snapshots can expose the underlying queue activity when observers replay
 * execution after re-enabling the feature.
 */
function normalisePheromoneBoundsForTelemetry(bounds) {
    if (!bounds) {
        return null;
    }
    return {
        min_intensity: bounds.minIntensity,
        max_intensity: Number.isFinite(bounds.maxIntensity) ? bounds.maxIntensity : null,
        normalisation_ceiling: bounds.normalisationCeiling,
    };
}
function summariseSchedulerEvent(event, payload) {
    switch (event) {
        case "taskReady": {
            const ready = payload;
            return {
                node_id: ready.nodeId,
                criticality: ready.criticality ?? null,
                pheromone: ready.pheromone ?? null,
                pheromone_bounds: normalisePheromoneBoundsForTelemetry(ready.pheromoneBounds),
            };
        }
        case "taskDone": {
            const done = payload;
            return {
                node_id: done.nodeId,
                success: done.success,
                duration_ms: done.duration_ms ?? null,
            };
        }
        case "blackboardChanged": {
            const change = payload;
            return {
                key: change.key,
                importance: change.importance ?? null,
            };
        }
        case "stigmergyChanged": {
            const change = payload;
            return {
                node_id: change.nodeId,
                intensity: change.intensity ?? null,
                type: change.type ?? null,
                bounds: normalisePheromoneBoundsForTelemetry(change.bounds),
            };
        }
        default:
            return {};
    }
}
const BehaviorToolHandlers = {
    noop: async (_context, input) => input ?? null,
    /**
     * Deterministic helper used by tests to simulate abort-like signals raised by
     * Behaviour Tree leaves. The error shape mirrors the `AbortError` instances
     * surfaced by platform runtimes when work is cancelled mid-flight.
     */
    abort: async () => {
        const error = new Error("behaviour tool aborted by test");
        error.name = "AbortError";
        throw error;
    },
    bb_set: async (context, input) => {
        const payload = BbSetInputSchema.parse(input ?? {});
        const blackboard = requireBlackboard(context);
        const snapshot = blackboard.set(payload.key, payload.value, {
            tags: payload.tags,
            ttlMs: payload.ttl_ms,
        });
        context.logger.info("bt_bb_set", {
            key: snapshot.key,
            version: snapshot.version,
            tags: snapshot.tags,
            ttl_ms: payload.ttl_ms ?? null,
        });
        return serialiseBlackboardEntry(snapshot);
    },
    /**
     * Cooperative wait primitive allowing plans to yield for a bounded duration
     * while still honouring cancellation requests. The helper leverages the
     * active cancellation handle when available so fake timers in tests remain
     * deterministic.
     */
    wait: async (context, input) => {
        const payload = BehaviorTaskSchemas.wait.parse(input ?? {});
        const handle = context.activeCancellation ?? null;
        if (handle) {
            await waitWithCancellation(handle, payload.duration_ms);
        }
        else {
            await delay(payload.duration_ms);
        }
        context.logger.info("bt_wait", { duration_ms: payload.duration_ms });
        return null;
    },
};
function resolveChildrenPlans(input, defaultRuntime) {
    if (input.children_spec) {
        if ("list" in input.children_spec) {
            return input.children_spec.list.map((child) => ({
                name: child.name,
                runtime: child.runtime ?? defaultRuntime,
                system: child.system,
                goals: child.goals,
                command: child.command,
                args: child.args,
                env: child.env,
                metadata: child.metadata,
                manifestExtras: child.manifest_extras,
                promptVariables: { ...(child.prompt_variables ?? {}) },
                ttlSeconds: child.ttl_s,
                valueImpacts: child.value_impacts?.map((impact) => ({ ...impact })),
            }));
        }
        const plans = [];
        const base = input.children_spec;
        for (let index = 0; index < base.count; index += 1) {
            plans.push({
                name: `${base.name_prefix}-${index + 1}`,
                runtime: base.runtime ?? defaultRuntime,
                system: base.system,
                goals: base.goals,
                metadata: base.metadata,
                manifestExtras: base.manifest_extras,
                promptVariables: {
                    ...(base.prompt_variables ?? {}),
                    child_index: index + 1,
                },
                valueImpacts: base.value_impacts?.map((impact) => ({ ...impact })),
            });
        }
        return plans;
    }
    if (input.children?.length) {
        return input.children.map((child) => ({
            name: child.name,
            runtime: child.runtime ?? defaultRuntime,
            system: child.system,
            goals: child.goals,
            command: child.command,
            args: child.args,
            env: child.env,
            metadata: child.metadata,
            manifestExtras: child.manifest_extras,
            promptVariables: { ...(child.prompt_variables ?? {}) },
            ttlSeconds: child.ttl_s,
            valueImpacts: child.value_impacts?.map((impact) => ({ ...impact })),
        }));
    }
    throw new Error("plan_fanout requires either children_spec or children to describe the clones");
}
function renderPromptForChild(template, variables) {
    const messages = renderPromptTemplate(template, { variables });
    const summary = messages
        .map((message) => `[${message.role}] ${message.content}`)
        .join("\n");
    return { messages, summary };
}
function buildFanoutChildMetadata(plan, variables, guardSnapshot, correlation) {
    const metadata = {
        ...(plan.metadata ?? {}),
        plan: "fanout",
        job_id: correlation.jobId,
        run_id: correlation.runId,
        op_id: correlation.opId,
        child_name: plan.name,
        prompt_variables: variables,
    };
    if (guardSnapshot) {
        metadata.value_guard = guardSnapshot;
    }
    if (correlation.graphId) {
        metadata.graph_id = correlation.graphId;
    }
    if (correlation.nodeId) {
        metadata.node_id = correlation.nodeId;
    }
    if (correlation.parentChildId) {
        metadata.parent_child_id = correlation.parentChildId;
    }
    return metadata;
}
function buildFanoutManifestExtras(plan, correlation) {
    const extras = {
        ...(plan.manifestExtras ?? {}),
        plan: "fanout",
        job_id: correlation.jobId,
        run_id: correlation.runId,
        op_id: correlation.opId,
    };
    if (correlation.graphId) {
        extras.graph_id = correlation.graphId;
    }
    if (correlation.nodeId) {
        extras.node_id = correlation.nodeId;
    }
    if (correlation.parentChildId) {
        extras.parent_child_id = correlation.parentChildId;
    }
    return extras;
}
async function spawnChildWithRetry(context, jobId, plan, template, sharedVariables, retryPolicy, childIndex, correlation, cancellation) {
    const childId = `child_${randomUUID()}`;
    const createdAt = Date.now();
    const guardDecision = plan.valueDecision ?? null;
    const guardSnapshot = serialiseValueGuardDecision(guardDecision);
    const correlationLogFields = {
        run_id: correlation.runId,
        op_id: correlation.opId,
        job_id: correlation.jobId,
        graph_id: correlation.graphId ?? null,
        node_id: correlation.nodeId ?? null,
        parent_child_id: correlation.parentChildId ?? null,
    };
    context.graphState.createChild(jobId, childId, {
        name: plan.name,
        system: plan.system,
        goals: plan.goals,
        runtime: plan.runtime,
    }, {
        createdAt,
        ttlAt: plan.ttlSeconds ? createdAt + plan.ttlSeconds * 1000 : null,
    });
    context.graphState.patchChild(childId, { state: "starting" });
    const variables = {
        ...plan.promptVariables,
        ...sharedVariables,
        child_name: plan.name,
        child_runtime: plan.runtime,
        child_index: childIndex,
    };
    const { messages, summary } = renderPromptForChild(template, variables);
    let attempt = 0;
    while (attempt < retryPolicy.max_attempts) {
        cancellation.throwIfCancelled();
        attempt += 1;
        try {
            context.logger.info("plan_fanout_spawn_attempt", {
                child_id: childId,
                name: plan.name,
                attempt,
                ...correlationLogFields,
            });
            const created = await context.supervisor.createChild({
                childId,
                command: plan.command,
                args: plan.args,
                env: plan.env,
                metadata: buildFanoutChildMetadata(plan, variables, guardSnapshot, correlation),
                manifestExtras: buildFanoutManifestExtras(plan, correlation),
                waitForReady: true,
            });
            cancellation.throwIfCancelled();
            const runtimeStatus = created.runtime.getStatus();
            context.graphState.syncChildIndexSnapshot(created.index);
            context.graphState.recordChildHeartbeat(childId, runtimeStatus.lastHeartbeatAt ?? Date.now());
            context.graphState.patchChild(childId, { state: "ready" });
            await context.supervisor.send(childId, {
                type: "prompt",
                content: summary,
                messages,
            });
            context.graphState.appendMessage(childId, {
                role: "user",
                content: summary,
                ts: Date.now(),
                actor: "orchestrator",
            });
            context.graphState.patchChild(childId, {
                state: "running",
                waitingFor: "response",
            });
            cancellation.throwIfCancelled();
            if (guardDecision && context.valueGuard) {
                context.valueGuard.registry.set(childId, guardDecision);
            }
            return {
                childId,
                name: plan.name,
                runtime: plan.runtime,
                promptSummary: summary,
                promptMessages: messages,
                promptVariables: variables,
                manifestPath: created.runtime.manifestPath,
                logPath: created.runtime.logPath,
                readyMessage: created.readyMessage
                    ? created.readyMessage.parsed ?? created.readyMessage.raw
                    : null,
                valueGuard: guardSnapshot,
            };
        }
        catch (error) {
            if (error instanceof OperationCancelledError) {
                context.logger.warn("plan_fanout_spawn_cancelled", {
                    child_id: childId,
                    name: plan.name,
                    attempt,
                    ...correlationLogFields,
                    reason: error.details.reason ?? null,
                });
                context.graphState.patchChild(childId, { state: "cancelled", waitingFor: null });
                throw error;
            }
            context.logger.error("plan_fanout_spawn_failed", {
                child_id: childId,
                name: plan.name,
                attempt,
                message: error instanceof Error ? error.message : String(error),
                ...correlationLogFields,
            });
            if (attempt >= retryPolicy.max_attempts) {
                context.graphState.patchChild(childId, { state: "error" });
                throw error;
            }
            if (retryPolicy.delay_ms > 0) {
                await delay(retryPolicy.delay_ms);
            }
        }
    }
    throw new Error("unreachable retry loop in plan_fanout");
}
/**
 * Executes the provided asynchronous tasks with a bounded concurrency level.
 *
 * The helper is aware of cancellation handles so long running fan-out
 * operations periodically observe the abort signal before picking the next
 * task and immediately after each awaited invocation. This ensures the
 * checklist requirement "Vérifier isCancelled avant/après chaque await" holds
 * without duplicating guard statements in every call site.
 */
async function runWithConcurrency(limit, tasks, options = {}) {
    if (tasks.length === 0) {
        return [];
    }
    const safeLimit = Math.max(1, Math.min(limit, tasks.length));
    const results = new Array(tasks.length);
    let index = 0;
    const cancellation = options.cancellation ?? null;
    async function worker() {
        while (true) {
            cancellation?.throwIfCancelled();
            const current = index;
            if (current >= tasks.length) {
                return;
            }
            index += 1;
            const task = tasks[current];
            const value = await task();
            cancellation?.throwIfCancelled();
            results[current] = value;
        }
    }
    const workers = Array.from({ length: safeLimit }, () => worker());
    await Promise.all(workers);
    return results;
}
/**
 * Spawns N children according to the provided plan, immediately pushes the
 * initial prompt to each runtime and records the mapping under
 * `children/run-<ts>/fanout.json` for auditability.
 */
export async function handlePlanFanout(context, input) {
    const resolvedPlans = resolveChildrenPlans(input, context.defaultChildRuntime);
    if (!context.valueGuard) {
        // Without the value guard we refuse to dispatch children that already
        // advertise risky impacts so unvetted side-effects (network writes, file
        // mutations…) never occur implicitly.
        const riskyPlans = resolvedPlans
            .filter((plan) => (plan.valueImpacts ?? []).some((impact) => impact.impact === "risk" && (impact.severity ?? 1) > 0))
            .map((plan) => plan.name);
        if (riskyPlans.length > 0) {
            throw new ValueGuardRequiredError(riskyPlans);
        }
    }
    const rejectedPlans = [];
    const plans = [];
    const providedCorrelation = extractPlanCorrelationHints(input);
    const opId = resolveOperationId(input.op_id ?? providedCorrelation?.opId, "plan_fanout_op");
    const runId = providedCorrelation?.runId ?? input.run_label ?? `run-${Date.now()}`;
    const jobId = providedCorrelation?.jobId ?? `job_${randomUUID()}`;
    const graphId = providedCorrelation?.graphId ?? null;
    const nodeId = providedCorrelation?.nodeId ?? null;
    const parentChildId = providedCorrelation?.childId ?? null;
    const mergedCorrelation = {
        ...(providedCorrelation ?? {}),
        opId,
        runId,
        jobId,
        graphId,
        nodeId,
        childId: parentChildId,
    };
    const eventCorrelation = toEventCorrelationHints(mergedCorrelation);
    const correlationPayload = serialiseCorrelationForPayload(eventCorrelation);
    const correlationLogFields = { ...correlationPayload };
    if (context.valueGuard) {
        for (const plan of resolvedPlans) {
            if (!plan.valueImpacts?.length) {
                plan.valueDecision = null;
                plans.push(plan);
                continue;
            }
            const decision = context.valueGuard.graph.filter({
                id: plan.name,
                label: plan.name,
                impacts: plan.valueImpacts,
            });
            plan.valueDecision = decision;
            if (!decision.allowed) {
                rejectedPlans.push({ name: plan.name, decision });
                context.logger.warn("plan_fanout_value_guard_reject", {
                    child_name: plan.name,
                    score: decision.score,
                    threshold: decision.threshold,
                    violations: decision.violations.length,
                    ...correlationLogFields,
                });
                continue;
            }
            plans.push(plan);
        }
        if (plans.length === 0) {
            throw new ValueGuardRejectionError(rejectedPlans);
        }
        if (rejectedPlans.length > 0) {
            context.logger.warn("plan_fanout_value_guard_filtered", {
                rejected: rejectedPlans.length,
                allowed: plans.length,
                ...correlationLogFields,
            });
        }
    }
    else {
        plans.push(...resolvedPlans);
    }
    const promptTemplate = {
        system: input.prompt_template.system,
        user: input.prompt_template.user,
        assistant: input.prompt_template.assistant,
    };
    const createdAt = Date.now();
    const existingJob = context.graphState.getJob(jobId);
    if (!existingJob) {
        context.graphState.createJob(jobId, {
            goal: input.goal,
            createdAt,
            state: "running",
        });
    }
    else {
        context.graphState.patchJob(jobId, {
            state: "running",
            goal: input.goal ?? existingJob.goal ?? null,
        });
    }
    context.logger.info("plan_fanout", {
        job_id: jobId,
        run_id: runId,
        op_id: opId,
        graph_id: graphId ?? null,
        node_id: nodeId ?? null,
        child_id: parentChildId ?? null,
        children: plans.length,
    });
    const correlationContext = {
        runId,
        opId,
        jobId,
        graphId,
        nodeId,
        parentChildId,
    };
    context.emitEvent({
        kind: "PLAN",
        jobId,
        childId: parentChildId ?? undefined,
        payload: {
            ...correlationPayload,
            children: plans.map((plan) => ({ name: plan.name, runtime: plan.runtime })),
            rejected: rejectedPlans.map((entry) => entry.name),
        },
        correlation: eventCorrelation,
    });
    const sharedVariables = {
        job_id: jobId,
        run_id: runId,
        op_id: opId,
    };
    if (input.goal) {
        sharedVariables.goal = input.goal;
    }
    if (graphId) {
        sharedVariables.graph_id = graphId;
    }
    if (nodeId) {
        sharedVariables.node_id = nodeId;
    }
    if (parentChildId) {
        sharedVariables.parent_child_id = parentChildId;
    }
    const retryPolicy = input.retry
        ? RetryPolicySchema.parse(input.retry)
        : RetryPolicySchema.parse({});
    const cancellation = registerCancellation(opId, {
        runId,
        jobId,
        graphId,
        nodeId,
        childId: parentChildId ?? null,
    });
    let cancellationSubscription = null;
    try {
        cancellationSubscription = cancellation.onCancel(({ reason }) => {
            context.logger.warn("plan_fanout_cancel_requested", {
                ...correlationLogFields,
                reason,
            });
        });
        const tasks = plans.map((plan, index) => () => spawnChildWithRetry(context, jobId, plan, promptTemplate, sharedVariables, retryPolicy, index + 1, correlationContext, cancellation));
        const parallelism = input.parallelism ?? Math.min(3, plans.length || 1);
        const spawned = await runWithConcurrency(parallelism, tasks, { cancellation });
        cancellation.throwIfCancelled();
        const runDirectory = await ensureDirectory(context.childrenRoot, runId);
        const mappingPath = resolveWithin(runDirectory, "fanout.json");
        const serialisedRejections = rejectedPlans.map((entry) => ({
            name: entry.name,
            value_guard: serialiseValueGuardDecision(entry.decision),
        }));
        const mappingPayload = {
            run_id: runId,
            op_id: opId,
            created_at: createdAt,
            job_id: jobId,
            graph_id: graphId,
            node_id: nodeId,
            child_id: parentChildId,
            goal: input.goal ?? null,
            prompt_template: input.prompt_template,
            children: spawned.map((child) => ({
                child_id: child.childId,
                name: child.name,
                runtime: child.runtime,
                prompt_variables: child.promptVariables,
                prompt_summary: child.promptSummary,
                manifest_path: child.manifestPath,
                log_path: child.logPath,
                value_guard: child.valueGuard,
            })),
            rejected_plans: serialisedRejections,
        };
        await writeFile(mappingPath, JSON.stringify(mappingPayload, null, 2), "utf8");
        return {
            run_id: runId,
            job_id: jobId,
            op_id: opId,
            graph_id: graphId,
            node_id: nodeId,
            child_id: parentChildId,
            child_ids: spawned.map((child) => child.childId),
            planned: spawned.map((child) => ({
                child_id: child.childId,
                name: child.name,
                runtime: child.runtime,
                prompt_variables: child.promptVariables,
                prompt_summary: child.promptSummary,
                prompt_messages: child.promptMessages,
                manifest_path: child.manifestPath,
                log_path: child.logPath,
                ready_message: child.readyMessage,
                value_guard: child.valueGuard,
            })),
            prompt_template: input.prompt_template,
            rejected_plans: serialisedRejections,
        };
    }
    catch (error) {
        if (error instanceof OperationCancelledError) {
            context.logger.warn("plan_fanout_cancelled", {
                ...correlationLogFields,
                reason: error.details.reason ?? null,
            });
        }
        throw error;
    }
    finally {
        cancellationSubscription?.();
        unregisterCancellation(opId);
    }
}
async function observeChildForJoin(context, childId, timeoutMs) {
    try {
        const existing = await context.supervisor.collect(childId);
        const isTerminal = (candidate) => {
            const parsed = candidate.parsed;
            return (parsed?.type === "response" ||
                parsed?.type === "error" ||
                parsed?.type === "shutdown");
        };
        const existingMatch = [...existing.messages].reverse().find(isTerminal);
        if (existingMatch) {
            const parsed = existingMatch.parsed;
            const status = parsed?.type === "response" ? "success" : "error";
            const summary = typeof parsed?.content === "string"
                ? parsed.content
                : parsed?.content
                    ? JSON.stringify(parsed.content)
                    : existingMatch.raw;
            return {
                childId,
                status,
                receivedAt: existingMatch.receivedAt,
                messageType: parsed?.type ?? null,
                summary,
                outputs: existing,
            };
        }
        const message = await context.supervisor.waitForMessage(childId, isTerminal, timeoutMs);
        const parsed = message.parsed;
        const status = parsed?.type === "response" ? "success" : "error";
        const summary = typeof parsed?.content === "string"
            ? parsed.content
            : parsed?.content
                ? JSON.stringify(parsed.content)
                : message.raw;
        const outputs = await context.supervisor.collect(childId);
        return {
            childId,
            status,
            receivedAt: message.receivedAt,
            messageType: parsed?.type ?? null,
            summary,
            outputs,
        };
    }
    catch (error) {
        let outputs = null;
        try {
            outputs = await context.supervisor.collect(childId);
        }
        catch {
            outputs = null;
        }
        return {
            childId,
            status: "timeout",
            receivedAt: null,
            messageType: null,
            summary: error instanceof Error
                ? error.message
                : `timeout:${String(error)}`,
            outputs,
        };
    }
}
/**
 * Waits for a collection of children to emit a terminal response and evaluates
 * the outcome according to the selected join policy.
 */
export async function handlePlanJoin(context, input) {
    const timeoutMs = (input.timeout_sec ?? 10) * 1000;
    const providedCorrelation = extractPlanCorrelationHints(input);
    const opId = resolveOperationId(input.op_id ?? providedCorrelation?.opId, "plan_join_op");
    const correlationSource = {
        ...(providedCorrelation ?? {}),
        opId,
    };
    const correlationHints = toEventCorrelationHints(correlationSource);
    const correlationPayload = serialiseCorrelationForPayload(correlationHints);
    context.logger.info("plan_join", {
        children: input.children.length,
        policy: input.join_policy,
        timeout_ms: timeoutMs,
        ...correlationPayload,
    });
    const observations = await Promise.all(input.children.map((childId) => observeChildForJoin(context, childId, timeoutMs)));
    const successes = observations.filter((obs) => obs.status === "success");
    const failures = observations.filter((obs) => obs.status !== "success");
    const sorted = [...observations].sort((a, b) => {
        if (a.receivedAt === null && b.receivedAt === null)
            return 0;
        if (a.receivedAt === null)
            return 1;
        if (b.receivedAt === null)
            return -1;
        return a.receivedAt - b.receivedAt;
    });
    const statusVotes = observations.map((obs) => ({
        voter: obs.childId,
        value: obs.status,
    }));
    const baseQuorum = input.quorum_count ?? Math.ceil(input.children.length / 2);
    const consensusConfig = input.consensus
        ? ConsensusConfigSchema.parse(input.consensus)
        : undefined;
    let consensusDecision = null;
    if (consensusConfig) {
        const options = normaliseConsensusOptions(consensusConfig);
        if (!options.preferValue) {
            options.preferValue = "success";
        }
        const { quorum: configuredQuorum, ...baseOptions } = options;
        switch (consensusConfig.mode) {
            case "majority":
                consensusDecision = computeConsensusMajority(statusVotes, baseOptions);
                break;
            case "weighted":
                consensusDecision = computeConsensusWeighted(statusVotes, {
                    ...baseOptions,
                    quorum: configuredQuorum ?? (input.join_policy === "quorum" ? baseQuorum : undefined),
                });
                break;
            case "quorum":
            default: {
                const quorumThreshold = configuredQuorum ?? baseQuorum;
                consensusDecision = computeConsensusQuorum(statusVotes, {
                    ...baseOptions,
                    quorum: quorumThreshold,
                });
                break;
            }
        }
    }
    if (!consensusDecision && input.join_policy === "quorum") {
        const defaults = normaliseConsensusOptions(undefined);
        defaults.preferValue = "success";
        const { quorum: configuredQuorum, ...baseOptions } = defaults;
        consensusDecision = computeConsensusQuorum(statusVotes, {
            ...baseOptions,
            quorum: configuredQuorum ?? baseQuorum,
        });
    }
    let satisfied = false;
    let threshold = null;
    switch (input.join_policy) {
        case "all":
            satisfied = failures.length === 0;
            break;
        case "first_success":
            satisfied = successes.length > 0;
            threshold = 1;
            break;
        case "quorum": {
            threshold = consensusDecision?.threshold ?? baseQuorum;
            if (consensusDecision) {
                satisfied =
                    consensusDecision.outcome === "success" && consensusDecision.satisfied;
            }
            else {
                satisfied = successes.length >= (threshold ?? baseQuorum);
            }
            break;
        }
        default:
            satisfied = false;
    }
    const winningChild = sorted.find((obs) => obs.status === "success")?.childId ?? null;
    const consensusPayload = consensusDecision
        ? {
            mode: consensusDecision.mode,
            outcome: consensusDecision.outcome,
            satisfied: consensusDecision.satisfied,
            tie: consensusDecision.tie,
            threshold: consensusDecision.threshold,
            total_weight: consensusDecision.totalWeight,
            tally: consensusDecision.tally,
        }
        : undefined;
    if (consensusDecision) {
        // Surface the computed quorum decision on the consensus event emitter so it
        // can be bridged onto the unified MCP bus. This keeps auditors informed of
        // every consensus evaluation performed during plan joins.
        publishConsensusEvent({
            kind: "decision",
            source: "plan_join",
            mode: consensusDecision.mode,
            outcome: consensusDecision.outcome,
            satisfied: consensusDecision.satisfied,
            tie: consensusDecision.tie,
            threshold: consensusDecision.threshold,
            totalWeight: consensusDecision.totalWeight,
            tally: consensusDecision.tally,
            votes: statusVotes.length,
            metadata: {
                policy: input.join_policy,
                successes: successes.length,
                failures: failures.length,
                winning_child_id: winningChild,
                quorum_threshold: threshold,
            },
            jobId: correlationHints.jobId ?? null,
            runId: correlationHints.runId ?? null,
            opId: correlationHints.opId ?? null,
        });
    }
    context.emitEvent({
        kind: "STATUS",
        jobId: correlationHints.jobId ?? undefined,
        childId: correlationHints.childId ?? undefined,
        payload: {
            ...correlationPayload,
            policy: input.join_policy,
            satisfied,
            successes: successes.length,
            failures: failures.length,
            consensus: consensusPayload,
        },
        correlation: correlationHints,
    });
    context.logger.info("plan_join_completed", {
        policy: input.join_policy,
        satisfied,
        successes: successes.length,
        failures: failures.length,
        winning_child_id: winningChild,
        consensus_mode: consensusPayload?.mode ?? null,
        consensus_outcome: consensusPayload?.outcome ?? null,
        ...correlationPayload,
    });
    return {
        op_id: opId,
        policy: input.join_policy,
        satisfied,
        timeout_ms: timeoutMs,
        success_count: successes.length,
        failure_count: failures.length,
        quorum_threshold: threshold,
        winning_child_id: winningChild,
        results: sorted.map((obs) => ({
            child_id: obs.childId,
            status: obs.status,
            received_at: obs.receivedAt,
            message_type: obs.messageType,
            summary: obs.summary,
            artifacts: obs.outputs?.artifacts ?? [],
        })),
        consensus: consensusPayload,
    };
}
function summariseChildOutputs(outputs) {
    if (!outputs.messages.length) {
        return null;
    }
    const last = outputs.messages[outputs.messages.length - 1];
    const parsed = last.parsed;
    if (typeof parsed?.content === "string") {
        return parsed.content;
    }
    if (parsed?.content) {
        return JSON.stringify(parsed.content);
    }
    return last.raw ?? null;
}
/**
 * Normalises a child summary into a consensus vote value.
 *
 * The reducer historically expected children to return JSON objects shaped as
 * `{ "vote": "A" }`. When the payloads also contain contextual metadata
 * (indices, timestamps, …) the raw string differs per child which prevents the
 * majority/quorum helpers from finding a winner. This helper extracts the
 * stabilised "vote" choice when present while keeping graceful fallbacks:
 *
 * - `{ vote: "A" }` ⇒ `"A"`
 * - `{ value: "B" }` ⇒ `"B"`
 * - primitive JSON (string/number/boolean) ⇒ canonical string form
 * - arbitrary string ⇒ trimmed string (kept for backwards compatibility)
 *
 * Returning `null` signals that the child response cannot participate in the
 * vote (for instance when the summary is empty). The caller records the source
 * used so diagnostics remain explorable in traces.
 */
function normaliseVoteSummary(summary) {
    const trimmed = summary.trim();
    if (!trimmed) {
        return { value: null, source: "empty" };
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
            return { value: String(parsed), source: typeof parsed };
        }
        if (parsed && typeof parsed === "object") {
            const candidate = parsed;
            if (typeof candidate.vote === "string" && candidate.vote.trim().length > 0) {
                return { value: candidate.vote, source: "json.vote" };
            }
            if (typeof candidate.value === "string" && candidate.value.trim().length > 0) {
                return { value: candidate.value, source: "json.value" };
            }
            if (typeof candidate.vote === "number" || typeof candidate.vote === "boolean") {
                return { value: String(candidate.vote), source: "json.vote" };
            }
            if (typeof candidate.value === "number" || typeof candidate.value === "boolean") {
                return { value: String(candidate.value), source: "json.value" };
            }
        }
    }
    catch {
        // Ignore parse failures and fall back to the trimmed string below.
    }
    return { value: trimmed, source: "raw" };
}
/**
 * Reduces the responses of multiple children using strategies such as
 * concatenation, JSON merge or majority vote.
 */
export async function handlePlanReduce(context, input) {
    const outputs = await Promise.all(input.children.map((childId) => context.supervisor.collect(childId)));
    const providedCorrelation = extractPlanCorrelationHints(input);
    const opId = resolveOperationId(input.op_id ?? providedCorrelation?.opId, "plan_reduce_op");
    const correlationSource = {
        ...(providedCorrelation ?? {}),
        opId,
    };
    const correlationHints = toEventCorrelationHints(correlationSource);
    const correlationPayload = serialiseCorrelationForPayload(correlationHints);
    const guardDecisions = new Map();
    if (context.valueGuard) {
        for (const childId of input.children) {
            const decision = context.valueGuard.registry.get(childId);
            if (decision) {
                guardDecisions.set(childId, decision);
                context.valueGuard.registry.delete(childId);
            }
        }
    }
    const summaries = outputs.map((output) => ({
        child_id: output.childId,
        summary: summariseChildOutputs(output),
        artifacts: output.artifacts,
        value_guard: guardDecisions.has(output.childId)
            ? serialiseValueGuardDecision(guardDecisions.get(output.childId))
            : null,
    }));
    context.logger.info("plan_reduce", {
        reducer: input.reducer,
        children: input.children.length,
        has_spec: input.spec ? true : false,
        ...correlationPayload,
    });
    context.emitEvent({
        kind: "AGGREGATE",
        jobId: correlationHints.jobId ?? undefined,
        childId: correlationHints.childId ?? undefined,
        payload: {
            ...correlationPayload,
            reducer: input.reducer,
            children: summaries.map((item) => item.child_id),
        },
        correlation: correlationHints,
    });
    let result;
    switch (input.reducer) {
        case "concat": {
            const aggregate = summaries
                .map((item) => item.summary)
                .filter((summary) => typeof summary === "string")
                .join("\n\n");
            result = {
                reducer: input.reducer,
                aggregate,
                trace: { per_child: summaries },
            };
            break;
        }
        case "merge_json": {
            const aggregate = {};
            const errors = {};
            for (const item of summaries) {
                if (!item.summary)
                    continue;
                try {
                    const parsed = JSON.parse(item.summary);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        Object.assign(aggregate, parsed);
                    }
                    else {
                        errors[item.child_id] = "summary is not a JSON object";
                    }
                }
                catch (error) {
                    errors[item.child_id] =
                        error instanceof Error ? error.message : String(error);
                }
            }
            const traceDetails = {};
            if (Object.keys(errors).length) {
                traceDetails.errors = errors;
            }
            result = {
                reducer: input.reducer,
                aggregate,
                trace: {
                    per_child: summaries,
                    details: Object.keys(traceDetails).length ? traceDetails : undefined,
                },
            };
            break;
        }
        case "vote": {
            const voteConfig = ConsensusConfigSchema.parse(input.spec ?? {});
            const options = normaliseConsensusOptions(voteConfig);
            const { quorum: configuredQuorum, ...baseOptions } = options;
            const voteSources = {};
            const votes = [];
            for (const item of summaries) {
                if (typeof item.summary !== "string") {
                    continue;
                }
                const { value, source } = normaliseVoteSummary(item.summary);
                voteSources[item.child_id] = { value, source };
                if (value !== null) {
                    votes.push({ voter: item.child_id, value });
                }
            }
            const adjustedWeights = { ...(baseOptions.weights ?? {}) };
            for (const vote of votes) {
                const baseWeight = adjustedWeights[vote.voter] ?? baseOptions.weights?.[vote.voter] ?? 1;
                const guardWeight = guardDecisions.has(vote.voter)
                    ? Math.max(0, guardDecisions.get(vote.voter).score)
                    : 1;
                const weight = baseWeight * guardWeight;
                adjustedWeights[vote.voter] = Number.isFinite(weight) && weight >= 0 ? weight : 0;
            }
            const weightFor = (vote) => {
                const candidate = adjustedWeights[vote.voter];
                return typeof candidate === "number" && candidate >= 0 ? candidate : 1;
            };
            const totalWeight = votes.reduce((acc, vote) => acc + weightFor(vote), 0);
            const defaultQuorum = configuredQuorum ?? (totalWeight > 0 ? Math.floor(totalWeight / 2) + 1 : 1);
            let decision;
            switch (voteConfig.mode) {
                case "majority":
                    decision = computeConsensusMajority(votes, { ...baseOptions, weights: adjustedWeights });
                    break;
                case "weighted":
                    decision = computeConsensusWeighted(votes, {
                        ...baseOptions,
                        quorum: configuredQuorum,
                        weights: adjustedWeights,
                    });
                    break;
                case "quorum":
                default:
                    decision = computeConsensusQuorum(votes, {
                        ...baseOptions,
                        quorum: defaultQuorum,
                        weights: adjustedWeights,
                    });
                    break;
            }
            if (!decision.satisfied) {
                throw new ConsensusNoQuorumError(decision);
            }
            const aggregate = {
                mode: decision.mode,
                value: decision.outcome,
                satisfied: decision.satisfied,
                tie: decision.tie,
                threshold: decision.threshold,
                total_weight: decision.totalWeight,
                tally: decision.tally,
            };
            const traceDetails = { consensus: aggregate };
            if (guardDecisions.size) {
                traceDetails.value_guard_weights = adjustedWeights;
            }
            if (Object.keys(voteSources).length) {
                traceDetails.vote_sources = voteSources;
            }
            result = {
                reducer: input.reducer,
                aggregate,
                trace: {
                    per_child: summaries,
                    details: traceDetails,
                },
            };
            break;
        }
        case "custom": {
            const spec = input.spec ?? {};
            const pick = typeof spec.pick_child_id === "string"
                ? spec.pick_child_id
                : input.children[0];
            const selected = summaries.find((item) => item.child_id === pick) ?? summaries[0];
            result = {
                reducer: input.reducer,
                aggregate: selected?.summary ?? null,
                trace: {
                    per_child: summaries,
                    details: { pick_child_id: pick },
                },
            };
            break;
        }
        default:
            throw new Error(`Unsupported reducer: ${input.reducer}`);
    }
    if (guardDecisions.size) {
        const guardTrace = Object.fromEntries(Array.from(guardDecisions.entries()).map(([childId, decision]) => [
            childId,
            serialiseValueGuardDecision(decision),
        ]));
        const details = result.trace.details ? { ...result.trace.details } : {};
        details.value_guard = guardTrace;
        result.trace.details = details;
    }
    context.logger.info("plan_reduce_completed", {
        reducer: input.reducer,
        aggregate_kind: typeof result.aggregate,
        child_count: summaries.length,
    });
    const payload = { ...result, op_id: opId };
    return payload;
}
/**
 * Compile a hierarchical graph into a serialised Behaviour Tree definition. The
 * compiler is deterministic which keeps downstream tests and audits reliable.
 */
export function handlePlanCompileBT(context, input) {
    context.logger.info("plan_compile_bt", { graph_id: input.graph.id });
    const compiled = compileHierGraphToBehaviorTree(input.graph);
    return CompiledBehaviorTreeSchema.parse(compiled);
}
/**
 * Execute a Behaviour Tree by delegating leaf nodes to orchestrator tools. The
 * interpreter records every invocation so tests and operators can trace the
 * decision flow precisely.
 */
async function executePlanRunBT(context, input) {
    const schemaRegistry = { ...BehaviorTaskSchemas };
    const invocations = [];
    let lastOutput = null;
    let lastResultStatus = "running";
    let sawFailure = false;
    let reportedError = false;
    const dryRun = input.dry_run ?? false;
    const providedCorrelation = extractPlanCorrelationHints(input);
    const opId = resolveOperationId(input.op_id ?? providedCorrelation?.opId, "bt_op");
    const runId = providedCorrelation?.runId ?? `bt_run_${randomUUID()}`;
    const jobId = providedCorrelation?.jobId ?? null;
    const graphId = providedCorrelation?.graphId ?? null;
    const nodeId = providedCorrelation?.nodeId ?? null;
    const childId = providedCorrelation?.childId ?? null;
    const correlationSource = {
        ...(providedCorrelation ?? {}),
        opId,
        runId,
        jobId,
        graphId,
        nodeId,
        childId,
    };
    const eventCorrelation = toEventCorrelationHints(correlationSource);
    const correlationLogFields = serialiseCorrelationForPayload(eventCorrelation);
    const baseLogFields = { ...correlationLogFields, tree_id: input.tree.id };
    const estimatedWork = estimateBehaviorTreeWorkload(input.tree.root);
    registerPlanLifecycleRun(context, {
        runId,
        opId,
        mode: "bt",
        dryRun,
        correlation: correlationSource,
        estimatedWork,
    });
    context.logger.info("plan_run_bt", {
        ...baseLogFields,
        dry_run: dryRun,
        idempotency_key: input.idempotency_key ?? null,
    });
    /**
     * Helper emitting lifecycle breadcrumbs to the orchestration event pipeline.
     * Keeping the payload shape centralised guarantees that every event carries
     * the correlation identifiers expected by the unified MCP bus.
     */
    const publishLifecycleEvent = (phase, payload) => {
        const eventPayload = {
            phase,
            tree_id: input.tree.id,
            dry_run: dryRun,
            mode: "bt",
            ...correlationLogFields,
            ...payload,
        };
        recordPlanLifecycleEvent(context, runId, phase, eventPayload);
        context.emitEvent({
            kind: "BT_RUN",
            level: phase === "error" ? "error" : "info",
            jobId: jobId ?? undefined,
            childId: childId ?? undefined,
            payload: eventPayload,
            correlation: eventCorrelation,
        });
    };
    publishLifecycleEvent("start", {});
    const cancellation = registerCancellation(opId, {
        runId,
        jobId,
        graphId,
        nodeId,
        childId,
    });
    const previousCancellation = context.activeCancellation ?? null;
    context.activeCancellation = cancellation;
    let cancellationSubscription = null;
    if (context.btStatusRegistry) {
        context.btStatusRegistry.reset(input.tree.id);
    }
    const statusReporter = (nodeId, status) => {
        context.btStatusRegistry?.record(input.tree.id, nodeId, status);
        publishLifecycleEvent("node", { node_id: nodeId, status });
    };
    const interpreter = new BehaviorTreeInterpreter(buildBehaviorTree(input.tree.root, { taskSchemas: schemaRegistry, statusReporter }));
    const causalMemory = context.causalMemory;
    let scheduler = null;
    cancellationSubscription = cancellation.onCancel(({ reason }) => {
        context.logger.info("plan_run_bt_cancel_requested", {
            ...baseLogFields,
            reason: reason ?? null,
        });
        publishLifecycleEvent("cancel", { reason: reason ?? null });
        scheduler?.stop();
    });
    const loopDetector = context.loopDetector ?? null;
    const runtime = {
        invokeTool: async (tool, taskInput) => {
            cancellation.throwIfCancelled();
            if (dryRun) {
                invocations.push({ tool, input: taskInput, output: null, executed: false });
                return null;
            }
            const handler = BehaviorToolHandlers[tool];
            if (!handler) {
                throw new Error(`Unknown behaviour tree tool ${tool}`);
            }
            const parentId = causalMemory && scheduler ? scheduler.getCurrentTickCausalEventId() : null;
            const parentCauses = parentId ? [parentId] : [];
            const invocationEvent = causalMemory
                ? causalMemory.record({
                    type: "bt.tool.invoke",
                    data: { tool, input: summariseForCausalMemory(taskInput) },
                    tags: ["bt", "tool", tool],
                }, parentCauses)
                : null;
            try {
                const output = await handler(context, taskInput);
                invocations.push({ tool, input: taskInput, output, executed: true });
                lastOutput = output;
                if (causalMemory) {
                    causalMemory.record({
                        type: "bt.tool.success",
                        data: { tool, output: summariseForCausalMemory(output) },
                        tags: ["bt", "tool", "success", tool],
                    }, invocationEvent ? [invocationEvent.id] : parentCauses);
                }
                return output;
            }
            catch (error) {
                if (causalMemory) {
                    const message = error instanceof Error ? error.message : String(error);
                    causalMemory.record({
                        type: "bt.tool.failure",
                        data: { tool, message },
                        tags: ["bt", "tool", "failure", tool],
                    }, invocationEvent ? [invocationEvent.id] : parentCauses);
                }
                throw error;
            }
        },
        now: () => Date.now(),
        wait: async (ms) => {
            await waitWithCancellation(cancellation, ms);
        },
        variables: input.variables,
        cancellationSignal: cancellation.signal,
        isCancelled: () => cancellation.isCancelled(),
        throwIfCancelled: () => cancellation.throwIfCancelled(),
        recommendTimeout: loopDetector
            ? (category, complexityScore, fallbackMs) => {
                try {
                    return loopDetector.recommendTimeout(category, complexityScore ?? 1);
                }
                catch (error) {
                    context.logger.warn("bt_timeout_recommendation_failed", {
                        category,
                        fallback_ms: fallbackMs ?? null,
                        message: error instanceof Error ? error.message : String(error),
                    });
                    return fallbackMs;
                }
            }
            : undefined,
        recordTimeoutOutcome: loopDetector
            ? (category, outcome) => {
                if (!Number.isFinite(outcome.durationMs) || outcome.durationMs <= 0) {
                    return;
                }
                loopDetector.recordTaskObservation({
                    taskType: category,
                    durationMs: Math.max(1, Math.round(outcome.durationMs)),
                    success: outcome.success,
                });
            }
            : undefined,
    };
    scheduler = new ReactiveScheduler({
        interpreter,
        runtime,
        now: runtime.now,
        onTick: ({ result, pendingAfter }) => {
            lastResultStatus = result.status;
            if (result.status === "failure") {
                sawFailure = true;
            }
            const tickCount = scheduler?.tickCount ?? 0;
            publishLifecycleEvent("tick", {
                status: result.status,
                pending_after: pendingAfter,
                ticks: tickCount,
            });
            context.supervisorAgent?.recordSchedulerSnapshot({
                schedulerTick: tickCount,
                backlog: pendingAfter,
                completed: result.status === "success" ? 1 : 0,
                failed: result.status === "failure" ? 1 : 0,
            });
        },
        getPheromoneIntensity: (nodeId) => context.stigmergy.getNodeIntensity(nodeId)?.intensity ?? 0,
        getPheromoneBounds: () => context.stigmergy.getIntensityBounds(),
        causalMemory,
    });
    const schedulerRef = scheduler;
    if (!schedulerRef) {
        throw new Error("scheduler initialisation failed");
    }
    const unsubscribeStigmergy = context.stigmergy.onChange((change) => {
        schedulerRef.emit("stigmergyChanged", {
            nodeId: change.nodeId,
            intensity: change.totalIntensity,
            type: change.type,
            bounds: context.stigmergy.getIntensityBounds(),
        });
    });
    const rootId = ("id" in input.tree.root && input.tree.root.id) ||
        ("node_id" in input.tree.root && input.tree.root.node_id) ||
        input.tree.id;
    const timeoutMs = input.timeout_ms ?? null;
    try {
        const runPromise = schedulerRef.runUntilSettled({
            type: "taskReady",
            payload: { nodeId: rootId, criticality: 1 },
        });
        let result;
        if (timeoutMs !== null) {
            const outcome = await Promise.race([
                runPromise.then((value) => ({ kind: "result", value })),
                delay(timeoutMs).then(() => ({ kind: "timeout" })),
            ]);
            if (outcome.kind === "timeout") {
                schedulerRef.stop();
                await runPromise.catch(() => undefined);
                throw new BehaviorTreeRunTimeoutError(timeoutMs);
            }
            result = outcome.value;
        }
        else {
            result = await runPromise;
        }
        context.logger.info("plan_run_bt_completed", {
            ...baseLogFields,
            status: result.status,
            invocations: invocations.length,
            ticks: schedulerRef.tickCount,
            idempotency_key: input.idempotency_key ?? null,
        });
        publishLifecycleEvent("complete", {
            status: result.status,
            ticks: schedulerRef.tickCount,
            invocations: invocations.length,
            last_output: lastOutput,
        });
        return {
            status: result.status,
            ticks: schedulerRef.tickCount,
            last_output: lastOutput,
            invocations,
            run_id: runId,
            op_id: opId,
            job_id: jobId,
            graph_id: graphId,
            node_id: nodeId,
            child_id: childId,
        };
    }
    catch (error) {
        if (error instanceof OperationCancelledError || error instanceof BehaviorTreeCancellationError) {
            // Normalise behaviour tree cancellations so callers always receive the
            // structured OperationCancelledError along with consistent telemetry.
            sawFailure = true;
            reportedError = true;
            lastResultStatus = "failure";
            const { reason, operationError } = normalisePlanCancellationError(cancellation, error);
            context.logger.info("plan_run_bt_cancelled", {
                ...baseLogFields,
                reason,
            });
            publishLifecycleEvent("error", { status: "cancelled", reason });
            throw operationError;
        }
        throw error;
    }
    finally {
        unsubscribeStigmergy();
        schedulerRef.stop();
        cancellationSubscription?.();
        cancellationSubscription = null;
        unregisterCancellation(opId);
        context.logger.info("plan_run_bt_status", {
            ...baseLogFields,
            status: lastResultStatus,
            ticks: schedulerRef.tickCount,
            idempotency_key: input.idempotency_key ?? null,
        });
        if (sawFailure && !reportedError) {
            publishLifecycleEvent("error", { status: lastResultStatus });
        }
        context.activeCancellation = previousCancellation;
    }
}
export async function handlePlanRunBT(context, input) {
    const key = input.idempotency_key ?? null;
    if (context.idempotency && key) {
        const hit = await context.idempotency.remember(`plan_run_bt:${key}`, () => executePlanRunBT(context, input));
        if (hit.idempotent) {
            const snapshot = hit.value;
            context.logger.info("plan_run_bt_replayed", {
                run_id: snapshot.run_id,
                op_id: snapshot.op_id,
                idempotency_key: key,
            });
        }
        const snapshot = hit.value;
        return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key };
    }
    const snapshot = await executePlanRunBT(context, input);
    return { ...snapshot, idempotent: false, idempotency_key: key };
}
/**
 * Executes a Behaviour Tree inside the reactive execution loop. The loop wires
 * autoscaling and supervision reconcilers so orchestration side-effects are
 * applied after every scheduler tick. The handler mirrors
 * {@link handlePlanRunBT} telemetry while surfacing loop-specific metrics.
 */
async function executePlanRunReactive(context, input) {
    const schemaRegistry = { ...BehaviorTaskSchemas };
    const invocations = [];
    const dryRun = input.dry_run ?? false;
    let lastOutput = null;
    let lastResultStatus = "running";
    const providedCorrelation = extractPlanCorrelationHints(input);
    const opId = resolveOperationId(input.op_id ?? providedCorrelation?.opId, "bt_reactive_op");
    const runId = providedCorrelation?.runId ?? `bt_reactive_run_${randomUUID()}`;
    const jobId = providedCorrelation?.jobId ?? null;
    const graphId = providedCorrelation?.graphId ?? null;
    const nodeId = providedCorrelation?.nodeId ?? null;
    const childId = providedCorrelation?.childId ?? null;
    const correlationSource = {
        ...(providedCorrelation ?? {}),
        opId,
        runId,
        jobId,
        graphId,
        nodeId,
        childId,
    };
    const eventCorrelation = toEventCorrelationHints(correlationSource);
    const correlationLogFields = serialiseCorrelationForPayload(eventCorrelation);
    const baseLogFields = {
        ...correlationLogFields,
        tree_id: input.tree.id,
        idempotency_key: input.idempotency_key ?? null,
    };
    const estimatedWork = estimateBehaviorTreeWorkload(input.tree.root);
    registerPlanLifecycleRun(context, {
        runId,
        opId,
        mode: "reactive",
        dryRun,
        correlation: correlationSource,
        estimatedWork,
    });
    context.logger.info("plan_run_reactive", {
        ...baseLogFields,
        tick_ms: input.tick_ms,
        budget_ms: input.budget_ms ?? null,
        dry_run: dryRun,
    });
    /**
     * Emit reactive lifecycle breadcrumbs on the MCP event bus so the scheduler
     * loop can be observed alongside Behaviour Tree progress in dashboards and
     * tests.
     */
    const publishLifecycleEvent = (phase, payload) => {
        const eventPayload = {
            phase,
            tree_id: input.tree.id,
            dry_run: dryRun,
            mode: "reactive",
            ...correlationLogFields,
            ...payload,
        };
        recordPlanLifecycleEvent(context, runId, phase, eventPayload);
        context.emitEvent({
            kind: "BT_RUN",
            level: phase === "error" ? "error" : "info",
            jobId: jobId ?? undefined,
            childId: childId ?? undefined,
            payload: eventPayload,
            correlation: eventCorrelation,
        });
    };
    /**
     * Publish scheduler telemetry with a stable `msg` value so event
     * subscriptions can easily discriminate enqueued events from tick results
     * without inspecting the nested payload. Each emission carries the
     * correlation hints propagated by the caller so dashboards may link the
     * scheduler activity back to the originating plan run.
     */
    const emitSchedulerTelemetry = (message, payload) => {
        context.emitEvent({
            kind: "SCHEDULER",
            jobId: jobId ?? undefined,
            childId: childId ?? undefined,
            payload: {
                msg: message,
                ...correlationLogFields,
                ...payload,
            },
            correlation: eventCorrelation,
        });
    };
    publishLifecycleEvent("start", { tick_ms: input.tick_ms, budget_ms: input.budget_ms ?? null });
    const causalMemory = context.causalMemory;
    const loopDetector = context.loopDetector ?? null;
    const autoscaler = context.autoscaler ?? null;
    let scheduler = null;
    let loop = null;
    let unsubscribeBlackboard = null;
    const cancellation = registerCancellation(opId, {
        runId,
        jobId,
        graphId,
        nodeId,
        childId,
    });
    const previousCancellation = context.activeCancellation ?? null;
    context.activeCancellation = cancellation;
    let cancellationSubscription = null;
    if (context.btStatusRegistry) {
        context.btStatusRegistry.reset(input.tree.id);
    }
    const statusReporter = (nodeId, status) => {
        context.btStatusRegistry?.record(input.tree.id, nodeId, status);
        publishLifecycleEvent("node", { node_id: nodeId, status });
    };
    const interpreter = new BehaviorTreeInterpreter(buildBehaviorTree(input.tree.root, { taskSchemas: schemaRegistry, statusReporter }));
    const runtime = {
        invokeTool: async (tool, taskInput) => {
            cancellation.throwIfCancelled();
            if (dryRun) {
                invocations.push({ tool, input: taskInput, output: null, executed: false });
                return null;
            }
            const handler = BehaviorToolHandlers[tool];
            if (!handler) {
                throw new Error(`Unknown behaviour tree tool ${tool}`);
            }
            const parentId = causalMemory && scheduler ? scheduler.getCurrentTickCausalEventId() : null;
            const parentCauses = parentId ? [parentId] : [];
            const invocationEvent = causalMemory
                ? causalMemory.record({
                    type: "bt.tool.invoke",
                    data: { tool, input: summariseForCausalMemory(taskInput) },
                    tags: ["bt", "tool", tool],
                }, parentCauses)
                : null;
            try {
                const output = await handler(context, taskInput);
                invocations.push({ tool, input: taskInput, output, executed: true });
                lastOutput = output;
                if (causalMemory) {
                    causalMemory.record({
                        type: "bt.tool.success",
                        data: { tool, output: summariseForCausalMemory(output) },
                        tags: ["bt", "tool", "success", tool],
                    }, invocationEvent ? [invocationEvent.id] : parentCauses);
                }
                return output;
            }
            catch (error) {
                if (causalMemory) {
                    const message = error instanceof Error ? error.message : String(error);
                    causalMemory.record({
                        type: "bt.tool.failure",
                        data: { tool, message },
                        tags: ["bt", "tool", "failure", tool],
                    }, invocationEvent ? [invocationEvent.id] : parentCauses);
                }
                throw error;
            }
        },
        now: () => Date.now(),
        wait: async (ms) => {
            await waitWithCancellation(cancellation, ms);
        },
        variables: input.variables,
        cancellationSignal: cancellation.signal,
        isCancelled: () => cancellation.isCancelled(),
        throwIfCancelled: () => cancellation.throwIfCancelled(),
        recommendTimeout: loopDetector
            ? (category, complexityScore, fallbackMs) => {
                try {
                    return loopDetector.recommendTimeout(category, complexityScore ?? 1);
                }
                catch (error) {
                    context.logger.warn("bt_timeout_recommendation_failed", {
                        category,
                        fallback_ms: fallbackMs ?? null,
                        message: error instanceof Error ? error.message : String(error),
                    });
                    return fallbackMs;
                }
            }
            : undefined,
        recordTimeoutOutcome: loopDetector
            ? (category, outcome) => {
                if (!Number.isFinite(outcome.durationMs) || outcome.durationMs <= 0) {
                    return;
                }
                loopDetector.recordTaskObservation({
                    taskType: category,
                    durationMs: Math.max(1, Math.round(outcome.durationMs)),
                    success: outcome.success,
                });
            }
            : undefined,
    };
    scheduler = new ReactiveScheduler({
        interpreter,
        runtime,
        now: runtime.now,
        getPheromoneIntensity: (nodeId) => context.stigmergy.getNodeIntensity(nodeId)?.intensity ?? 0,
        getPheromoneBounds: () => context.stigmergy.getIntensityBounds(),
        causalMemory,
        cancellation,
        onEvent: (telemetry) => {
            const eventPayload = summariseSchedulerEvent(telemetry.event, telemetry.payload);
            emitSchedulerTelemetry("scheduler_event_enqueued", {
                event_type: telemetry.event,
                pending: telemetry.pendingAfter,
                // Capture the queue depth snapshot directly from the scheduler so
                // downstream consumers no longer rely on derived calculations. The
                // scheduler reports both depths explicitly, ensuring parity even if
                // future implementations enqueue batched events.
                pending_before: telemetry.pendingBefore,
                // Expose the queue depth after the enqueue to keep JSON Lines and SSE
                // consumers aligned with the documentation promise that both
                // transports share the same scheduler metrics.
                pending_after: telemetry.pendingAfter,
                base_priority: telemetry.basePriority,
                enqueued_at_ms: telemetry.enqueuedAt,
                sequence: telemetry.sequence,
                duration_ms: null,
                batch_index: null,
                ticks_in_batch: null,
                event_payload: eventPayload,
            });
        },
        onTick: (trace) => {
            lastResultStatus = trace.result.status;
            const eventPayload = summariseSchedulerEvent(trace.event, trace.payload);
            publishLifecycleEvent("tick", {
                status: trace.result.status,
                pending_after: trace.pendingAfter,
                scheduler_ticks: scheduler?.tickCount ?? 0,
                tick_duration_ms: Math.max(0, trace.finishedAt - trace.startedAt),
                event: trace.event,
                event_payload: eventPayload,
            });
            context.supervisorAgent?.recordSchedulerSnapshot({
                schedulerTick: scheduler?.tickCount ?? 0,
                backlog: trace.pendingAfter,
                completed: trace.result.status === "success" ? 1 : 0,
                failed: trace.result.status === "failure" ? 1 : 0,
            });
            if (autoscaler) {
                autoscaler.updateBacklog(trace.pendingAfter);
                autoscaler.recordTaskResult({
                    durationMs: Math.max(0, trace.finishedAt - trace.startedAt),
                    success: trace.result.status !== "failure",
                });
            }
            emitSchedulerTelemetry("scheduler_tick_result", {
                event_type: "tick_result",
                status: trace.result.status,
                duration_ms: Math.max(0, trace.finishedAt - trace.startedAt),
                pending: trace.pendingAfter,
                pending_before: trace.pendingBefore,
                pending_after: trace.pendingAfter,
                batch_index: trace.batchIndex,
                ticks_in_batch: trace.ticksInBatch,
                priority: trace.priority,
                base_priority: trace.basePriority,
                enqueued_at_ms: trace.enqueuedAt,
                sequence: trace.sequence,
                source_event: trace.event,
                event_payload: eventPayload,
            });
        },
    });
    if (context.blackboard) {
        const startingVersion = context.blackboard.getCurrentVersion();
        unsubscribeBlackboard = context.blackboard.watch({
            fromVersion: startingVersion,
            listener: (event) => {
                if (!scheduler) {
                    return;
                }
                const importance = deriveBlackboardImportance(event);
                scheduler.emit("blackboardChanged", { key: event.key, importance });
                context.logger.info("plan_run_reactive_blackboard_event", {
                    ...baseLogFields,
                    key: event.key,
                    kind: event.kind,
                    importance,
                });
            },
        });
    }
    const unsubscribeStigmergy = context.stigmergy.onChange((change) => {
        scheduler?.emit("stigmergyChanged", {
            nodeId: change.nodeId,
            intensity: change.totalIntensity,
            type: change.type,
            bounds: context.stigmergy.getIntensityBounds(),
        });
    });
    const reconcilers = [];
    if (autoscaler) {
        reconcilers.push(autoscaler);
    }
    if (context.supervisorAgent) {
        reconcilers.push(context.supervisorAgent);
    }
    const rootId = ("id" in input.tree.root && input.tree.root.id) ||
        ("node_id" in input.tree.root && input.tree.root.node_id) ||
        input.tree.id;
    let executedLoopTicks = 0;
    let pendingLoopEvent = null;
    let finish = null;
    let fail = null;
    let runCompleted = false;
    const runPromise = new Promise((resolve, reject) => {
        finish = (result) => {
            if (runCompleted) {
                return;
            }
            runCompleted = true;
            resolve(result);
        };
        fail = (error) => {
            if (runCompleted) {
                return;
            }
            runCompleted = true;
            if (scheduler) {
                scheduler.stop();
            }
            reject(error);
        };
    });
    loop = new ExecutionLoop({
        intervalMs: input.tick_ms ?? 100,
        now: runtime.now,
        budgetMs: input.budget_ms,
        reconcilers,
        afterTick: ({ reconcilers: executedReconcilers }) => {
            if (!pendingLoopEvent) {
                return;
            }
            const reconcilerSnapshot = executedReconcilers.map((item) => ({
                id: item.id,
                status: item.status,
                duration_ms: item.durationMs,
                error: item.errorMessage ?? null,
            }));
            publishLifecycleEvent("loop", {
                loop_tick: pendingLoopEvent.loopTick,
                executed_ticks: pendingLoopEvent.executedTicks,
                scheduler_ticks: scheduler?.tickCount ?? 0,
                status: pendingLoopEvent.status,
                reconcilers: reconcilerSnapshot,
            });
            pendingLoopEvent = null;
        },
        onError: (error) => {
            fail?.(error);
        },
        tick: async (loopContext) => {
            if (runCompleted || !scheduler) {
                return;
            }
            cancellation.throwIfCancelled();
            const initialEvent = loopContext.tickIndex === 0
                ? { type: "taskReady", payload: { nodeId: rootId, criticality: 1 } }
                : undefined;
            try {
                const result = await scheduler.runUntilSettled(initialEvent);
                executedLoopTicks = Math.max(executedLoopTicks, loopContext.tickIndex + 1);
                pendingLoopEvent = {
                    loopTick: loopContext.tickIndex,
                    executedTicks: executedLoopTicks,
                    status: result.status,
                };
                if (result.output !== undefined) {
                    lastOutput = result.output;
                }
                if (result.status !== "running") {
                    finish?.(result);
                }
            }
            catch (error) {
                fail?.(error);
            }
        },
    });
    attachPlanLifecycleControls(context, runId, {
        pause: () => loop?.pause() ?? false,
        resume: () => loop?.resume() ?? false,
    });
    let timeoutHandle = null;
    if (input.timeout_ms !== undefined) {
        timeoutHandle = setTimeout(() => {
            fail?.(new BehaviorTreeRunTimeoutError(input.timeout_ms));
        }, input.timeout_ms);
    }
    cancellationSubscription = cancellation.onCancel(({ reason }) => {
        context.logger.info("plan_run_reactive_cancel_requested", {
            ...baseLogFields,
            reason: reason ?? null,
        });
        publishLifecycleEvent("cancel", { reason: reason ?? null });
        scheduler?.stop();
        void loop?.stop();
    });
    const startedAt = runtime.now();
    loop.start();
    try {
        const result = await runPromise;
        const durationMs = runtime.now() - startedAt;
        context.logger.info("plan_run_reactive_completed", {
            ...baseLogFields,
            status: result.status,
            loop_ticks: executedLoopTicks,
            scheduler_ticks: scheduler.tickCount,
            duration_ms: durationMs,
            invocations: invocations.length,
        });
        publishLifecycleEvent("complete", {
            status: result.status,
            loop_ticks: executedLoopTicks,
            scheduler_ticks: scheduler.tickCount,
            duration_ms: durationMs,
            last_output: lastOutput,
        });
        return {
            status: result.status,
            loop_ticks: executedLoopTicks,
            scheduler_ticks: scheduler.tickCount,
            duration_ms: durationMs,
            last_output: lastOutput,
            invocations,
            run_id: runId,
            op_id: opId,
            job_id: jobId,
            graph_id: graphId,
            node_id: nodeId,
            child_id: childId,
        };
    }
    catch (error) {
        if (error instanceof OperationCancelledError || error instanceof BehaviorTreeCancellationError) {
            lastResultStatus = "failure";
            const { reason, operationError } = normalisePlanCancellationError(cancellation, error);
            context.logger.info("plan_run_reactive_cancelled", {
                ...baseLogFields,
                reason,
            });
            publishLifecycleEvent("error", { status: "cancelled", reason });
            throw operationError;
        }
        context.logger.error("plan_run_reactive_failed", {
            ...baseLogFields,
            status: lastResultStatus,
            message: error instanceof Error ? error.message : String(error),
        });
        publishLifecycleEvent("error", {
            status: lastResultStatus,
            message: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
        if (unsubscribeBlackboard) {
            unsubscribeBlackboard();
        }
        unsubscribeStigmergy();
        scheduler?.stop();
        await loop.stop();
        cancellationSubscription?.();
        cancellationSubscription = null;
        unregisterCancellation(opId);
        context.planLifecycle?.releaseControls(runId);
        context.logger.info("plan_run_reactive_status", {
            ...baseLogFields,
            status: lastResultStatus,
            loop_ticks: executedLoopTicks,
            scheduler_ticks: scheduler?.tickCount ?? 0,
        });
        context.activeCancellation = previousCancellation;
    }
}
export async function handlePlanRunReactive(context, input) {
    const key = input.idempotency_key ?? null;
    if (context.idempotency && key) {
        const hit = await context.idempotency.remember(`plan_run_reactive:${key}`, () => executePlanRunReactive(context, input));
        if (hit.idempotent) {
            const snapshot = hit.value;
            context.logger.info("plan_run_reactive_replayed", {
                run_id: snapshot.run_id,
                op_id: snapshot.op_id,
                idempotency_key: key,
            });
        }
        const snapshot = hit.value;
        return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key };
    }
    const snapshot = await executePlanRunReactive(context, input);
    return { ...snapshot, idempotent: false, idempotency_key: key };
}
/** Determine whether the caller supplied a hierarchical graph payload. */
function isHierarchicalDryRunGraph(graph) {
    const nodes = graph.nodes;
    const edges = graph.edges;
    if (!Array.isArray(nodes) || nodes.length === 0 || !Array.isArray(edges)) {
        return false;
    }
    const hierarchicalNodes = nodes.every((node) => {
        if (!node || typeof node !== "object") {
            return false;
        }
        const kind = node.kind;
        return kind === "task" || kind === "subgraph";
    });
    if (!hierarchicalNodes) {
        return false;
    }
    return edges.every((edge) => {
        if (!edge || typeof edge !== "object") {
            return false;
        }
        const from = edge.from;
        const to = edge.to;
        return (!!from &&
            typeof from === "object" &&
            typeof from.nodeId === "string" &&
            !!to &&
            typeof to === "object" &&
            typeof to.nodeId === "string");
    });
}
/**
 * Normalise the graph provided to the dry-run handler. Callers may supply either a
 * hierarchical payload or a graph descriptor already flattened by the graph tools.
 */
function normalisePlanDryRunGraph(graph) {
    if (!graph) {
        return null;
    }
    const candidate = graph;
    if (isHierarchicalDryRunGraph(candidate)) {
        return flatten(candidate);
    }
    const parsed = GraphDescriptorSchema.safeParse(candidate);
    if (!parsed.success) {
        throw new Error("invalid graph payload supplied to plan dry-run");
    }
    return normaliseGraphDescriptor(parsed.data);
}
/**
 * Build reroute hints by combining explicit rewrite options with heuristic signals
 * found in the graph. Nodes flagged with `avoid`, `unsafe`, or `reroute` metadata
 * are automatically added to the avoid lists so previews surface realistic bypasses.
 */
function deriveRerouteAvoidHints(graph, rewrite, rerouteAvoid) {
    const avoidNodeIds = new Set();
    const avoidLabels = new Set();
    const registerNodeId = (value) => {
        if (typeof value !== "string") {
            return;
        }
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            avoidNodeIds.add(trimmed);
        }
    };
    const registerLabel = (value) => {
        if (typeof value !== "string") {
            return;
        }
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            avoidLabels.add(trimmed);
        }
    };
    const registerRerouteNode = (value) => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                registerNodeId(entry);
            }
            return;
        }
        registerNodeId(value);
    };
    const registerRerouteLabel = (value) => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                registerLabel(entry);
            }
            return;
        }
        registerLabel(value);
    };
    for (const id of rewrite?.avoid_node_ids ?? []) {
        registerNodeId(id);
    }
    for (const label of rewrite?.avoid_labels ?? []) {
        registerLabel(label);
    }
    registerRerouteNode(rerouteAvoid?.node_ids);
    registerRerouteLabel(rerouteAvoid?.labels);
    for (const node of graph.nodes) {
        const attributes = (node.attributes ?? {});
        const tagList = Array.isArray(attributes.tags) ? attributes.tags : [];
        const loweredTags = new Set(tagList
            .filter((tag) => typeof tag === "string")
            .map((tag) => tag.toLowerCase()));
        const flagged = attributes.avoid === true ||
            attributes.unsafe === true ||
            attributes.reroute === true ||
            attributes.risk === "avoid" ||
            attributes.safety === "avoid" ||
            loweredTags.has("avoid") ||
            loweredTags.has("unsafe") ||
            loweredTags.has("reroute");
        if (flagged) {
            registerNodeId(node.id);
            registerLabel(node.label);
        }
    }
    return {
        avoidNodeIds: avoidNodeIds.size > 0 ? avoidNodeIds : undefined,
        avoidLabels: avoidLabels.size > 0 ? avoidLabels : undefined,
    };
}
export function handlePlanDryRun(context, input) {
    const hierarchicalGraph = input.graph && isHierarchicalDryRunGraph(input.graph)
        ? input.graph
        : null;
    const compiledTree = input.tree
        ? structuredClone(input.tree)
        : hierarchicalGraph
            ? compileHierGraphToBehaviorTree(hierarchicalGraph)
            : null;
    let rewritePreview = null;
    let rerouteAvoid = null;
    const normalisedGraph = normalisePlanDryRunGraph(input.graph);
    if (normalisedGraph) {
        const rerouteHints = deriveRerouteAvoidHints(normalisedGraph, input.rewrite ?? null, input.reroute_avoid ?? null);
        rerouteAvoid =
            rerouteHints.avoidNodeIds || rerouteHints.avoidLabels
                ? {
                    node_ids: Array.from(rerouteHints.avoidNodeIds ?? []).sort(),
                    labels: Array.from(rerouteHints.avoidLabels ?? []).sort(),
                }
                : null;
        const rules = [
            createSplitParallelRule(),
            createInlineSubgraphRule(),
            createRerouteAvoidRule(rerouteHints),
        ];
        const { graph: rewrittenGraph, history } = applyAll(normalisedGraph, rules);
        const applied = history.reduce((sum, entry) => sum + entry.applied, 0);
        rewritePreview = {
            graph: rewrittenGraph,
            history,
            applied,
        };
        context.logger.info("plan_dry_run_rewrite_preview", {
            plan_id: input.plan_id,
            applied_rules: history.filter((entry) => entry.applied > 0).length,
            total_applied: applied,
            reroute_avoid_nodes: rerouteHints.avoidNodeIds?.size ?? 0,
            reroute_avoid_labels: rerouteHints.avoidLabels?.size ?? 0,
        });
    }
    const nodeSummaries = [];
    const aggregatedImpacts = [];
    for (const node of input.nodes ?? []) {
        const impacts = (node.value_impacts ?? []).map((impact) => normalisePlanImpact(impact, node.id));
        aggregatedImpacts.push(...impacts);
        nodeSummaries.push({ id: node.id, label: node.label ?? null, impacts });
    }
    for (const impact of input.impacts ?? []) {
        aggregatedImpacts.push(normalisePlanImpact(impact, undefined));
    }
    let explanation = null;
    const correlation = extractPlanCorrelationHints(input);
    const guard = context.valueGuard;
    if (guard && aggregatedImpacts.length > 0) {
        explanation = guard.graph.explain({
            id: input.plan_id,
            label: input.plan_label,
            impacts: aggregatedImpacts,
            threshold: input.threshold,
        }, { correlation });
        context.logger.info("plan_dry_run_values", {
            plan_id: input.plan_id,
            impacts: aggregatedImpacts.length,
            allowed: explanation.decision.allowed,
            score: explanation.decision.score,
            threshold: explanation.decision.threshold,
            violations: explanation.violations.length,
            run_id: correlation?.runId ?? null,
            op_id: correlation?.opId ?? null,
        });
    }
    else if (!guard) {
        context.logger.info("plan_dry_run_without_value_guard", {
            plan_id: input.plan_id,
            impacts: aggregatedImpacts.length,
            run_id: correlation?.runId ?? null,
            op_id: correlation?.opId ?? null,
        });
    }
    context.logger.info("plan_dry_run", {
        plan_id: input.plan_id,
        nodes: nodeSummaries.length,
        impacts: aggregatedImpacts.length,
        has_tree: compiledTree !== null,
        threshold: input.threshold ?? null,
        run_id: correlation?.runId ?? null,
        op_id: correlation?.opId ?? null,
    });
    return {
        plan_id: input.plan_id,
        plan_label: input.plan_label ?? null,
        threshold: input.threshold ?? null,
        compiled_tree: compiledTree,
        nodes: nodeSummaries,
        impacts: aggregatedImpacts,
        value_guard: explanation,
        rewrite_preview: rewritePreview,
        reroute_avoid: rerouteAvoid,
    };
}
/** Retrieve the lifecycle snapshot associated with a Behaviour Tree execution. */
export function handlePlanStatus(context, input) {
    const registry = requirePlanLifecycle(context, "plan_status", input.run_id);
    return registry.getSnapshot(input.run_id);
}
/** Pause a running Behaviour Tree execution when lifecycle tooling is enabled. */
export async function handlePlanPause(context, input) {
    const registry = requirePlanLifecycle(context, "plan_pause", input.run_id);
    return registry.pause(input.run_id);
}
/** Resume a paused Behaviour Tree execution when lifecycle tooling is enabled. */
export async function handlePlanResume(context, input) {
    const registry = requirePlanLifecycle(context, "plan_resume", input.run_id);
    return registry.resume(input.run_id);
}
/**
 * Normalises an impact payload so it matches {@link ValueImpactInput} while
 * preserving any correlation metadata declared on the plan node.
 */
function normalisePlanImpact(impact, fallbackNodeId) {
    const nodeId = impact.nodeId ?? impact.node_id ?? fallbackNodeId;
    return {
        value: impact.value,
        impact: impact.impact,
        severity: impact.severity,
        rationale: impact.rationale,
        source: impact.source,
        nodeId: nodeId ?? undefined,
    };
}
/**
 * Convert correlation hints provided by plan tooling into the camel-cased
 * structure consumed by downstream value guard and event bus helpers.
 */
function extractPlanCorrelationHints(input) {
    const hints = {};
    if (input.run_id !== undefined)
        hints.runId = input.run_id;
    if (input.op_id !== undefined)
        hints.opId = input.op_id;
    if (input.job_id !== undefined)
        hints.jobId = input.job_id;
    if (input.graph_id !== undefined)
        hints.graphId = input.graph_id;
    if (input.node_id !== undefined)
        hints.nodeId = input.node_id;
    if (input.child_id !== undefined)
        hints.childId = input.child_id;
    return Object.keys(hints).length > 0 ? hints : null;
}
/**
 * Convert plan-level correlation hints into the event-centric structure consumed by
 * the unified MCP bus. Keeping the mapping centralised ensures every tool uses the
 * same normalisation (notably the preservation of explicit `null` values).
 */
function toEventCorrelationHints(hints) {
    const correlation = {};
    if (!hints) {
        return correlation;
    }
    if (hints.runId !== undefined)
        correlation.runId = hints.runId;
    if (hints.opId !== undefined)
        correlation.opId = hints.opId;
    if (hints.jobId !== undefined)
        correlation.jobId = hints.jobId;
    if (hints.graphId !== undefined)
        correlation.graphId = hints.graphId;
    if (hints.nodeId !== undefined)
        correlation.nodeId = hints.nodeId;
    if (hints.childId !== undefined)
        correlation.childId = hints.childId;
    return correlation;
}
/**
 * Serialise correlation hints with snake_case keys for event payloads and logs.
 * The helper mirrors {@link toEventCorrelationHints} so call sites can reuse the
 * same structure without hand-crafting objects repeatedly.
 */
function serialiseCorrelationForPayload(hints) {
    return {
        run_id: hints.runId ?? null,
        op_id: hints.opId ?? null,
        job_id: hints.jobId ?? null,
        graph_id: hints.graphId ?? null,
        node_id: hints.nodeId ?? null,
        child_id: hints.childId ?? null,
    };
}
/** @internal Aggregates helper functions that are exclusively used in tests. */
export const __testing = {
    runWithConcurrency,
};
