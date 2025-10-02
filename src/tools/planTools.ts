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
  CompiledBehaviorTreeSchema,
  type BTStatus,
  type BehaviorTickResult,
  type TickRuntime,
} from "../executor/bt/types.js";
import { ReactiveScheduler } from "../executor/reactiveScheduler.js";
import {
  ConsensusConfigSchema,
  majority as computeConsensusMajority,
  normaliseConsensusOptions,
  quorum as computeConsensusQuorum,
  weighted as computeConsensusWeighted,
  type ConsensusDecision,
  type ConsensusVote,
} from "../coord/consensus.js";
import { StigmergyField } from "../coord/stigmergy.js";
import type { CausalMemory } from "../knowledge/causalMemory.js";
import type {
  ValueFilterDecision,
  ValueGraph,
  ValueImpactInput,
  ValueViolation,
} from "../values/valueGraph.js";
import { GraphState } from "../graphState.js";
import { StructuredLogger } from "../logger.js";
import { OrchestratorSupervisor } from "../agents/supervisor.js";
import { ensureDirectory, resolveWithin } from "../paths.js";
import {
  PromptTemplate,
  PromptMessage,
  PromptTemplateSchema,
  PromptVariablesSchema,
  renderPromptTemplate,
} from "../prompts.js";
import { EventKind, EventLevel } from "../eventStore.js";

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
}) => void;

/** Shared runtime injected when the value guard feature is enabled. */
export interface ValueGuardRuntime {
  /** Configured value graph storing principles and relations. */
  graph: ValueGraph;
  /** Registry keeping the last decision taken for each child id. */
  registry: Map<string, ValueFilterDecision>;
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
  /** Optional orchestrator supervisor handling loop and stagnation mitigation. */
  supervisorAgent?: OrchestratorSupervisor;
  /** Optional causal memory capturing scheduler and Behaviour Tree events. */
  causalMemory?: CausalMemory;
  /** Optional value guard filtering unsafe plans before execution. */
  valueGuard?: ValueGuardRuntime;
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

/** Input payload accepted by the `plan_fanout` tool. */
export const PlanFanoutInputSchema = z.object({
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
});

export type PlanFanoutInput = z.infer<typeof PlanFanoutInputSchema>;
export const PlanFanoutInputShape = PlanFanoutInputSchema.shape;

/** Output payload returned by {@link handlePlanFanout}. */
export interface PlanFanoutResult extends Record<string, unknown> {
  run_id: string;
  job_id: string;
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
export const PlanJoinInputSchema = z.object({
  children: z.array(z.string().min(1)).min(1),
  join_policy: JoinPolicySchema.default("all"),
  timeout_sec: z.number().int().positive().optional(),
  quorum_count: z.number().int().positive().optional(),
  consensus: ConsensusConfigSchema.optional(),
});

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
export const PlanReduceInputSchema = z.object({
  children: z.array(z.string().min(1)).min(1),
  reducer: z.enum(["concat", "merge_json", "vote", "custom"]),
  spec: z.record(z.unknown()).optional(),
});

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

/** Input payload accepted by the `plan_compile_bt` tool. */
export const PlanCompileBTInputSchema = z.object({
  graph: HierGraphSchema,
});

export type PlanCompileBTInput = z.infer<typeof PlanCompileBTInputSchema>;
export type PlanCompileBTResult = z.infer<typeof CompiledBehaviorTreeSchema>;
export const PlanCompileBTInputShape = PlanCompileBTInputSchema.shape;

/** Input payload accepted by the `plan_run_bt` tool. */
export const PlanRunBTInputSchema = z.object({
  tree: CompiledBehaviorTreeSchema,
  variables: z.record(z.unknown()).default({}),
  dry_run: z.boolean().default(false),
  timeout_ms: z.number().int().min(1).max(60_000).optional(),
});

export type PlanRunBTInput = z.infer<typeof PlanRunBTInputSchema>;
export const PlanRunBTInputShape = PlanRunBTInputSchema.shape;

/** Result returned by {@link handlePlanRunBT}. */
export interface PlanRunBTResult extends Record<string, unknown> {
  status: BTStatus;
  ticks: number;
  last_output: unknown;
  invocations: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    executed: boolean;
  }>;
}

/** Default schema registry used by the Behaviour Tree interpreter. */
const BehaviorTaskSchemas: Record<string, z.ZodTypeAny> = {
  noop: z.any(),
};

/** Tool handlers executed by the Behaviour Tree interpreter. */
type BehaviorToolHandler = (context: PlanToolContext, input: unknown) => Promise<unknown>;

const BehaviorToolHandlers: Record<string, BehaviorToolHandler> = {
  noop: async (_context, input) => input ?? null,
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

async function spawnChildWithRetry(
  context: PlanToolContext,
  jobId: string,
  plan: ResolvedChildPlan,
  template: PromptTemplate,
  sharedVariables: Record<string, string | number | boolean>,
  retryPolicy: z.infer<typeof RetryPolicySchema>,
  childIndex: number,
): Promise<SpawnedChildInfo> {
  const childId = `child_${randomUUID()}`;
  const createdAt = Date.now();
  const guardDecision = plan.valueDecision ?? null;
  const guardSnapshot = serialiseValueGuardDecision(guardDecision);

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
    attempt += 1;
    try {
      context.logger.info("plan_fanout_spawn_attempt", {
        child_id: childId,
        name: plan.name,
        attempt,
      });

      const created = await context.supervisor.createChild({
        childId,
        command: plan.command,
        args: plan.args,
        env: plan.env,
        metadata: {
          ...(plan.metadata ?? {}),
          plan: "fanout",
          job_id: jobId,
          child_name: plan.name,
          prompt_variables: variables,
          value_guard: guardSnapshot,
        },
        manifestExtras: {
          ...(plan.manifestExtras ?? {}),
          plan: "fanout",
          job_id: jobId,
        },
        waitForReady: true,
      });

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
      context.logger.error("plan_fanout_spawn_failed", {
        child_id: childId,
        name: plan.name,
        attempt,
        message: error instanceof Error ? error.message : String(error),
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
  const rejectedPlans: Array<{ name: string; decision: ValueFilterDecision }> = [];

  const plans: ResolvedChildPlan[] = [];
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

  const runId = input.run_label ?? `run-${Date.now()}`;
  const jobId = `job_${randomUUID()}`;
  const createdAt = Date.now();

  context.graphState.createJob(jobId, {
    goal: input.goal,
    createdAt,
    state: "running",
  });

  context.logger.info("plan_fanout", {
    job_id: jobId,
    run_id: runId,
    children: plans.length,
  });

  context.emitEvent({
    kind: "PLAN",
    jobId,
    payload: {
      run_id: runId,
      children: plans.map((plan) => ({ name: plan.name, runtime: plan.runtime })),
      rejected: rejectedPlans.map((entry) => entry.name),
    },
  });

  const sharedVariables: Record<string, string | number | boolean> = {
    job_id: jobId,
    run_id: runId,
  };
  if (input.goal) {
    sharedVariables.goal = input.goal;
  }

  const retryPolicy = input.retry
    ? RetryPolicySchema.parse(input.retry)
    : RetryPolicySchema.parse({});

  const tasks = plans.map((plan, index) => () =>
    spawnChildWithRetry(
      context,
      jobId,
      plan,
      promptTemplate,
      sharedVariables,
      retryPolicy,
      index + 1,
    ),
  );

  const parallelism = input.parallelism ?? Math.min(3, plans.length || 1);
  const spawned = await runWithConcurrency(parallelism, tasks);

  const runDirectory = await ensureDirectory(context.childrenRoot, runId);
  const mappingPath = resolveWithin(runDirectory, "fanout.json");
  const serialisedRejections = rejectedPlans.map((entry) => ({
    name: entry.name,
    value_guard: serialiseValueGuardDecision(entry.decision),
  }));
  const mappingPayload = {
    run_id: runId,
    created_at: createdAt,
    job_id: jobId,
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
  context.logger.info("plan_join", {
    children: input.children.length,
    policy: input.join_policy,
    timeout_ms: timeoutMs,
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

  context.emitEvent({
    kind: "STATUS",
    payload: {
      policy: input.join_policy,
      satisfied,
      successes: successes.length,
      failures: failures.length,
      consensus: consensusPayload,
    },
  });

  context.logger.info("plan_join_completed", {
    policy: input.join_policy,
    satisfied,
    successes: successes.length,
    failures: failures.length,
    winning_child_id: winningChild,
    consensus_mode: consensusPayload?.mode ?? null,
    consensus_outcome: consensusPayload?.outcome ?? null,
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
  });

  context.emitEvent({
    kind: "AGGREGATE",
    payload: {
      reducer: input.reducer,
      children: summaries.map((item) => item.child_id),
    },
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
export async function handlePlanRunBT(
  context: PlanToolContext,
  input: PlanRunBTInput,
): Promise<PlanRunBTResult> {
  const schemaRegistry = { ...BehaviorTaskSchemas };
  const interpreter = new BehaviorTreeInterpreter(
    buildBehaviorTree(input.tree.root, { taskSchemas: schemaRegistry }),
  );
  const invocations: PlanRunBTResult["invocations"] = [];
  let lastOutput: unknown = null;
  let lastResultStatus: BTStatus = "running";

  const dryRun = input.dry_run ?? false;
  context.logger.info("plan_run_bt", {
    tree_id: input.tree.id,
    dry_run: dryRun,
  });

  const causalMemory = context.causalMemory;
  let scheduler: ReactiveScheduler;

  const runtime = {
    invokeTool: async (tool: string, taskInput: unknown) => {
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
      if (ms <= 0) {
        return;
      }
      await delay(ms);
    },
    variables: input.variables,
  } satisfies Partial<TickRuntime> & { invokeTool: (tool: string, input: unknown) => Promise<unknown> };

  scheduler = new ReactiveScheduler({
    interpreter,
    runtime,
    now: runtime.now,
    onTick: ({ result, pendingAfter }) => {
      lastResultStatus = result.status;
      context.supervisorAgent?.recordSchedulerSnapshot({
        schedulerTick: scheduler.tickCount,
        backlog: pendingAfter,
        completed: result.status === "success" ? 1 : 0,
        failed: result.status === "failure" ? 1 : 0,
      });
    },
    getPheromoneIntensity: (nodeId) => context.stigmergy.getNodeIntensity(nodeId)?.intensity ?? 0,
    causalMemory,
  });

  const unsubscribeStigmergy = context.stigmergy.onChange((change) => {
    scheduler.emit("stigmergyChanged", {
      nodeId: change.nodeId,
      intensity: change.totalIntensity,
      type: change.type,
    });
  });

  const rootId =
    ("id" in input.tree.root && input.tree.root.id) ||
    ("node_id" in input.tree.root && (input.tree.root as { node_id?: string }).node_id) ||
    input.tree.id;

  const timeoutMs = input.timeout_ms ?? null;

  try {
    const runPromise = scheduler.runUntilSettled({
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
        scheduler.stop();
        await runPromise.catch(() => undefined);
        throw new BehaviorTreeRunTimeoutError(timeoutMs);
      }
      result = outcome.value;
    } else {
      result = await runPromise;
    }

    context.logger.info("plan_run_bt_completed", {
      tree_id: input.tree.id,
      status: result.status,
      invocations: invocations.length,
      ticks: scheduler.tickCount,
    });

    return {
      status: result.status,
      ticks: scheduler.tickCount,
      last_output: lastOutput,
      invocations,
    };
  } finally {
    unsubscribeStigmergy();
    scheduler.stop();
    context.logger.info("plan_run_bt_status", {
      tree_id: input.tree.id,
      status: lastResultStatus,
      ticks: scheduler.tickCount,
    });
  }
}
