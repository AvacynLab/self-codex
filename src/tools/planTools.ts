import { randomUUID } from "crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { ChildCollectedOutputs, ChildRuntimeMessage } from "../childRuntime.js";
import { ChildSupervisor } from "../childSupervisor.js";
import { GraphState } from "../graphState.js";
import { StructuredLogger } from "../logger.js";
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
}

/** Type of the prompt template payload accepted by the fan-out tool. */
export type PlanPromptTemplateInput = z.infer<typeof PromptTemplateSchema>;

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
  }>;
  prompt_template: PlanPromptTemplateInput;
}

/** Schema describing the supported join policies. */
const JoinPolicySchema = z.enum(["all", "first_success", "quorum"]);

/** Input payload accepted by the `plan_join` tool. */
export const PlanJoinInputSchema = z.object({
  children: z.array(z.string().min(1)).min(1),
  join_policy: JoinPolicySchema.default("all"),
  timeout_sec: z.number().int().positive().optional(),
  quorum_count: z.number().int().positive().optional(),
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
    }>;
    details?: Record<string, unknown>;
  };
}

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
  const plans = resolveChildrenPlans(input, context.defaultChildRuntime);

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
    })),
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
    })),
    prompt_template: input.prompt_template,
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
      const candidateThreshold = input.quorum_count ?? Math.ceil(input.children.length / 2);
      threshold = candidateThreshold;
      satisfied = successes.length >= candidateThreshold;
      break;
    }
    default:
      satisfied = false;
  }

  const winningChild = sorted.find((obs) => obs.status === "success")?.childId ?? null;

  context.emitEvent({
    kind: "STATUS",
    payload: {
      policy: input.join_policy,
      satisfied,
      successes: successes.length,
      failures: failures.length,
    },
  });

  context.logger.info("plan_join_completed", {
    policy: input.join_policy,
    satisfied,
    successes: successes.length,
    failures: failures.length,
    winning_child_id: winningChild,
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

  const summaries = outputs.map((output) => ({
    child_id: output.childId,
    summary: summariseChildOutputs(output),
    artifacts: output.artifacts,
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
      const tally = new Map<string, number>();
      for (const item of summaries) {
        if (!item.summary) continue;
        tally.set(item.summary, (tally.get(item.summary) ?? 0) + 1);
      }
      let winner: { value: string; count: number } | null = null;
      for (const [value, count] of tally.entries()) {
        if (!winner || count > winner.count) {
          winner = { value, count };
        }
      }
      result = {
        reducer: input.reducer,
        aggregate: winner,
        trace: {
          per_child: summaries,
          details: {
            tally: Object.fromEntries(tally.entries()),
          },
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

  context.logger.info("plan_reduce_completed", {
    reducer: input.reducer,
    aggregate_kind: typeof result.aggregate,
    child_count: summaries.length,
  });

  return result;
}
