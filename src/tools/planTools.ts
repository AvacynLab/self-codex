import { randomUUID } from "crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { ChildCollectedOutputs, ChildRuntimeMessage } from "../childRuntime.js";
import { ChildSupervisor } from "../childSupervisor.js";
import { compileHierGraphToBehaviorTree } from "../executor/bt/compiler.js";
import { BehaviorTreeInterpreter, buildBehaviorTree } from "../executor/bt/interpreter.js";
import {
  BehaviorNodeDefinitionSchema,
  type BehaviorNodeDefinition,
  CompiledBehaviorTreeSchema,
  type BTStatus,
  type BehaviorTickResult,
  type CompiledBehaviorTree,
  type TickRuntime,
} from "../executor/bt/types.js";
import {
  ReactiveScheduler,
  type PheromoneBounds,
  type SchedulerEventMap,
  type SchedulerEventName,
} from "../executor/reactiveScheduler.js";
import { ExecutionLoop } from "../executor/loop.js";
import {
  PlanLifecycleFeatureDisabledError,
  PlanLifecycleRegistry,
  type PlanLifecycleControls,
  type PlanLifecycleMode,
  type PlanLifecyclePhase,
  type PlanLifecycleSnapshot,
} from "../executor/planLifecycle.js";
import { BbSetInputSchema } from "./coordTools.js";
import {
  ConsensusConfigSchema,
  majority as computeConsensusMajority,
  normaliseConsensusOptions,
  publishConsensusEvent,
  quorum as computeConsensusQuorum,
  weighted as computeConsensusWeighted,
  type ConsensusDecision,
  type ConsensusVote,
} from "../coord/consensus.js";
import { StigmergyField, type StigmergyIntensityBounds } from "../coord/stigmergy.js";
import { BlackboardStore, type BlackboardEvent, type BlackboardEntrySnapshot } from "../coord/blackboard.js";
import type { CausalMemory } from "../knowledge/causalMemory.js";
import type {
  ValueExplanationResult,
  ValueFilterDecision,
  ValueGraph,
  ValueGraphCorrelationHints,
  ValueImpactInput,
  ValueViolation,
} from "../values/valueGraph.js";
import { IdempotencyRegistry } from "../infra/idempotency.js";
import { GraphState } from "../graphState.js";
import { StructuredLogger } from "../logger.js";
import { OrchestratorSupervisor } from "../agents/supervisor.js";
import { Autoscaler } from "../agents/autoscaler.js";
import { ensureDirectory, resolveWithin } from "../paths.js";
import {
  PromptTemplate,
  PromptMessage,
  PromptTemplateSchema,
  PromptVariablesSchema,
  renderPromptTemplate,
} from "../prompts.js";
import { applyAll, createInlineSubgraphRule, createRerouteAvoidRule, createSplitParallelRule, type RewriteHistoryEntry } from "../graph/rewrite.js";
import { flatten } from "../graph/hierarchy.js";
import type { NormalisedGraph } from "../graph/types.js";
import { EventKind, EventLevel } from "../eventStore.js";
import type { EventCorrelationHints } from "../events/correlation.js";
import type { LoopDetector } from "../guard/loopDetector.js";
import { BehaviorTreeStatusRegistry } from "../monitor/btStatusRegistry.js";
import {
  registerCancellation,
  unregisterCancellation,
  type CancellationHandle,
  OperationCancelledError,
} from "../executor/cancel.js";
import { BehaviorTreeCancellationError } from "../executor/bt/nodes.js";
import { GraphDescriptorSchema, normaliseGraphDescriptor } from "./graphTools.js";

/**
 * Type used when emitting orchestration events. The server injects a concrete
 * implementation backed by {@link EventStore} so the plan tools remain fully
 * testable.
 */
export type PlanEventEmitter = (event: {
  kind: EventKind;
  level?: EventLevel;
  jobId?: string;
  childId?: string;
  payload?: unknown;
  /** Optional correlation metadata forwarded to the unified event bus. */
  correlation?: EventCorrelationHints | null;
}) => void;

/** Shared runtime injected when the value guard feature is enabled. */
export interface ValueGuardRuntime {
  /** Configured value graph storing principles and relations. */
  graph: ValueGraph;
  /** Registry keeping the last decision taken for each child id. */
  registry: Map<string, ValueFilterDecision>;
}

/** Error raised when Behaviour Tree tasks require a disabled blackboard module. */
class BlackboardFeatureDisabledError extends Error {
  public readonly code = "E-BB-DISABLED";
  public readonly hint = "enable_blackboard";

  constructor() {
    super("blackboard module disabled");
    this.name = "BlackboardFeatureDisabledError";
  }
}

/** Ensure a blackboard is available before Behaviour Tree tasks attempt to use it. */
function requireBlackboard(context: PlanToolContext): BlackboardStore {
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
function requirePlanLifecycle(
  context: PlanToolContext,
  tool: "plan_status" | "plan_pause" | "plan_resume",
  runId: string,
): PlanLifecycleRegistry {
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
function serialiseBlackboardEntry(
  snapshot: BlackboardEntrySnapshot,
): Record<string, unknown> {
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
function deriveBlackboardImportance(event: BlackboardEvent): number {
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
 * Context shared by the plan tool handlers. The orchestrator injects the
 * supervisor to control child runtimes, the mutable {@link GraphState} and the
 * logger so that each action is auditable.
 */
export interface PlanToolContext {
  /** Supervisor coordinating the lifecycle of child Codex instances. */
  supervisor: ChildSupervisor;
  /** Central graph state used to expose jobs/children to other tools. */
  graphState: GraphState;
  /** Structured logger leveraged for traceability. */
  logger: StructuredLogger;
  /** Root directory that contains every child workspace. */
  childrenRoot: string;
  /** Default runtime identifier applied when no override is provided. */
  defaultChildRuntime: string;
  /** Callback used to emit high level orchestration events. */
  emitEvent: PlanEventEmitter;
  /** Shared stigmergic field used to influence scheduling priorities. */
  stigmergy: StigmergyField;
  /** Optional blackboard store relaying shared signals across agents. */
  blackboard?: BlackboardStore;
  /** Optional orchestrator supervisor handling loop and stagnation mitigation. */
  supervisorAgent?: OrchestratorSupervisor;
  /** Optional autoscaler reconciling scheduler pressure after every loop tick. */
  autoscaler?: Autoscaler;
  /**
   * Cancellation handle associated with the currently executing plan operation.
   * Behaviour Tree tools such as `wait` rely on the handle to cooperate with
   * cancellation requests while remaining test-friendly with fake timers.
   */
  activeCancellation?: CancellationHandle | null;
  /** Optional causal memory capturing scheduler and Behaviour Tree events. */
  causalMemory?: CausalMemory;
  /** Optional value guard filtering unsafe plans before execution. */
  valueGuard?: ValueGuardRuntime;
  /** Optional loop detector used to derive timeout budgets for BT categories. */
  loopDetector?: LoopDetector;
  /** Optional registry collecting Behaviour Tree node statuses for dashboards. */
  btStatusRegistry?: BehaviorTreeStatusRegistry;
  /**
   * Lifecycle registry mirroring Behaviour Tree progress snapshots.
   * The registry may still be present when the feature toggle is disabled so
   * long-running runs can keep publishing events and resume once re-enabled.
   */
  planLifecycle?: PlanLifecycleRegistry;
  /** Whether lifecycle tooling is currently exposed to external callers. */
  planLifecycleFeatureEnabled?: boolean;
  /** Optional idempotency registry replaying cached Behaviour Tree results. */
  idempotency?: IdempotencyRegistry;
}

/**
 * Produces a compact JSON-serialisable summary suitable for causal memory
 * storage. Large strings are truncated and deep objects are collapsed to keep
 * artefacts lightweight while preserving signal for diagnostics.
 */
function summariseForCausalMemory(value: unknown, depth = 0): unknown {
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
    const entries = Object.entries(value as Record<string, unknown>);
    const summary: Record<string, unknown> = {};
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
async function waitWithCancellation(handle: CancellationHandle, ms: number): Promise<void> {
  handle.throwIfCancelled();
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
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
function extractCancellationReason(
  error: OperationCancelledError | BehaviorTreeCancellationError,
): string | null {
  if (error instanceof OperationCancelledError) {
    return error.details.reason ?? null;
  }

  const candidate = (error as { cause?: unknown }).cause;
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
function normalisePlanCancellationError(
  handle: CancellationHandle,
  error: OperationCancelledError | BehaviorTreeCancellationError,
): { reason: string | null; operationError: OperationCancelledError } {
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

/** Snapshot persisted when surfacing value guard decisions to callers. */
export interface ValueGuardSnapshot extends Record<string, unknown> {
  allowed: boolean;
  score: number;
  total: number;
  threshold: number;
  violations: ValueViolation[];
}

function serialiseValueGuardDecision(
  decision: ValueFilterDecision | null | undefined,
): ValueGuardSnapshot | null {
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
  public readonly code = "E-VALUES-VIOLATION";
  public readonly rejections: Array<{ name: string; decision: ValueFilterDecision }>;

  constructor(rejections: Array<{ name: string; decision: ValueFilterDecision }>) {
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
  public readonly code = "E-VALUES-REQUIRED";

  public readonly hint = "enable_value_guard";

  public readonly children: readonly string[];

  constructor(children: readonly string[]) {
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
  public readonly code = "E-CONSENSUS-NO-QUORUM";
  public readonly details: { decision: ConsensusDecision };

  constructor(decision: ConsensusDecision) {
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
  public readonly code = "E-BT-RUN-TIMEOUT";
  public readonly details: { timeoutMs: number };

  constructor(timeoutMs: number) {
    super(`Behaviour Tree execution timed out after ${timeoutMs}ms`);
    this.name = "BehaviorTreeRunTimeoutError";
    this.details = { timeoutMs };
  }
}

/** Type of the prompt template payload accepted by the fan-out tool. */
export type PlanPromptTemplateInput = z.infer<typeof PromptTemplateSchema>;

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

export type PlanFanoutInput = z.infer<typeof PlanFanoutInputSchema>;
export const PlanFanoutInputShape = PlanFanoutInputSchema.shape;

/** Output payload returned by {@link handlePlanFanout}. */
export interface PlanFanoutResult extends Record<string, unknown> {
  run_id: string;
  job_id: string;
  /** Operation identifier registered in the cancellation registry for the fan-out. */
  op_id: string;
  /** Optional graph identifier correlated to the fan-out orchestration. */
  graph_id: string | null;
  /** Optional node identifier when the fan-out derives from a specific plan node. */
  node_id: string | null;
  /** Optional parent child identifier when the fan-out is triggered by another runtime. */
  child_id: string | null;
  child_ids: string[];
  planned: Array<{
    child_id: string;
    name: string;
    runtime: string;
    prompt_variables: Record<string, string | number | boolean>;
    prompt_summary: string;
    prompt_messages: PromptMessage[];
    manifest_path: string;
    log_path: string;
    ready_message: unknown | null;
    value_guard: ValueGuardSnapshot | null;
  }>;
  prompt_template: PlanPromptTemplateInput;
  rejected_plans: Array<{
    name: string;
    value_guard: ValueGuardSnapshot | null;
  }>;
}

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

export type PlanJoinInput = z.infer<typeof PlanJoinInputSchema>;
export const PlanJoinInputShape = PlanJoinInputSchema.shape;

/** Result returned by {@link handlePlanJoin}. */
export interface PlanJoinResult extends Record<string, unknown> {
  policy: "all" | "first_success" | "quorum";
  satisfied: boolean;
  timeout_ms: number | null;
  success_count: number;
  failure_count: number;
  quorum_threshold: number | null;
  winning_child_id: string | null;
  results: Array<{
    child_id: string;
    status: "success" | "error" | "timeout";
    received_at: number | null;
    message_type: string | null;
    summary: string | null;
    artifacts: ChildCollectedOutputs["artifacts"];
  }>;
  consensus?: {
    mode: "majority" | "quorum" | "weighted";
    outcome: string | null;
    satisfied: boolean;
    tie: boolean;
    threshold: number | null;
    total_weight: number;
    tally: Record<string, number>;
  };
}

/** Input payload accepted by the `plan_reduce` tool. */
export const PlanReduceInputSchema = z
  .object({
    children: z.array(z.string().min(1)).min(1),
    reducer: z.enum(["concat", "merge_json", "vote", "custom"]),
    spec: z.record(z.unknown()).optional(),
  })
  .extend(PlanCorrelationHintsSchema.shape);

export type PlanReduceInput = z.infer<typeof PlanReduceInputSchema>;
export const PlanReduceInputShape = PlanReduceInputSchema.shape;

/** Result returned by {@link handlePlanReduce}. */
export interface PlanReduceResult extends Record<string, unknown> {
  reducer: "concat" | "merge_json" | "vote" | "custom";
  aggregate: unknown;
  trace: {
    per_child: Array<{
      child_id: string;
      summary: string | null;
      artifacts: ChildCollectedOutputs["artifacts"];
      value_guard?: ValueGuardSnapshot | null;
    }>;
    details?: Record<string, unknown>;
  };
}

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

export type PlanCompileBTInput = z.infer<typeof PlanCompileBTInputSchema>;
export type PlanCompileBTResult = z.infer<typeof CompiledBehaviorTreeSchema>;
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

export type PlanRunBTInput = z.infer<typeof PlanRunBTInputSchema>;
export const PlanRunBTInputShape = PlanRunBTInputSchema.shape;

/** Result returned by {@link handlePlanRunBT}. */
export interface PlanRunBTExecutionSnapshot extends Record<string, unknown> {
  status: BTStatus;
  ticks: number;
  last_output: unknown;
  invocations: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    executed: boolean;
  }>;
  /** Correlation identifier attached to the Behaviour Tree run. */
  run_id: string;
  /** Operation identifier allowing cancellation tools to target the run. */
  op_id: string;
  /** Optional job identifier associated with the execution. */
  job_id: string | null;
  /** Optional graph identifier when the run targets a specific plan graph. */
  graph_id: string | null;
  /** Optional node identifier correlating the run to a plan node. */
  node_id: string | null;
  /** Optional child runtime identifier propagated from the caller. */
  child_id: string | null;
}

export interface PlanRunBTResult extends PlanRunBTExecutionSnapshot {
  /** Indicates whether the payload was replayed from the idempotency cache. */
  idempotent: boolean;
  /** Optional idempotency key echoed back to the caller. */
  idempotency_key: string | null;
}

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

export type PlanRunReactiveInput = z.infer<typeof PlanRunReactiveInputSchema>;
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
      .array(
        z
          .object({
            id: z.string().min(1, "node identifier must not be empty"),
            label: z.string().min(1).max(200).optional(),
            value_impacts: z.array(PlanNodeImpactSchema).max(32).optional(),
          })
          .strict(),
      )
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

export type PlanDryRunInput = z.infer<typeof PlanDryRunInputSchema>;
export const PlanDryRunInputShape = PlanDryRunBaseSchema.shape;

/** Result returned by {@link handlePlanRunReactive}. */
export interface PlanRunReactiveExecutionSnapshot extends Record<string, unknown> {
  status: BTStatus;
  loop_ticks: number;
  scheduler_ticks: number;
  duration_ms: number;
  last_output: unknown;
  invocations: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    executed: boolean;
  }>;
  /** Correlation identifier attached to the reactive plan run. */
  run_id: string;
  /** Operation identifier exposing the scheduler loop as a cancellable unit. */
  op_id: string;
  /** Optional job identifier correlated with the scheduler loop. */
  job_id: string | null;
  /** Optional graph identifier when the loop executes a given plan. */
  graph_id: string | null;
  /** Optional node identifier linking the loop to a Behaviour Tree node. */
  node_id: string | null;
  /** Optional child runtime identifier propagated from orchestration. */
  child_id: string | null;
}

export interface PlanRunReactiveResult extends PlanRunReactiveExecutionSnapshot {
  /** Indicates whether the payload was replayed from the idempotency cache. */
  idempotent: boolean;
  /** Optional idempotency key echoed back to the caller. */
  idempotency_key: string | null;
}

/** Summary of the impacts declared on a single plan node during a dry-run. */
export interface PlanDryRunNodeSummary extends Record<string, unknown> {
  id: string;
  label: string | null;
  impacts: ValueImpactInput[];
}

/** Optional rewrite hints that callers can provide to steer the preview. */
export interface PlanDryRunRewriteOptions extends Record<string, unknown> {
  /** Explicit node identifiers that should be avoided by reroute heuristics. */
  avoid_node_ids?: string[];
  /** Optional labels that should be avoided by reroute heuristics. */
  avoid_labels?: string[];
}

/**
 * Optional reroute hints that callers can provide without touching rewrite rules.
 */
export interface PlanDryRunRerouteAvoid extends Record<string, unknown> {
  /** Explicit node identifiers that the dry-run should bypass. */
  node_ids?: string[];
  /** Optional labels that should be skipped by reroute heuristics. */
  labels?: string[];
}

/** Result returned by {@link handlePlanDryRun}. */
export interface PlanDryRunResult extends Record<string, unknown> {
  plan_id: string;
  plan_label: string | null;
  threshold: number | null;
  compiled_tree: CompiledBehaviorTree | null;
  nodes: PlanDryRunNodeSummary[];
  impacts: ValueImpactInput[];
  value_guard: ValueExplanationResult | null;
  rewrite_preview: {
    graph: NormalisedGraph;
    history: RewriteHistoryEntry[];
    applied: number;
  } | null;
  reroute_avoid: {
    node_ids: string[];
    labels: string[];
  } | null;
}

/**
 * Schema validating plan lifecycle tool inputs that reference a specific run.
 */
const PlanLifecycleRunSchema = z
  .object({
    run_id: z.string().min(1, "run_id must not be empty"),
  })
  .strict();

export const PlanStatusInputSchema = PlanLifecycleRunSchema;
export type PlanStatusInput = z.infer<typeof PlanStatusInputSchema>;
export const PlanStatusInputShape = PlanStatusInputSchema.shape;

export const PlanPauseInputSchema = PlanLifecycleRunSchema;
export type PlanPauseInput = z.infer<typeof PlanPauseInputSchema>;
export const PlanPauseInputShape = PlanPauseInputSchema.shape;

export const PlanResumeInputSchema = PlanLifecycleRunSchema;
export type PlanResumeInput = z.infer<typeof PlanResumeInputSchema>;
export const PlanResumeInputShape = PlanResumeInputSchema.shape;

/** Default schema registry used by the Behaviour Tree interpreter. */
const BehaviorTaskSchemas: Record<string, z.ZodTypeAny> = {
  noop: z.any(),
  bb_set: BbSetInputSchema,
  wait: z
    .object({
      duration_ms: z.number().int().min(1).max(60_000).default(100),
    })
    .strict(),
};

/** Estimate the amount of work a Behaviour Tree represents for progress heuristics. */
function estimateBehaviorTreeWorkload(definition: BehaviorNodeDefinition): number {
  switch (definition.type) {
    case "sequence":
    case "selector":
    case "parallel": {
      return (
        1 +
        definition.children.reduce(
          (sum, child) => sum + estimateBehaviorTreeWorkload(child),
          0,
        )
      );
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

function registerPlanLifecycleRun(
  context: PlanToolContext,
  options: {
    runId: string;
    opId: string;
    mode: PlanLifecycleMode;
    dryRun: boolean;
    correlation: EventCorrelationHints | null | undefined;
    estimatedWork: number | null;
  },
): void {
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
  } catch (error) {
    context.logger.warn("plan_lifecycle_register_failed", {
      run_id: options.runId,
      op_id: options.opId,
      mode: options.mode,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordPlanLifecycleEvent(
  context: PlanToolContext,
  runId: string,
  phase: PlanLifecyclePhase,
  payload: Record<string, unknown>,
): void {
  if (!context.planLifecycle) {
    return;
  }
  try {
    context.planLifecycle.recordEvent(runId, { phase, payload });
  } catch (error) {
    context.logger.warn("plan_lifecycle_event_failed", {
      run_id: runId,
      phase,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function attachPlanLifecycleControls(
  context: PlanToolContext,
  runId: string,
  controls: PlanLifecycleControls,
): void {
  if (!context.planLifecycle) {
    return;
  }
  try {
    context.planLifecycle.attachControls(runId, controls);
  } catch (error) {
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
function normalisePheromoneBoundsForTelemetry(
  bounds: PheromoneBounds | StigmergyIntensityBounds | null | undefined,
): { min_intensity: number; max_intensity: number | null; normalisation_ceiling: number } | null {
  if (!bounds) {
    return null;
  }
  return {
    min_intensity: bounds.minIntensity,
    max_intensity: Number.isFinite(bounds.maxIntensity) ? bounds.maxIntensity : null,
    normalisation_ceiling: bounds.normalisationCeiling,
  };
}

function summariseSchedulerEvent<E extends SchedulerEventName>(
  event: E,
  payload: SchedulerEventMap[E],
): Record<string, unknown> {
  switch (event) {
    case "taskReady": {
      const ready = payload as SchedulerEventMap["taskReady"];
      return {
        node_id: ready.nodeId,
        criticality: ready.criticality ?? null,
        pheromone: ready.pheromone ?? null,
        pheromone_bounds: normalisePheromoneBoundsForTelemetry(ready.pheromoneBounds),
      };
    }
    case "taskDone": {
      const done = payload as SchedulerEventMap["taskDone"];
      return {
        node_id: done.nodeId,
        success: done.success,
        duration_ms: done.duration_ms ?? null,
      };
    }
    case "blackboardChanged": {
      const change = payload as SchedulerEventMap["blackboardChanged"];
      return {
        key: change.key,
        importance: change.importance ?? null,
      };
    }
    case "stigmergyChanged": {
      const change = payload as SchedulerEventMap["stigmergyChanged"];
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

/** Tool handlers executed by the Behaviour Tree interpreter. */
type BehaviorToolHandler = (context: PlanToolContext, input: unknown) => Promise<unknown>;

const BehaviorToolHandlers: Record<string, BehaviorToolHandler> = {
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
    } else {
      await delay(payload.duration_ms);
    }
    context.logger.info("bt_wait", { duration_ms: payload.duration_ms });
    return null;
  },
};

/** Internal representation of a child plan resolved from the input payload. */
interface ResolvedChildPlan {
  name: string;
  runtime: string;
  system?: string;
  goals?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
  manifestExtras?: Record<string, unknown>;
  promptVariables: Record<string, string | number | boolean>;
  ttlSeconds?: number;
  valueImpacts?: ValueImpactInput[];
  valueDecision?: ValueFilterDecision | null;
}

/** Result returned after spawning a child runtime. */
interface SpawnedChildInfo {
  childId: string;
  name: string;
  runtime: string;
  promptSummary: string;
  promptMessages: PromptMessage[];
  promptVariables: Record<string, string | number | boolean>;
  manifestPath: string;
  logPath: string;
  readyMessage: unknown | null;
  valueGuard: ValueGuardSnapshot | null;
}

function resolveChildrenPlans(
  input: PlanFanoutInput,
  defaultRuntime: string,
): ResolvedChildPlan[] {
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

    const plans: ResolvedChildPlan[] = [];
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

  throw new Error(
    "plan_fanout requires either children_spec or children to describe the clones",
  );
}

function renderPromptForChild(
  template: PromptTemplate,
  variables: Record<string, string | number | boolean>,
): { messages: PromptMessage[]; summary: string } {
  const messages = renderPromptTemplate(template, { variables });
  const summary = messages
    .map((message) => `[${message.role}] ${message.content}`)
    .join("\n");
  return { messages, summary };
}

/**
 * Correlation context propagated to every child spawn attempt so logs, events,
 * metadata and cancellation book-keeping all surface consistent identifiers.
 */
interface PlanFanoutCorrelationContext {
  runId: string;
  opId: string;
  jobId: string;
  graphId: string | null;
  nodeId: string | null;
  parentChildId: string | null;
}

function buildFanoutChildMetadata(
  plan: ResolvedChildPlan,
  variables: Record<string, string | number | boolean>,
  guardSnapshot: ValueGuardSnapshot | null,
  correlation: PlanFanoutCorrelationContext,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
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

function buildFanoutManifestExtras(
  plan: ResolvedChildPlan,
  correlation: PlanFanoutCorrelationContext,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {
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

async function spawnChildWithRetry(
  context: PlanToolContext,
  jobId: string,
  plan: ResolvedChildPlan,
  template: PromptTemplate,
  sharedVariables: Record<string, string | number | boolean>,
  retryPolicy: z.infer<typeof RetryPolicySchema>,
  childIndex: number,
  correlation: PlanFanoutCorrelationContext,
  cancellation: CancellationHandle,
): Promise<SpawnedChildInfo> {
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

  context.graphState.createChild(
    jobId,
    childId,
    {
      name: plan.name,
      system: plan.system,
      goals: plan.goals,
      runtime: plan.runtime,
    },
    {
      createdAt,
      ttlAt: plan.ttlSeconds ? createdAt + plan.ttlSeconds * 1000 : null,
    },
  );
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
      context.graphState.recordChildHeartbeat(
        childId,
        runtimeStatus.lastHeartbeatAt ?? Date.now(),
      );
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
    } catch (error) {
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

async function runWithConcurrency<T>(
  limit: number,
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, tasks.length));
  const results = new Array<T>(tasks.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      if (current >= tasks.length) {
        return;
      }
      index += 1;
      const task = tasks[current];
      results[current] = await task();
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
export async function handlePlanFanout(
  context: PlanToolContext,
  input: PlanFanoutInput,
): Promise<PlanFanoutResult> {
  const resolvedPlans = resolveChildrenPlans(input, context.defaultChildRuntime);
  if (!context.valueGuard) {
    // Without the value guard we refuse to dispatch children that already
    // advertise risky impacts so unvetted side-effects (network writes, file
    // mutations…) never occur implicitly.
    const riskyPlans = resolvedPlans
      .filter((plan) =>
        (plan.valueImpacts ?? []).some((impact) => impact.impact === "risk" && (impact.severity ?? 1) > 0),
      )
      .map((plan) => plan.name);
    if (riskyPlans.length > 0) {
      throw new ValueGuardRequiredError(riskyPlans);
    }
  }
  const rejectedPlans: Array<{ name: string; decision: ValueFilterDecision }> = [];

  const plans: ResolvedChildPlan[] = [];
  const providedCorrelation = extractPlanCorrelationHints(input) ?? null;
  const runId = providedCorrelation?.runId ?? input.run_label ?? `run-${Date.now()}`;
  const opId = providedCorrelation?.opId ?? `plan_fanout_op_${randomUUID()}`;
  const jobId = providedCorrelation?.jobId ?? `job_${randomUUID()}`;
  const graphId = providedCorrelation?.graphId ?? null;
  const nodeId = providedCorrelation?.nodeId ?? null;
  const parentChildId = providedCorrelation?.childId ?? null;
  const correlationLogFields = {
    run_id: runId,
    op_id: opId,
    job_id: jobId,
    graph_id: graphId ?? null,
    node_id: nodeId ?? null,
    child_id: parentChildId ?? null,
  };
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
  } else {
    plans.push(...resolvedPlans);
  }

  const promptTemplate: PromptTemplate = {
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
  } else {
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

  const correlationContext: PlanFanoutCorrelationContext = {
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
      run_id: runId,
      op_id: opId,
      job_id: jobId,
      graph_id: graphId,
      node_id: nodeId,
      child_id: parentChildId,
      children: plans.map((plan) => ({ name: plan.name, runtime: plan.runtime })),
      rejected: rejectedPlans.map((entry) => entry.name),
    },
    correlation: {
      runId,
      opId,
      jobId,
      graphId,
      nodeId,
      childId: parentChildId ?? null,
    },
  });

  const sharedVariables: Record<string, string | number | boolean> = {
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
  let cancellationSubscription: (() => void) | null = null;

  try {
    cancellationSubscription = cancellation.onCancel(({ reason }) => {
      context.logger.warn("plan_fanout_cancel_requested", {
        ...correlationLogFields,
        reason,
      });
    });

    const tasks = plans.map((plan, index) => () =>
      spawnChildWithRetry(
        context,
        jobId,
        plan,
        promptTemplate,
        sharedVariables,
        retryPolicy,
        index + 1,
        correlationContext,
        cancellation,
      ),
    );

    const parallelism = input.parallelism ?? Math.min(3, plans.length || 1);
    const spawned = await runWithConcurrency(parallelism, tasks);

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
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      context.logger.warn("plan_fanout_cancelled", {
        ...correlationLogFields,
        reason: error.details.reason ?? null,
      });
    }
    throw error;
  } finally {
    cancellationSubscription?.();
    unregisterCancellation(opId);
  }
}

interface JoinObservation {
  childId: string;
  status: "success" | "error" | "timeout";
  receivedAt: number | null;
  messageType: string | null;
  summary: string | null;
  outputs: ChildCollectedOutputs | null;
}

async function observeChildForJoin(
  context: PlanToolContext,
  childId: string,
  timeoutMs: number,
): Promise<JoinObservation> {
  try {
    const existing = await context.supervisor.collect(childId);
    const isTerminal = (candidate: ChildRuntimeMessage) => {
      const parsed = candidate.parsed as { type?: string; content?: unknown } | null;
      return (
        parsed?.type === "response" ||
        parsed?.type === "error" ||
        parsed?.type === "shutdown"
      );
    };

    const existingMatch = [...existing.messages].reverse().find(isTerminal);
    if (existingMatch) {
      const parsed = existingMatch.parsed as { type?: string; content?: unknown } | null;
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

    const message = await context.supervisor.waitForMessage(
      childId,
      isTerminal,
      timeoutMs,
    );

    const parsed = message.parsed as { type?: string; content?: unknown } | null;
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
  } catch (error) {
    let outputs: ChildCollectedOutputs | null = null;
    try {
      outputs = await context.supervisor.collect(childId);
    } catch {
      outputs = null;
    }

    return {
      childId,
      status: "timeout",
      receivedAt: null,
      messageType: null,
      summary:
        error instanceof Error
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
export async function handlePlanJoin(
  context: PlanToolContext,
  input: PlanJoinInput,
): Promise<PlanJoinResult> {
  const timeoutMs = (input.timeout_sec ?? 10) * 1000;
  const providedCorrelation = extractPlanCorrelationHints(input);
  const correlationHints = toEventCorrelationHints(providedCorrelation);
  const correlationPayload = serialiseCorrelationForPayload(correlationHints);
  context.logger.info("plan_join", {
    children: input.children.length,
    policy: input.join_policy,
    timeout_ms: timeoutMs,
    ...correlationPayload,
  });
  const observations = await Promise.all(
    input.children.map((childId) => observeChildForJoin(context, childId, timeoutMs)),
  );

  const successes = observations.filter((obs) => obs.status === "success");
  const failures = observations.filter((obs) => obs.status !== "success");
  const sorted = [...observations].sort((a, b) => {
    if (a.receivedAt === null && b.receivedAt === null) return 0;
    if (a.receivedAt === null) return 1;
    if (b.receivedAt === null) return -1;
    return a.receivedAt - b.receivedAt;
  });

  const statusVotes: ConsensusVote[] = observations.map((obs) => ({
    voter: obs.childId,
    value: obs.status,
  }));
  const baseQuorum = input.quorum_count ?? Math.ceil(input.children.length / 2);
  const consensusConfig = input.consensus
    ? ConsensusConfigSchema.parse(input.consensus)
    : undefined;
  let consensusDecision: ConsensusDecision | null = null;
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
  let threshold: number | null = null;
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
      } else {
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

function summariseChildOutputs(outputs: ChildCollectedOutputs): string | null {
  if (!outputs.messages.length) {
    return null;
  }

  const last = outputs.messages[outputs.messages.length - 1];
  const parsed = last.parsed as { type?: string; content?: unknown } | null;
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
function normaliseVoteSummary(summary: string): { value: string | null; source: string } {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { value: null, source: "empty" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return { value: String(parsed), source: typeof parsed };
    }
    if (parsed && typeof parsed === "object") {
      const candidate = parsed as Record<string, unknown>;
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
  } catch {
    // Ignore parse failures and fall back to the trimmed string below.
  }

  return { value: trimmed, source: "raw" };
}

/**
 * Reduces the responses of multiple children using strategies such as
 * concatenation, JSON merge or majority vote.
 */
export async function handlePlanReduce(
  context: PlanToolContext,
  input: PlanReduceInput,
): Promise<PlanReduceResult> {
  const outputs = await Promise.all(
    input.children.map((childId) => context.supervisor.collect(childId)),
  );

  const providedCorrelation = extractPlanCorrelationHints(input);
  const correlationHints = toEventCorrelationHints(providedCorrelation);
  const correlationPayload = serialiseCorrelationForPayload(correlationHints);

  const guardDecisions = new Map<string, ValueFilterDecision>();
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

  let result: PlanReduceResult;
  switch (input.reducer) {
    case "concat": {
      const aggregate = summaries
        .map((item) => item.summary)
        .filter((summary): summary is string => typeof summary === "string")
        .join("\n\n");
      result = {
        reducer: input.reducer,
        aggregate,
        trace: { per_child: summaries },
      };
      break;
    }
    case "merge_json": {
      const aggregate: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      for (const item of summaries) {
        if (!item.summary) continue;
        try {
          const parsed = JSON.parse(item.summary);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            Object.assign(aggregate, parsed as Record<string, unknown>);
          } else {
            errors[item.child_id] = "summary is not a JSON object";
          }
        } catch (error) {
          errors[item.child_id] =
            error instanceof Error ? error.message : String(error);
        }
      }
      const traceDetails: Record<string, unknown> = {};
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
      const voteSources: Record<string, { value: string | null; source: string }> = {};
      const votes: ConsensusVote[] = [];
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

      const adjustedWeights: Record<string, number> = { ...(baseOptions.weights ?? {}) };
      for (const vote of votes) {
        const baseWeight = adjustedWeights[vote.voter] ?? baseOptions.weights?.[vote.voter] ?? 1;
        const guardWeight = guardDecisions.has(vote.voter)
          ? Math.max(0, guardDecisions.get(vote.voter)!.score)
          : 1;
        const weight = baseWeight * guardWeight;
        adjustedWeights[vote.voter] = Number.isFinite(weight) && weight >= 0 ? weight : 0;
      }

      const weightFor = (vote: ConsensusVote) => {
        const candidate = adjustedWeights[vote.voter];
        return typeof candidate === "number" && candidate >= 0 ? candidate : 1;
      };
      const totalWeight = votes.reduce((acc, vote) => acc + weightFor(vote), 0);
      const defaultQuorum = configuredQuorum ?? (totalWeight > 0 ? Math.floor(totalWeight / 2) + 1 : 1);

      let decision: ConsensusDecision;
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
      const traceDetails: Record<string, unknown> = { consensus: aggregate };
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
    const guardTrace = Object.fromEntries(
      Array.from(guardDecisions.entries()).map(([childId, decision]) => [
        childId,
        serialiseValueGuardDecision(decision),
      ]),
    );
    const details = result.trace.details ? { ...result.trace.details } : {};
    details.value_guard = guardTrace;
    result.trace.details = details;
  }

  context.logger.info("plan_reduce_completed", {
    reducer: input.reducer,
    aggregate_kind: typeof result.aggregate,
    child_count: summaries.length,
  });

  return result;
}

/**
 * Compile a hierarchical graph into a serialised Behaviour Tree definition. The
 * compiler is deterministic which keeps downstream tests and audits reliable.
 */
export function handlePlanCompileBT(
  context: PlanToolContext,
  input: PlanCompileBTInput,
): PlanCompileBTResult {
  context.logger.info("plan_compile_bt", { graph_id: input.graph.id });
  const compiled = compileHierGraphToBehaviorTree(input.graph);
  return CompiledBehaviorTreeSchema.parse(compiled);
}

/**
 * Execute a Behaviour Tree by delegating leaf nodes to orchestrator tools. The
 * interpreter records every invocation so tests and operators can trace the
 * decision flow precisely.
 */
async function executePlanRunBT(
  context: PlanToolContext,
  input: PlanRunBTInput,
): Promise<PlanRunBTExecutionSnapshot> {
  const schemaRegistry = { ...BehaviorTaskSchemas };
  const invocations: PlanRunBTExecutionSnapshot["invocations"] = [];
  let lastOutput: unknown = null;
  let lastResultStatus: BTStatus = "running";
  let sawFailure = false;
  let reportedError = false;

  const dryRun = input.dry_run ?? false;
  const providedCorrelation = extractPlanCorrelationHints(input) ?? null;
  const runId = providedCorrelation?.runId ?? `bt_run_${randomUUID()}`;
  const opId = providedCorrelation?.opId ?? `bt_op_${randomUUID()}`;
  const jobId = providedCorrelation?.jobId ?? null;
  const graphId = providedCorrelation?.graphId ?? null;
  const nodeId = providedCorrelation?.nodeId ?? null;
  const childId = providedCorrelation?.childId ?? null;
  const correlationLogFields = {
    run_id: runId,
    op_id: opId,
    job_id: jobId,
    graph_id: graphId,
    node_id: nodeId,
    child_id: childId,
  };
  const baseLogFields = { ...correlationLogFields, tree_id: input.tree.id };
  const estimatedWork = estimateBehaviorTreeWorkload(input.tree.root);

  registerPlanLifecycleRun(context, {
    runId,
    opId,
    mode: "bt",
    dryRun,
    correlation: providedCorrelation,
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
  const publishLifecycleEvent = (phase: PlanLifecyclePhase, payload: Record<string, unknown>) => {
    const eventPayload = {
      phase,
      tree_id: input.tree.id,
      dry_run: dryRun,
      mode: "bt",
      ...correlationLogFields,
      ...payload,
    } satisfies Record<string, unknown>;
    recordPlanLifecycleEvent(context, runId, phase, eventPayload);
    context.emitEvent({
      kind: "BT_RUN",
      level: phase === "error" ? "error" : "info",
      jobId: jobId ?? undefined,
      childId: childId ?? undefined,
      payload: eventPayload,
      correlation: {
        runId,
        opId,
        jobId,
        graphId,
        nodeId,
        childId,
      },
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
  let cancellationSubscription: (() => void) | null = null;

  if (context.btStatusRegistry) {
    context.btStatusRegistry.reset(input.tree.id);
  }
  const statusReporter = (nodeId: string, status: BTStatus) => {
    context.btStatusRegistry?.record(input.tree.id, nodeId, status);
    publishLifecycleEvent("node", { node_id: nodeId, status });
  };

  const interpreter = new BehaviorTreeInterpreter(
    buildBehaviorTree(input.tree.root, { taskSchemas: schemaRegistry, statusReporter }),
  );

  const causalMemory = context.causalMemory;
  let scheduler: ReactiveScheduler | null = null;
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
    invokeTool: async (tool: string, taskInput: unknown) => {
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
        ? causalMemory.record(
            {
              type: "bt.tool.invoke",
              data: { tool, input: summariseForCausalMemory(taskInput) },
              tags: ["bt", "tool", tool],
            },
            parentCauses,
          )
        : null;
      try {
        const output = await handler(context, taskInput);
        invocations.push({ tool, input: taskInput, output, executed: true });
        lastOutput = output;
        if (causalMemory) {
          causalMemory.record(
            {
              type: "bt.tool.success",
              data: { tool, output: summariseForCausalMemory(output) },
              tags: ["bt", "tool", "success", tool],
            },
            invocationEvent ? [invocationEvent.id] : parentCauses,
          );
        }
        return output;
      } catch (error) {
        if (causalMemory) {
          const message = error instanceof Error ? error.message : String(error);
          causalMemory.record(
            {
              type: "bt.tool.failure",
              data: { tool, message },
              tags: ["bt", "tool", "failure", tool],
            },
            invocationEvent ? [invocationEvent.id] : parentCauses,
          );
        }
        throw error;
      }
    },
    now: () => Date.now(),
    wait: async (ms: number) => {
      await waitWithCancellation(cancellation, ms);
    },
    variables: input.variables,
    cancellationSignal: cancellation.signal,
    isCancelled: () => cancellation.isCancelled(),
    throwIfCancelled: () => cancellation.throwIfCancelled(),
    recommendTimeout: loopDetector
      ? (category: string, complexityScore?: number, fallbackMs?: number) => {
          try {
            return loopDetector.recommendTimeout(category, complexityScore ?? 1);
          } catch (error) {
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
  } satisfies Partial<TickRuntime> & { invokeTool: (tool: string, input: unknown) => Promise<unknown> };

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

  const rootId =
    ("id" in input.tree.root && input.tree.root.id) ||
    ("node_id" in input.tree.root && (input.tree.root as { node_id?: string }).node_id) ||
    input.tree.id;

  const timeoutMs = input.timeout_ms ?? null;

  try {
    const runPromise = schedulerRef.runUntilSettled({
      type: "taskReady",
      payload: { nodeId: rootId, criticality: 1 },
    });
    let result: BehaviorTickResult;
    if (timeoutMs !== null) {
      const outcome = await Promise.race([
        runPromise.then((value) => ({ kind: "result" as const, value })),
        delay(timeoutMs).then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind === "timeout") {
        schedulerRef.stop();
        await runPromise.catch(() => undefined);
        throw new BehaviorTreeRunTimeoutError(timeoutMs);
      }
      result = outcome.value;
    } else {
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
  } catch (error) {
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
  } finally {
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

export async function handlePlanRunBT(
  context: PlanToolContext,
  input: PlanRunBTInput,
): Promise<PlanRunBTResult> {
  const key = input.idempotency_key ?? null;

  if (context.idempotency && key) {
    const hit = await context.idempotency.remember<PlanRunBTExecutionSnapshot>(
      `plan_run_bt:${key}`,
      () => executePlanRunBT(context, input),
    );
    if (hit.idempotent) {
      const snapshot = hit.value as PlanRunBTExecutionSnapshot;
      context.logger.info("plan_run_bt_replayed", {
        run_id: snapshot.run_id,
        op_id: snapshot.op_id,
        idempotency_key: key,
      });
    }
    const snapshot = hit.value as PlanRunBTExecutionSnapshot;
    return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key } as PlanRunBTResult;
  }

  const snapshot = await executePlanRunBT(context, input);
  return { ...snapshot, idempotent: false, idempotency_key: key } as PlanRunBTResult;
}

/**
 * Executes a Behaviour Tree inside the reactive execution loop. The loop wires
 * autoscaling and supervision reconcilers so orchestration side-effects are
 * applied after every scheduler tick. The handler mirrors
 * {@link handlePlanRunBT} telemetry while surfacing loop-specific metrics.
 */
async function executePlanRunReactive(
  context: PlanToolContext,
  input: PlanRunReactiveInput,
): Promise<PlanRunReactiveExecutionSnapshot> {
  const schemaRegistry = { ...BehaviorTaskSchemas };
  const invocations: PlanRunReactiveExecutionSnapshot["invocations"] = [];
  const dryRun = input.dry_run ?? false;
  let lastOutput: unknown = null;
  let lastResultStatus: BTStatus = "running";

  const providedCorrelation = extractPlanCorrelationHints(input) ?? null;
  const runId = providedCorrelation?.runId ?? `bt_reactive_run_${randomUUID()}`;
  const opId = providedCorrelation?.opId ?? `bt_reactive_op_${randomUUID()}`;
  const jobId = providedCorrelation?.jobId ?? null;
  const graphId = providedCorrelation?.graphId ?? null;
  const nodeId = providedCorrelation?.nodeId ?? null;
  const childId = providedCorrelation?.childId ?? null;
  const correlationLogFields = {
    run_id: runId,
    op_id: opId,
    job_id: jobId,
    graph_id: graphId,
    node_id: nodeId,
    child_id: childId,
  };
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
    correlation: providedCorrelation,
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
  const publishLifecycleEvent = (phase: PlanLifecyclePhase, payload: Record<string, unknown>) => {
    const eventPayload = {
      phase,
      tree_id: input.tree.id,
      dry_run: dryRun,
      mode: "reactive",
      ...correlationLogFields,
      ...payload,
    } satisfies Record<string, unknown>;
    recordPlanLifecycleEvent(context, runId, phase, eventPayload);
    context.emitEvent({
      kind: "BT_RUN",
      level: phase === "error" ? "error" : "info",
      jobId: jobId ?? undefined,
      childId: childId ?? undefined,
      payload: eventPayload,
      correlation: {
        runId,
        opId,
        jobId,
        graphId,
        nodeId,
        childId,
      },
    });
  };

  /**
   * Publish scheduler telemetry with a stable `msg` value so event
   * subscriptions can easily discriminate enqueued events from tick results
   * without inspecting the nested payload. Each emission carries the
   * correlation hints propagated by the caller so dashboards may link the
   * scheduler activity back to the originating plan run.
   */
  const emitSchedulerTelemetry = (
    message: "scheduler_event_enqueued" | "scheduler_tick_result",
    payload: Record<string, unknown>,
  ) => {
    context.emitEvent({
      kind: "SCHEDULER",
      jobId: jobId ?? undefined,
      childId: childId ?? undefined,
      payload: {
        msg: message,
        ...correlationLogFields,
        ...payload,
      },
      correlation: {
        runId,
        opId,
        jobId,
        graphId,
        nodeId,
        childId,
      },
    });
  };

  publishLifecycleEvent("start", { tick_ms: input.tick_ms, budget_ms: input.budget_ms ?? null });

  const causalMemory = context.causalMemory;
  const loopDetector = context.loopDetector ?? null;
  const autoscaler = context.autoscaler ?? null;
  let scheduler: ReactiveScheduler | null = null;
  let loop: ExecutionLoop | null = null;
  let unsubscribeBlackboard: (() => void) | null = null;
  const cancellation = registerCancellation(opId, {
    runId,
    jobId,
    graphId,
    nodeId,
    childId,
  });
  const previousCancellation = context.activeCancellation ?? null;
  context.activeCancellation = cancellation;
  let cancellationSubscription: (() => void) | null = null;

  if (context.btStatusRegistry) {
    context.btStatusRegistry.reset(input.tree.id);
  }
  const statusReporter = (nodeId: string, status: BTStatus) => {
    context.btStatusRegistry?.record(input.tree.id, nodeId, status);
    publishLifecycleEvent("node", { node_id: nodeId, status });
  };

  const interpreter = new BehaviorTreeInterpreter(
    buildBehaviorTree(input.tree.root, { taskSchemas: schemaRegistry, statusReporter }),
  );

  const runtime = {
    invokeTool: async (tool: string, taskInput: unknown) => {
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
        ? causalMemory.record(
            {
              type: "bt.tool.invoke",
              data: { tool, input: summariseForCausalMemory(taskInput) },
              tags: ["bt", "tool", tool],
            },
            parentCauses,
          )
        : null;
      try {
        const output = await handler(context, taskInput);
        invocations.push({ tool, input: taskInput, output, executed: true });
        lastOutput = output;
        if (causalMemory) {
          causalMemory.record(
            {
              type: "bt.tool.success",
              data: { tool, output: summariseForCausalMemory(output) },
              tags: ["bt", "tool", "success", tool],
            },
            invocationEvent ? [invocationEvent.id] : parentCauses,
          );
        }
        return output;
      } catch (error) {
        if (causalMemory) {
          const message = error instanceof Error ? error.message : String(error);
          causalMemory.record(
            {
              type: "bt.tool.failure",
              data: { tool, message },
              tags: ["bt", "tool", "failure", tool],
            },
            invocationEvent ? [invocationEvent.id] : parentCauses,
          );
        }
        throw error;
      }
    },
    now: () => Date.now(),
    wait: async (ms: number) => {
      await waitWithCancellation(cancellation, ms);
    },
    variables: input.variables,
    cancellationSignal: cancellation.signal,
    isCancelled: () => cancellation.isCancelled(),
    throwIfCancelled: () => cancellation.throwIfCancelled(),
    recommendTimeout: loopDetector
      ? (category: string, complexityScore?: number, fallbackMs?: number) => {
          try {
            return loopDetector.recommendTimeout(category, complexityScore ?? 1);
          } catch (error) {
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
  } satisfies Partial<TickRuntime> & { invokeTool: (tool: string, input: unknown) => Promise<unknown> };

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

  const rootId =
    ("id" in input.tree.root && input.tree.root.id) ||
    ("node_id" in input.tree.root && (input.tree.root as { node_id?: string }).node_id) ||
    input.tree.id;

  let executedLoopTicks = 0;
  let pendingLoopEvent: { loopTick: number; executedTicks: number; status: BTStatus } | null = null;

  let finish: ((result: BehaviorTickResult) => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  let runCompleted = false;

  const runPromise = new Promise<BehaviorTickResult>((resolve, reject) => {
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
      const initialEvent =
        loopContext.tickIndex === 0
          ? { type: "taskReady" as const, payload: { nodeId: rootId, criticality: 1 } }
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
      } catch (error) {
        fail?.(error);
      }
    },
  });

  attachPlanLifecycleControls(context, runId, {
    pause: () => loop?.pause() ?? false,
    resume: () => loop?.resume() ?? false,
  });

  let timeoutHandle: NodeJS.Timeout | null = null;
  if (input.timeout_ms !== undefined) {
    timeoutHandle = setTimeout(() => {
      fail?.(new BehaviorTreeRunTimeoutError(input.timeout_ms!));
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
  } catch (error) {
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
  } finally {
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

export async function handlePlanRunReactive(
  context: PlanToolContext,
  input: PlanRunReactiveInput,
): Promise<PlanRunReactiveResult> {
  const key = input.idempotency_key ?? null;

  if (context.idempotency && key) {
    const hit = await context.idempotency.remember<PlanRunReactiveExecutionSnapshot>(
      `plan_run_reactive:${key}`,
      () => executePlanRunReactive(context, input),
    );
    if (hit.idempotent) {
      const snapshot = hit.value as PlanRunReactiveExecutionSnapshot;
      context.logger.info("plan_run_reactive_replayed", {
        run_id: snapshot.run_id,
        op_id: snapshot.op_id,
        idempotency_key: key,
      });
    }
    const snapshot = hit.value as PlanRunReactiveExecutionSnapshot;
    return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key } as PlanRunReactiveResult;
  }

  const snapshot = await executePlanRunReactive(context, input);
  return { ...snapshot, idempotent: false, idempotency_key: key } as PlanRunReactiveResult;
}

/**
 * Performs a dry-run of a plan without executing any side effects. The handler
 * compiles the provided hierarchical graph (when present), aggregates declared
 * value impacts and, if the value guard is enabled, produces an explanation by
 * delegating to {@link ValueGraph.explain}. The response acts as a preview so
 * operators can iterate on plans before triggering a real execution.
 */
type PlanDryRunGraphInput = z.infer<typeof PlanDryRunGraphSchema>;

/** Determine whether the caller supplied a hierarchical graph payload. */
function isHierarchicalDryRunGraph(graph: PlanDryRunGraphInput): graph is z.infer<typeof HierGraphSchema> {
  const nodes = (graph as { nodes?: unknown }).nodes;
  const edges = (graph as { edges?: unknown }).edges;
  if (!Array.isArray(nodes) || nodes.length === 0 || !Array.isArray(edges)) {
    return false;
  }
  const hierarchicalNodes = nodes.every((node) => {
    if (!node || typeof node !== "object") {
      return false;
    }
    const kind = (node as { kind?: unknown }).kind;
    return kind === "task" || kind === "subgraph";
  });
  if (!hierarchicalNodes) {
    return false;
  }
  return edges.every((edge) => {
    if (!edge || typeof edge !== "object") {
      return false;
    }
    const from = (edge as { from?: unknown }).from;
    const to = (edge as { to?: unknown }).to;
    return (
      !!from &&
      typeof from === "object" &&
      typeof (from as { nodeId?: unknown }).nodeId === "string" &&
      !!to &&
      typeof to === "object" &&
      typeof (to as { nodeId?: unknown }).nodeId === "string"
    );
  });
}

/**
 * Normalise the graph provided to the dry-run handler. Callers may supply either a
 * hierarchical payload or a graph descriptor already flattened by the graph tools.
 */
function normalisePlanDryRunGraph(
  graph: PlanDryRunInput["graph"] | null | undefined,
): NormalisedGraph | null {
  if (!graph) {
    return null;
  }
  const candidate = graph as PlanDryRunGraphInput;
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
function deriveRerouteAvoidHints(
  graph: NormalisedGraph,
  rewrite?: PlanDryRunRewriteOptions | null,
  rerouteAvoid?: PlanDryRunRerouteAvoid | null,
): { avoidNodeIds?: Set<string>; avoidLabels?: Set<string> } {
  const avoidNodeIds = new Set<string>();
  const avoidLabels = new Set<string>();

  const registerNodeId = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      avoidNodeIds.add(trimmed);
    }
  };

  const registerLabel = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      avoidLabels.add(trimmed);
    }
  };

  const registerRerouteNode = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        registerNodeId(entry);
      }
      return;
    }
    registerNodeId(value);
  };

  const registerRerouteLabel = (value: unknown) => {
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
    const attributes = (node.attributes ?? {}) as Record<string, unknown>;
    const tagList = Array.isArray(attributes.tags) ? (attributes.tags as unknown[]) : [];
    const loweredTags = new Set(
      tagList
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.toLowerCase()),
    );
    const flagged =
      attributes.avoid === true ||
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

export function handlePlanDryRun(
  context: PlanToolContext,
  input: PlanDryRunInput,
): PlanDryRunResult {
  const hierarchicalGraph =
    input.graph && isHierarchicalDryRunGraph(input.graph as PlanDryRunGraphInput)
      ? (input.graph as z.infer<typeof HierGraphSchema>)
      : null;

  const compiledTree = input.tree
    ? (structuredClone(input.tree) as CompiledBehaviorTree)
    : hierarchicalGraph
    ? compileHierGraphToBehaviorTree(hierarchicalGraph)
    : null;

  let rewritePreview: PlanDryRunResult["rewrite_preview"] = null;
  let rerouteAvoid: PlanDryRunResult["reroute_avoid"] = null;
  const normalisedGraph = normalisePlanDryRunGraph(input.graph);
  if (normalisedGraph) {
    const rerouteHints = deriveRerouteAvoidHints(
      normalisedGraph,
      input.rewrite ?? null,
      input.reroute_avoid ?? null,
    );
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

  const nodeSummaries: PlanDryRunNodeSummary[] = [];
  const aggregatedImpacts: ValueImpactInput[] = [];

  for (const node of input.nodes ?? []) {
    const impacts = (node.value_impacts ?? []).map((impact) =>
      normalisePlanImpact(impact, node.id),
    );
    aggregatedImpacts.push(...impacts);
    nodeSummaries.push({ id: node.id, label: node.label ?? null, impacts });
  }

  for (const impact of input.impacts ?? []) {
    aggregatedImpacts.push(normalisePlanImpact(impact, undefined));
  }

  let explanation: ValueExplanationResult | null = null;
  const correlation = extractPlanCorrelationHints(input);
  const guard = context.valueGuard;
  if (guard && aggregatedImpacts.length > 0) {
    explanation = guard.graph.explain(
      {
        id: input.plan_id,
        label: input.plan_label,
        impacts: aggregatedImpacts,
        threshold: input.threshold,
      },
      { correlation },
    );
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
  } else if (!guard) {
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
  } satisfies PlanDryRunResult;
}

/** Retrieve the lifecycle snapshot associated with a Behaviour Tree execution. */
export function handlePlanStatus(context: PlanToolContext, input: PlanStatusInput): PlanLifecycleSnapshot {
  const registry = requirePlanLifecycle(context, "plan_status", input.run_id);
  return registry.getSnapshot(input.run_id);
}

/** Pause a running Behaviour Tree execution when lifecycle tooling is enabled. */
export async function handlePlanPause(
  context: PlanToolContext,
  input: PlanPauseInput,
): Promise<PlanLifecycleSnapshot> {
  const registry = requirePlanLifecycle(context, "plan_pause", input.run_id);
  return registry.pause(input.run_id);
}

/** Resume a paused Behaviour Tree execution when lifecycle tooling is enabled. */
export async function handlePlanResume(
  context: PlanToolContext,
  input: PlanResumeInput,
): Promise<PlanLifecycleSnapshot> {
  const registry = requirePlanLifecycle(context, "plan_resume", input.run_id);
  return registry.resume(input.run_id);
}

/**
 * Normalises an impact payload so it matches {@link ValueImpactInput} while
 * preserving any correlation metadata declared on the plan node.
 */
function normalisePlanImpact(
  impact: z.infer<typeof PlanNodeImpactSchema>,
  fallbackNodeId: string | undefined,
): ValueImpactInput {
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
 * Extract correlation hints supplied to the dry-run tool. Returning `null`
 * keeps downstream consumers tidy when no metadata is provided while ensuring
 * value guard events still expose the identifiers when they exist.
 */
type PlanCorrelationHintsInput = z.infer<typeof PlanCorrelationHintsSchema>;

/**
 * Convert correlation hints provided by plan tooling into the camel-cased
 * structure consumed by downstream value guard and event bus helpers.
 */
function extractPlanCorrelationHints(
  input: Partial<PlanCorrelationHintsInput>,
): ValueGraphCorrelationHints | null {
  const hints: ValueGraphCorrelationHints = {};
  if (input.run_id !== undefined) hints.runId = input.run_id;
  if (input.op_id !== undefined) hints.opId = input.op_id;
  if (input.job_id !== undefined) hints.jobId = input.job_id;
  if (input.graph_id !== undefined) hints.graphId = input.graph_id;
  if (input.node_id !== undefined) hints.nodeId = input.node_id;
  if (input.child_id !== undefined) hints.childId = input.child_id;

  return Object.keys(hints).length > 0 ? hints : null;
}

/**
 * Convert plan-level correlation hints into the event-centric structure consumed by
 * the unified MCP bus. Keeping the mapping centralised ensures every tool uses the
 * same normalisation (notably the preservation of explicit `null` values).
 */
function toEventCorrelationHints(
  hints: ValueGraphCorrelationHints | null | undefined,
): EventCorrelationHints {
  const correlation: EventCorrelationHints = {};
  if (!hints) {
    return correlation;
  }
  if (hints.runId !== undefined) correlation.runId = hints.runId;
  if (hints.opId !== undefined) correlation.opId = hints.opId;
  if (hints.jobId !== undefined) correlation.jobId = hints.jobId;
  if (hints.graphId !== undefined) correlation.graphId = hints.graphId;
  if (hints.nodeId !== undefined) correlation.nodeId = hints.nodeId;
  if (hints.childId !== undefined) correlation.childId = hints.childId;
  return correlation;
}

/**
 * Serialise correlation hints with snake_case keys for event payloads and logs.
 * The helper mirrors {@link toEventCorrelationHints} so call sites can reuse the
 * same structure without hand-crafting objects repeatedly.
 */
function serialiseCorrelationForPayload(
  hints: EventCorrelationHints,
): {
  run_id: string | null;
  op_id: string | null;
  job_id: string | null;
  graph_id: string | null;
  node_id: string | null;
  child_id: string | null;
} {
  return {
    run_id: hints.runId ?? null,
    op_id: hints.opId ?? null,
    job_id: hints.jobId ?? null,
    graph_id: hints.graphId ?? null,
    node_id: hints.nodeId ?? null,
    child_id: hints.childId ?? null,
  };
}
