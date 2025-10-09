import { z } from "zod";

import {
  ChildCollectedOutputs,
  ChildRuntimeMessage,
  ChildMessageStreamResult,
  ChildRuntimeStatus,
  ChildShutdownResult,
  ChildRuntimeLimits,
} from "../childRuntime.js";
import {
  ChildSupervisor,
  CreateChildOptions,
  SendResult,
} from "../childSupervisor.js";
import { ChildRecordSnapshot } from "../state/childrenIndex.js";
import { StructuredLogger } from "../logger.js";
import { SandboxExecutionResult, getSandboxRegistry } from "../sim/sandbox.js";
import { PromptTemplateSchema } from "../prompts.js";
import { LoopAlert, LoopDetector } from "../guard/loopDetector.js";
import { OrchestratorSupervisor } from "../agents/supervisor.js";
import { ContractNetAwardDecision, ContractNetCoordinator, RegisterAgentOptions } from "../coord/contractNet.js";
import { IdempotencyRegistry } from "../infra/idempotency.js";
import { BulkOperationError, buildBulkFailureDetail } from "./bulkError.js";
import { resolveOperationId } from "./operationIds.js";

/**
 * Dependencies required by the child tool handlers. The orchestrator injects
 * the shared {@link ChildSupervisor} instance as well as the structured logger
 * so the helpers can trace every action.
 */
export interface ChildToolContext {
  /** Shared runtime supervisor managing the child processes. */
  supervisor: ChildSupervisor;
  /** Structured logger leveraged to keep an audit trail for the tools. */
  logger: StructuredLogger;
  /** Optional guard responsible for detecting tight conversational loops. */
  loopDetector?: LoopDetector;
  /** Optional contract-net coordinator used to route tasks when enabled. */
  contractNet?: ContractNetCoordinator;
  /** Optional orchestrator supervisor notified when incidents occur. */
  supervisorAgent?: OrchestratorSupervisor;
  /** Optional registry replaying outcomes for idempotent requests. */
  idempotency?: IdempotencyRegistry;
}

/**
 * Determine the operation identifier attached to a child tool invocation.
 *
 * Child-facing tools historically omitted the `op_id`, which made correlating
 * cancellation requests or audit logs significantly harder. The helper accepts
 * an optional identifier provided by the caller and falls back to a stable
 * prefix paired with a UUID so every invocation receives a deterministic
 * correlation handle.
 */
/**
 * Schema describing the payload accepted by the `child_create` tool.
 *
 * Operators can optionally override the executable, provide extra arguments,
 * and attach metadata persisted alongside the runtime manifest. The initial
 * payload is sent to the child immediately after the ready handshake when
 * provided.
 */
/**
 * Schema describing prompt segments accepted when spawning a child. We reuse
 * the shared blueprint from {@link PromptTemplateSchema} to guarantee the
 * manifest mirrors the plan tools validation rules.
 */
const PromptSchema = PromptTemplateSchema;

/**
 * Schema describing timeout overrides granted to the child. Values are kept as
 * integers (milliseconds) to remain consistent with the supervisor settings.
 * The refinement avoids persisting empty objects that would provide no signal
 * in the runtime manifest.
 */
const TimeoutsSchema = z
  .object({
    ready_ms: z.number().int().positive().optional(),
    idle_ms: z.number().int().positive().optional(),
    heartbeat_ms: z.number().int().positive().optional(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "timeouts must define at least one field",
  });

/**
 * Schema for budget hints exposed to downstream coordination logic. The
 * numbers remain optional so operators can selectively bound cost dimensions
 * without providing an exhaustive object.
 */
const BudgetSchema = z
  .object({
    messages: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    wallclock_ms: z.number().int().positive().optional(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "budget must define at least one field",
  });

export const ChildCreateInputSchema = z.object({
  op_id: z
    .string()
    .trim()
    .min(1, "op_id must be a non-empty string")
    .optional(),
  child_id: z
    .string()
    .min(1, "child_id must be a non-empty string")
    .optional(),
  command: z
    .string()
    .min(1, "command must be a non-empty string")
    .optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  prompt: PromptSchema.optional(),
  tools_allow: z.array(z.string().min(1)).optional(),
  timeouts: TimeoutsSchema.optional(),
  budget: BudgetSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  manifest_extras: z.record(z.unknown()).optional(),
  wait_for_ready: z.boolean().optional(),
  ready_type: z.string().min(1).optional(),
  ready_timeout_ms: z.number().int().positive().optional(),
  initial_payload: z.unknown().optional(),
  idempotency_key: z.string().min(1).optional(),
});
export const ChildCreateInputShape = ChildCreateInputSchema.shape;

const ChildRuntimeLimitsValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const ChildSpawnCodexInputSchema = z.object({
  op_id: z
    .string()
    .trim()
    .min(1, "op_id must be a non-empty string")
    .optional(),
  role: z
    .string()
    .min(1, "role must be a non-empty string")
    .max(120, "role must be reasonably small")
    .optional(),
  prompt: PromptSchema,
  model_hint: z.string().min(1).optional(),
  limits: z
    .record(ChildRuntimeLimitsValueSchema)
    .optional()
    .refine((value) => value === undefined || Object.keys(value).length > 0, {
      message: "limits must define at least one entry when provided",
    }),
  metadata: z.record(z.unknown()).optional(),
  manifest_extras: z.record(z.unknown()).optional(),
  idempotency_key: z.string().min(1).optional(),
});
export const ChildSpawnCodexInputShape = ChildSpawnCodexInputSchema.shape;

const ChildBatchCreateEntrySchema = ChildSpawnCodexInputSchema.strict();
type ChildBatchCreateEntry = z.infer<typeof ChildSpawnCodexInputSchema>;

function summariseChildBatchEntry(entry: ChildBatchCreateEntry): Record<string, unknown> {
  const prompt = (entry as { prompt?: Record<string, unknown> }).prompt;
  const promptKeys = prompt && typeof prompt === "object" ? Object.keys(prompt) : [];
  return {
    role: typeof entry.role === "string" ? entry.role : null,
    idempotency_key: typeof entry.idempotency_key === "string" ? entry.idempotency_key : null,
    prompt_keys: promptKeys,
  };
}

export const ChildBatchCreateInputSchema = z
  .object({
    entries: z
      .array(ChildBatchCreateEntrySchema)
      .min(1, "at least one entry must be provided")
      .max(16, "cannot create more than 16 children at once"),
  })
  .strict();
export const ChildBatchCreateInputShape = ChildBatchCreateInputSchema.shape;

export const ChildAttachInputSchema = z.object({
  child_id: z.string().min(1, "child_id must be provided"),
  manifest_extras: z.record(z.unknown()).optional(),
});
export const ChildAttachInputShape = ChildAttachInputSchema.shape;

export const ChildSetRoleInputSchema = z.object({
  child_id: z.string().min(1, "child_id must be provided"),
  role: z.string().min(1, "role must be a non-empty string"),
  manifest_extras: z.record(z.unknown()).optional(),
});
export const ChildSetRoleInputShape = ChildSetRoleInputSchema.shape;

export const ChildSetLimitsInputSchema = z.object({
  child_id: z.string().min(1, "child_id must be provided"),
  limits: z
    .record(ChildRuntimeLimitsValueSchema)
    .optional()
    .refine((value) => value === undefined || Object.keys(value).length > 0, {
      message: "limits must define at least one entry when provided",
    }),
  manifest_extras: z.record(z.unknown()).optional(),
});
export const ChildSetLimitsInputShape = ChildSetLimitsInputSchema.shape;

/** Shape returned by {@link handleChildCreate}. */
export interface ChildCreateResult extends Record<string, unknown> {
  /** Operation identifier correlating logs, events, and cancellation handles. */
  op_id: string;
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  manifest_path: string;
  log_path: string;
  workdir: string;
  started_at: number;
  ready_message: unknown | null;
  sent_initial_payload: boolean;
  idempotent: boolean;
  idempotency_key: string | null;
}

type ChildCreateSnapshot = Omit<ChildCreateResult, "idempotent" | "idempotency_key">;

export interface ChildSpawnCodexResult extends Record<string, unknown> {
  /** Operation identifier correlating logs, events, and cancellation handles. */
  op_id: string;
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  manifest_path: string;
  log_path: string;
  workdir: string;
  started_at: number;
  ready_message: unknown | null;
  role: string | null;
  limits: ChildRuntimeLimits | null;
  endpoint: { url: string; headers: Record<string, string> } | null;
  idempotency_key: string | null;
  idempotent: boolean;
}

type ChildSpawnCodexSnapshot = Omit<ChildSpawnCodexResult, "idempotent">;

export interface ChildBatchCreateResult extends Record<string, unknown> {
  children: ChildSpawnCodexResult[];
  created: number;
  idempotent_entries: number;
}

export interface ChildAttachResult extends Record<string, unknown> {
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  attached_at: number | null;
}

export interface ChildSetRoleResult extends Record<string, unknown> {
  child_id: string;
  role: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
}

export interface ChildSetLimitsResult extends Record<string, unknown> {
  child_id: string;
  limits: ChildRuntimeLimits | null;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
}

/**
 * Launches a new child runtime and optionally forwards an initial payload.
 */
export async function handleChildCreate(
  context: ChildToolContext,
  input: z.infer<typeof ChildCreateInputSchema>,
): Promise<ChildCreateResult> {
  const opId = resolveOperationId(input.op_id, "child_create_op");
  const execute = async (): Promise<ChildCreateSnapshot> => {
    const options: CreateChildOptions = {
      childId: input.child_id,
      command: input.command,
      args: input.args,
      env: input.env,
      metadata: input.metadata,
      manifestExtras: buildManifestExtras(input),
      toolsAllow: input.tools_allow ?? null,
      waitForReady: input.wait_for_ready,
      readyType: input.ready_type,
      readyTimeoutMs: input.ready_timeout_ms,
    };

    context.logger.info("child_create_requested", {
      op_id: opId,
      child_id: options.childId ?? null,
      command: options.command ?? null,
      args: options.args?.length ?? 0,
      idempotency_key: input.idempotency_key ?? null,
    });

    const created = await context.supervisor.createChild(options);
    const runtimeStatus = created.runtime.getStatus();
    const readyMessage = created.readyMessage ? created.readyMessage.parsed ?? created.readyMessage.raw : null;

    let sentInitialPayload = false;
    if (input.initial_payload !== undefined) {
      await context.supervisor.send(created.childId, input.initial_payload);
      sentInitialPayload = true;
    }

    context.logger.info("child_create_succeeded", {
      op_id: opId,
      child_id: created.childId,
      pid: runtimeStatus.pid,
      workdir: runtimeStatus.workdir,
      idempotency_key: input.idempotency_key ?? null,
    });

    if (context.contractNet) {
      const profile = deriveContractNetProfile(input);
      const snapshot = context.contractNet.registerAgent(created.childId, profile);
      context.logger.info("contract_net_agent_registered", {
        op_id: opId,
        agent_id: snapshot.agentId,
        base_cost: snapshot.baseCost,
        reliability: snapshot.reliability,
        tags: snapshot.tags,
      });
    }

    return {
      op_id: opId,
      child_id: created.childId,
      runtime_status: runtimeStatus,
      index_snapshot: created.index,
      manifest_path: created.runtime.manifestPath,
      log_path: created.runtime.logPath,
      workdir: runtimeStatus.workdir,
      started_at: runtimeStatus.startedAt,
      ready_message: readyMessage,
      sent_initial_payload: sentInitialPayload,
    };
  };

  const key = input.idempotency_key ?? null;
  if (context.idempotency && key) {
    const hit = await context.idempotency.remember<ChildCreateSnapshot>(`child_create:${key}`, execute);
    if (hit.idempotent) {
      const snapshot = hit.value as ChildCreateSnapshot;
      context.logger.info("child_create_replayed", {
        idempotency_key: key,
        child_id: snapshot.child_id,
        op_id: snapshot.op_id,
      });
    }
    const snapshot = hit.value as ChildCreateSnapshot;
    return {
      ...snapshot,
      op_id: snapshot.op_id ?? opId,
      idempotent: hit.idempotent,
      idempotency_key: key,
    } as ChildCreateResult;
  }

  const result = await execute();
  return { ...result, op_id: opId, idempotent: false, idempotency_key: key } as ChildCreateResult;
}

/** Spawns a Codex child with a structured prompt and optional limits. */
export async function handleChildSpawnCodex(
  context: ChildToolContext,
  input: z.infer<typeof ChildSpawnCodexInputSchema>,
): Promise<ChildSpawnCodexResult> {
  const opId = resolveOperationId(input.op_id, "child_spawn_op");
  const execute = async (): Promise<ChildSpawnCodexSnapshot> => {
    const manifestExtras = buildSpawnCodexManifestExtras(input);
    const metadata: Record<string, unknown> = structuredClone(input.metadata ?? {});
    const limitsCopy: ChildRuntimeLimits | null = input.limits ? structuredClone(input.limits) : null;
    const role = input.role ?? null;
    const idempotencyKey = input.idempotency_key ?? null;

    metadata.op_id = opId;
    if (role) {
      metadata.role = role;
    }
    if (input.model_hint) {
      metadata.model_hint = input.model_hint;
    }
    if (idempotencyKey) {
      metadata.idempotency_key = idempotencyKey;
    }
    if (limitsCopy) {
      metadata.limits = structuredClone(limitsCopy);
    }

    context.logger.info("child_spawn_codex_requested", {
      op_id: opId,
      role,
      limit_keys: limitsCopy ? Object.keys(limitsCopy).length : 0,
      idempotency_key: idempotencyKey,
    });

    if (isHttpLoopbackEnabled()) {
      const childId = context.supervisor.createChildId();
      const endpoint = buildHttpChildEndpoint(childId, limitsCopy);
      const registration = await context.supervisor.registerHttpChild({
        childId,
        endpoint,
        metadata,
        limits: limitsCopy,
        role,
        manifestExtras,
      });
      const statusSnapshot = context.supervisor.status(childId);

      context.logger.info("child_spawn_codex_ready", {
        op_id: opId,
        child_id: childId,
        pid: null,
        workdir: registration.workdir,
        endpoint_url: endpoint.url,
        idempotency_key: idempotencyKey,
      });

      return {
        op_id: opId,
        child_id: childId,
        runtime_status: statusSnapshot.runtime,
        index_snapshot: statusSnapshot.index,
        manifest_path: registration.manifestPath,
        log_path: registration.logPath,
        workdir: registration.workdir,
        started_at: registration.startedAt,
        ready_message: null,
        role: statusSnapshot.index.role,
        limits: statusSnapshot.index.limits,
        endpoint,
        idempotency_key: idempotencyKey,
      } satisfies ChildSpawnCodexSnapshot;
    }

    const created = await context.supervisor.createChild({
      role,
      manifestExtras,
      metadata,
      limits: limitsCopy,
      waitForReady: true,
      readyTimeoutMs: 2000,
    });

    const runtimeStatus = created.runtime.getStatus();
    const readyMessage = created.readyMessage ? created.readyMessage.parsed ?? created.readyMessage.raw : null;

    context.logger.info("child_spawn_codex_ready", {
      op_id: opId,
      child_id: created.childId,
      pid: runtimeStatus.pid,
      workdir: runtimeStatus.workdir,
      idempotency_key: idempotencyKey,
    });

    return {
      op_id: opId,
      child_id: created.childId,
      runtime_status: runtimeStatus,
      index_snapshot: created.index,
      manifest_path: created.runtime.manifestPath,
      log_path: created.runtime.logPath,
      workdir: runtimeStatus.workdir,
      started_at: runtimeStatus.startedAt,
      ready_message: readyMessage,
      role: created.index.role,
      limits: created.index.limits,
      endpoint: null,
      idempotency_key: idempotencyKey,
    };
  };

  const key = input.idempotency_key ?? null;
  if (context.idempotency && key) {
    const hit = await context.idempotency.remember<ChildSpawnCodexSnapshot>(`child_spawn_codex:${key}`, execute);
    if (hit.idempotent) {
      const snapshot = hit.value as ChildSpawnCodexSnapshot;
      context.logger.info("child_spawn_codex_replayed", {
        idempotency_key: key,
        child_id: snapshot.child_id,
        op_id: snapshot.op_id,
      });
    }
    const snapshot = hit.value as ChildSpawnCodexSnapshot;
    return {
      ...snapshot,
      op_id: snapshot.op_id ?? opId,
      endpoint: snapshot.endpoint ?? null,
      idempotent: hit.idempotent,
    } as ChildSpawnCodexResult;
  }

  const result = await execute();
  return { ...result, op_id: opId, idempotent: false } as ChildSpawnCodexResult;
}

/**
 * Spawns multiple Codex children in a single atomic batch. When any entry fails
 * the helper tears down previously created runtimes to keep orchestrator state
 * consistent.
 */
export async function handleChildBatchCreate(
  context: ChildToolContext,
  input: z.infer<typeof ChildBatchCreateInputSchema>,
): Promise<ChildBatchCreateResult> {
  context.logger.info("child_batch_create_requested", { entries: input.entries.length });

  const results: ChildSpawnCodexResult[] = [];
  const createdChildIds: string[] = [];
  let failingIndex: number | null = null;
  let failingSummary: Record<string, unknown> | null = null;

  try {
    for (let index = 0; index < input.entries.length; index += 1) {
      const entry: ChildBatchCreateEntry = input.entries[index]!;
      try {
        const snapshot = await handleChildSpawnCodex(context, entry);
        results.push(snapshot);
        if (!snapshot.idempotent) {
          createdChildIds.push(snapshot.child_id);
        }
      } catch (error) {
        failingIndex = index;
        failingSummary = summariseChildBatchEntry(entry);
        throw error;
      }
    }
  } catch (error) {
    for (const childId of createdChildIds.reverse()) {
      try {
        context.logger.warn("child_batch_create_rollback", { child_id: childId });
        await context.supervisor.kill(childId, { timeoutMs: 200 });
        await context.supervisor.waitForExit(childId, 1_000);
      } catch (shutdownError) {
        context.logger.error("child_batch_create_rollback_failed", {
          child_id: childId,
          reason:
            shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
        });
      } finally {
        try {
          context.supervisor.gc(childId);
        } catch {
          // The child might have already been reclaimed by the supervisor.
        }
        clearLoopSignature(childId);
      }
    }
    const entrySummary = failingSummary;
    throw new BulkOperationError("child batch aborted", {
      failures: [
        buildBulkFailureDetail({
          index: failingIndex ?? 0,
          entry: entrySummary,
          error,
          stage: "spawn",
        }),
      ],
      rolled_back: true,
      metadata: {
        rollback_child_ids: [...createdChildIds].reverse(),
      },
    });
  }

  const idempotentCount = results.filter((entry) => entry.idempotent).length;
  context.logger.info("child_batch_create_succeeded", {
    entries: input.entries.length,
    created: results.length - idempotentCount,
    replayed: idempotentCount,
  });

  return {
    children: results,
    created: results.length - idempotentCount,
    idempotent_entries: idempotentCount,
  };
}

/** Refreshes manifest metadata for an existing child runtime. */
export async function handleChildAttach(
  context: ChildToolContext,
  input: z.infer<typeof ChildAttachInputSchema>,
): Promise<ChildAttachResult> {
  context.logger.info("child_attach_requested", { child_id: input.child_id });
  const result = await context.supervisor.attachChild(input.child_id, {
    manifestExtras: input.manifest_extras ?? {},
  });
  context.logger.info("child_attach_succeeded", {
    child_id: input.child_id,
    attached_at: result.index.attachedAt,
  });
  return {
    child_id: input.child_id,
    runtime_status: result.runtime,
    index_snapshot: result.index,
    attached_at: result.index.attachedAt,
  };
}

/** Adjusts the advertised role for a running child runtime. */
export async function handleChildSetRole(
  context: ChildToolContext,
  input: z.infer<typeof ChildSetRoleInputSchema>,
): Promise<ChildSetRoleResult> {
  context.logger.info("child_set_role_requested", {
    child_id: input.child_id,
    role: input.role,
  });
  const result = await context.supervisor.setChildRole(input.child_id, input.role, {
    manifestExtras: input.manifest_extras ?? {},
  });
  context.logger.info("child_set_role_succeeded", {
    child_id: input.child_id,
    role: result.index.role,
  });
  return {
    child_id: input.child_id,
    role: result.index.role ?? input.role,
    runtime_status: result.runtime,
    index_snapshot: result.index,
  };
}

/** Applies new declarative limits to a running child runtime. */
export async function handleChildSetLimits(
  context: ChildToolContext,
  input: z.infer<typeof ChildSetLimitsInputSchema>,
): Promise<ChildSetLimitsResult> {
  const requested = input.limits ?? null;
  context.logger.info("child_set_limits_requested", {
    child_id: input.child_id,
    limit_keys: requested ? Object.keys(requested).length : 0,
  });
  const result = await context.supervisor.setChildLimits(input.child_id, requested, {
    manifestExtras: input.manifest_extras ?? {},
  });
  context.logger.info("child_set_limits_succeeded", {
    child_id: input.child_id,
    limit_keys: result.limits ? Object.keys(result.limits).length : 0,
  });
  return {
    child_id: input.child_id,
    limits: result.limits,
    runtime_status: result.runtime,
    index_snapshot: result.index,
  };
}

/** Derives a contract-net profile from the child creation payload. */
function deriveContractNetProfile(input: z.infer<typeof ChildCreateInputSchema>): RegisterAgentOptions {
  const baseCost = deriveContractNetBaseCost(input);
  const reliability = deriveContractNetReliability(input.metadata);
  const tags = deriveContractNetTags(input);
  const metadata: Record<string, unknown> = {};
  if (input.metadata) {
    metadata.metadata = structuredClone(input.metadata);
  }
  if (input.budget) {
    metadata.budget = structuredClone(input.budget);
  }
  if (input.timeouts) {
    metadata.timeouts = structuredClone(input.timeouts);
  }
  if (input.tools_allow) {
    metadata.tools_allow = [...input.tools_allow];
  }

  const profile: RegisterAgentOptions = {
    baseCost,
    tags,
    metadata,
  };
  if (reliability !== undefined) {
    profile.reliability = reliability;
  }
  return profile;
}

function deriveContractNetBaseCost(input: z.infer<typeof ChildCreateInputSchema>): number {
  const budget = input.budget ?? {};
  if (typeof budget.wallclock_ms === "number" && Number.isFinite(budget.wallclock_ms)) {
    return Math.max(1, Math.round(budget.wallclock_ms / 100));
  }
  if (typeof budget.tokens === "number" && Number.isFinite(budget.tokens)) {
    return Math.max(1, Math.round(budget.tokens / 50));
  }
  if (typeof budget.messages === "number" && Number.isFinite(budget.messages)) {
    return Math.max(1, budget.messages * 25);
  }
  return 100;
}

function deriveContractNetReliability(metadata: unknown): number | undefined {
  const record = toRecord(metadata);
  if (!record) {
    return undefined;
  }
  const contractNet = toRecord(record.contract_net);
  if (!contractNet) {
    return undefined;
  }
  const value = contractNet.reliability;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deriveContractNetTags(input: z.infer<typeof ChildCreateInputSchema>): string[] {
  const tags = new Set<string>();
  for (const tool of input.tools_allow ?? []) {
    tags.add(`tool:${tool}`);
  }
  const metadata = toRecord(input.metadata);
  if (metadata) {
    for (const tag of extractStringArray(metadata.tags)) {
      tags.add(tag);
    }
  }
  return Array.from(tags);
}

/**
 * Builds the set of additional manifest fields persisted alongside the runtime
 * metadata. The helper keeps the construction logic isolated so new fields can
 * be introduced without cluttering {@link handleChildCreate}.
 */
function buildManifestExtras(
  input: z.infer<typeof ChildCreateInputSchema>,
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {
    ...(input.manifest_extras ?? {}),
  };

  if (input.prompt) {
    extras.prompt = input.prompt;
  }
  if (input.timeouts) {
    extras.timeouts = input.timeouts;
  }
  if (input.budget) {
    extras.budget = input.budget;
  }

  return Object.keys(extras).length > 0 ? extras : undefined;
}

function buildSpawnCodexManifestExtras(
  input: z.infer<typeof ChildSpawnCodexInputSchema>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    prompt: structuredClone(input.prompt),
  };

  if (input.manifest_extras) {
    Object.assign(extras, structuredClone(input.manifest_extras));
  }

  if (input.model_hint) {
    extras.model_hint = input.model_hint;
  }

  if (input.idempotency_key) {
    extras.idempotency_key = input.idempotency_key;
  }

  if (input.role) {
    extras.role = input.role;
  }

  return extras;
}

/** Detects whether the stateless HTTP bridge should back child orchestration. */
function isHttpLoopbackEnabled(): boolean {
  const raw = process.env.MCP_HTTP_STATELESS;
  return typeof raw === "string" && raw.trim().toLowerCase() === "yes";
}

/** Normalises the MCP HTTP endpoint so logical children can call the server again. */
function buildHttpChildEndpoint(
  childId: string,
  limits: ChildRuntimeLimits | null,
): { url: string; headers: Record<string, string> } {
  const host = (process.env.MCP_HTTP_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const rawPort = process.env.MCP_HTTP_PORT ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8765;
  let path = process.env.MCP_HTTP_PATH ?? "/mcp";
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  const url = `http://${host}:${port}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-child-id": childId,
  };

  const token = process.env.MCP_HTTP_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (limits && Object.keys(limits).length > 0) {
    headers["x-child-limits"] = Buffer.from(JSON.stringify(limits), "utf8").toString("base64");
  }

  return { url, headers };
}

/** Schema for the `child_send` tool. */
const ChildSendExpectationSchema = z.enum(["stream", "final"]);

const ChildSendSandboxSchema = z
  .object({
    enabled: z.boolean().optional(),
    action: z.string().min(1).default("dry-run"),
    payload: z.unknown().optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .optional()
      .refine((value) => value === undefined || Number.isFinite(value), {
        message: "sandbox.timeout_ms must be finite",
      }),
    allow_failure: z.boolean().optional(),
    require_handler: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const ChildSendContractNetSchema = z
  .object({
    call_id: z.string().min(1),
    requested_agent_id: z.string().min(1).optional(),
    auto_complete: z.boolean().optional(),
  })
  .strict();

const ChildSendInputBaseSchema = z.object({
  child_id: z.string().min(1),
  payload: z.unknown(),
  expect: ChildSendExpectationSchema.optional(),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .refine((value) => value === undefined || Number.isFinite(value), {
      message: "timeout_ms must be finite",
    }),
  sandbox: ChildSendSandboxSchema.optional(),
  contract_net: ChildSendContractNetSchema.optional(),
});

export const ChildSendInputSchema = ChildSendInputBaseSchema.refine(
  (input) => (input.timeout_ms === undefined ? true : input.expect !== undefined),
  {
    message: "timeout_ms requires expect to be provided",
    path: ["timeout_ms"],
  },
);
export const ChildSendInputShape = ChildSendInputBaseSchema.shape;

/**
 * Tracks the most recent loop signature associated with each child. We reuse the
 * cached value when the next response is observed so the alternating exchange
 * is recorded against the same identifier on both sides.
 */
const pendingLoopSignatures = new Map<string, string>();

/** Maximum number of characters preserved when logging payload excerpts. */
const MAX_LOG_EXCERPT_LENGTH = 1_024;

/**
 * Serialises an arbitrary payload for cognitive logging. The helper clamps the
 * resulting string to avoid gigantic entries while remaining deterministic so
 * tests can assert the captured excerpts.
 */
function serialiseForLog(value: unknown): string {
  try {
    const serialised = JSON.stringify(value);
    if (!serialised) {
      return "";
    }
    if (serialised.length <= MAX_LOG_EXCERPT_LENGTH) {
      return serialised;
    }
    return `${serialised.slice(0, MAX_LOG_EXCERPT_LENGTH)}…`;
  } catch (error) {
    return `[unserialisable:${error instanceof Error ? error.message : String(error)}]`;
  }
}

/**
 * Extracts a concise representation of a child message, preferring parsed JSON
 * payloads when available. Raw lines are truncated to avoid polluting the log
 * history with very large excerpts.
 */
function childMessageExcerpt(message: ChildRuntimeMessage | null): string | null {
  if (!message) {
    return null;
  }
  if (message.parsed !== null && message.parsed !== undefined) {
    return serialiseForLog(message.parsed);
  }
  return message.raw.length <= MAX_LOG_EXCERPT_LENGTH
    ? message.raw
    : `${message.raw.slice(0, MAX_LOG_EXCERPT_LENGTH)}…`;
}

/** Converts an arbitrary error value into a readable string. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface ContractNetDispatchSummary extends Record<string, unknown> {
  call_id: string;
  agent_id: string;
  cost: number;
  effective_cost: number;
}

/** Converts an award decision into a serialisable summary. */
function buildContractNetSummary(decision: ContractNetAwardDecision): ContractNetDispatchSummary {
  return {
    call_id: decision.callId,
    agent_id: decision.agentId,
    cost: decision.cost,
    effective_cost: Number(decision.effectiveCost.toFixed(6)),
  };
}

/** Shape returned by {@link handleChildSend}. */
export interface ChildSendResult extends Record<string, unknown> {
  child_id: string;
  message: SendResult;
  awaited_message: ChildRuntimeMessage | null;
  sandbox_result: SandboxExecutionResult | null;
  loop_alert: LoopAlert | null;
  contract_net: ContractNetDispatchSummary | null;
}

/**
 * Sends an arbitrary JSON payload to a child process.
 */
export async function handleChildSend(
  context: ChildToolContext,
  input: z.infer<typeof ChildSendInputSchema>,
): Promise<ChildSendResult> {
  const contractNetConfig = input.contract_net ?? null;
  let contractNetDecision: ContractNetAwardDecision | null = null;
  let resolvedChildId = input.child_id;

  if (contractNetConfig) {
    if (!context.contractNet) {
      throw new Error("Contract-Net coordinator is not enabled");
    }
    const requested =
      contractNetConfig.requested_agent_id ?? (input.child_id !== "auto" ? input.child_id : undefined);
    const normalisedRequest = requested === "auto" ? undefined : requested;
    contractNetDecision = context.contractNet.award(contractNetConfig.call_id, normalisedRequest);
    resolvedChildId = contractNetDecision.agentId;
  }

  const childId = resolvedChildId;

  context.logger.info("child_send", {
    child_id: childId,
    contract_net_call: contractNetConfig?.call_id ?? null,
  });

  context.logger.logCognitive({
    actor: "orchestrator",
    phase: "prompt",
    childId,
    content: serialiseForLog(input.payload),
    metadata: {
      expect: input.expect ?? null,
      sandbox: input.sandbox ?? null,
      contract_net_call: contractNetConfig?.call_id ?? null,
    },
  });

  const childSnapshot = context.supervisor.childrenIndex.getChild(childId);
  const metadataRecord = toRecord(childSnapshot?.metadata);
  const highRisk = isHighRiskTask(metadataRecord);
  const sandboxConfig = input.sandbox;
  const sandboxEnabled = highRisk ? sandboxConfig?.enabled !== false : sandboxConfig?.enabled === true;
  let sandboxResult: SandboxExecutionResult | null = null;
  const loopDetector = context.loopDetector ?? null;
  const loopTaskId = extractTaskIdentifier(metadataRecord);
  const loopTaskType = extractTaskType(metadataRecord);
  let loopAlert: LoopAlert | null = null;
  const allowedTools = context.supervisor.getAllowedTools(childId);
  const requestedTool = extractRequestedTool(input.payload);
  if (requestedTool && allowedTools.length > 0 && !allowedTools.includes(requestedTool)) {
    throw new Error(
      `Tool "${requestedTool}" is not allowed for child ${childId}. Allowed tools: ${allowedTools.join(", ")}`,
    );
  }

  if (sandboxEnabled) {
    const registry = getSandboxRegistry();
    const actionName = (sandboxConfig?.action ?? "dry-run").trim() || "dry-run";
    const requestPayload = sandboxConfig?.payload ?? input.payload;
    const baseMetadata = toRecord(sandboxConfig?.metadata) ?? {};
    const sandboxMetadata: Record<string, unknown> = {
      ...baseMetadata,
      child_id: childId,
      high_risk: highRisk,
    };
    if (!registry.has(actionName)) {
      if (sandboxConfig?.require_handler) {
        throw new Error(`Sandbox handler "${actionName}" is not registered`);
      }
      const now = Date.now();
      sandboxResult = {
        action: actionName,
        status: "skipped",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        reason: "handler_missing",
        metadata: sandboxMetadata,
      };
      context.logger.warn("child_send_sandbox_missing_handler", {
        child_id: childId,
        action: actionName,
      });
    } else {
      const timeoutOverride = sandboxConfig?.timeout_ms;
      sandboxResult = await registry.execute({
        action: actionName,
        payload: requestPayload,
        metadata: sandboxMetadata,
        timeoutMs: timeoutOverride,
      });
      context.logger.info("child_send_sandbox", {
        child_id: childId,
        action: actionName,
        status: sandboxResult.status,
        duration_ms: sandboxResult.durationMs,
      });
      if (sandboxResult.status !== "ok" && sandboxConfig?.allow_failure !== true) {
        const reason = sandboxResult.reason ?? sandboxResult.error?.message ?? sandboxResult.status;
        throw new Error(`Sandbox action "${actionName}" failed before child_send: ${reason}`);
      }
    }
  }

  let baselineSequence = 0;
  if (input.expect) {
    const snapshot = context.supervisor.stream(childId, { limit: 1 });
    baselineSequence = snapshot.totalMessages;
  }

  const message = await context.supervisor.send(childId, input.payload);

  const loopSignature = loopDetector
    ? rememberLoopSignature(childId, metadataRecord, input.payload)
    : null;

  if (loopDetector && loopSignature) {
    loopAlert = mergeLoopAlerts(
      loopAlert,
      loopDetector.recordInteraction({
        from: "orchestrator",
        to: `child:${childId}`,
        signature: loopSignature,
        childId,
        taskId: loopTaskId ?? undefined,
        taskType: loopTaskType,
      }),
      context,
    );
    if (loopAlert && context.supervisorAgent) {
      await context.supervisorAgent.recordLoopAlert(loopAlert);
    }
  }

  if (!input.expect) {
    if (contractNetDecision && (contractNetConfig?.auto_complete ?? true)) {
      context.contractNet?.complete(contractNetDecision.callId);
    }
    const contractNetSummary = contractNetDecision
      ? buildContractNetSummary(contractNetDecision)
      : null;
    return {
      child_id: childId,
      message,
      awaited_message: null,
      sandbox_result: sandboxResult,
      loop_alert: loopAlert,
      contract_net: contractNetSummary,
    };
  }

  const timeoutMs = input.timeout_ms ?? (input.expect === "final" ? 8_000 : 2_000);
  const matcher = input.expect === "final" ? matchesFinalMessage : matchesStreamMessage;

  try {
    const awaited = await context.supervisor.waitForMessage(
      childId,
      (msg) => msg.sequence >= baselineSequence && matcher(msg),
      timeoutMs,
    );
    if (loopDetector && loopSignature) {
      loopAlert = mergeLoopAlerts(
        loopAlert,
        loopDetector.recordInteraction({
          from: `child:${childId}`,
          to: "orchestrator",
          signature: loopSignature,
          childId,
          taskId: loopTaskId ?? undefined,
          taskType: loopTaskType,
        }),
        context,
      );
      if (loopAlert && context.supervisorAgent) {
        await context.supervisorAgent.recordLoopAlert(loopAlert);
      }
      const duration = Math.max(1, awaited.receivedAt - message.sentAt);
      loopDetector.recordTaskObservation({
        taskType: loopTaskType,
        durationMs: duration,
        success: true,
      });
    }
    context.logger.logCognitive({
      actor: `child:${childId}`,
      phase: "resume",
      childId,
      content: childMessageExcerpt(awaited),
      metadata: {
        stream: awaited.stream,
        sequence: awaited.sequence,
      },
    });
    if (contractNetDecision && (contractNetConfig?.auto_complete ?? true)) {
      context.contractNet?.complete(contractNetDecision.callId);
    }
    const contractNetSummary = contractNetDecision
      ? buildContractNetSummary(contractNetDecision)
      : null;
    return {
      child_id: childId,
      message,
      awaited_message: cloneChildMessage(awaited),
      sandbox_result: sandboxResult,
      loop_alert: loopAlert,
      contract_net: contractNetSummary,
    };
  } catch (error) {
    if (loopDetector && loopSignature) {
      loopDetector.recordTaskObservation({
        taskType: loopTaskType,
        durationMs: Math.max(1, Date.now() - message.sentAt),
        success: false,
      });
    }
    const reason = errorMessage(error);
    context.logger.logCognitive({
      actor: `child:${childId}`,
      phase: "resume",
      childId,
      content: reason,
      metadata: {
        status: "error",
        expect: input.expect ?? null,
      },
    });
    throw new Error(
      `child_send awaited a ${input.expect} message but failed after ${timeoutMs}ms: ${reason}`,
    );
  }
}

/** Determine if a runtime message satisfies the "stream" expectation. */
function matchesStreamMessage(message: ChildRuntimeMessage): boolean {
  if (message.stream !== "stdout") {
    return false;
  }
  const type = extractMessageType(message);
  if (!type) {
    return true;
  }
  if (type === "ready" || FINAL_MESSAGE_TYPES.has(type)) {
    return false;
  }
  return true;
}

/** Determine if a runtime message satisfies the "final" expectation. */
function matchesFinalMessage(message: ChildRuntimeMessage): boolean {
  if (message.stream !== "stdout") {
    return false;
  }
  const type = extractMessageType(message);
  if (!type) {
    return false;
  }
  return FINAL_MESSAGE_TYPES.has(type) || type === "error";
}

/** Extract the `type` field from a structured child message when present. */
function extractMessageType(message: ChildRuntimeMessage): string | null {
  if (!message.parsed || typeof message.parsed !== "object") {
    return null;
  }
  const candidate = (message.parsed as { type?: unknown }).type;
  return typeof candidate === "string" ? candidate : null;
}

/** Clone a child runtime message to avoid exposing internal buffers. */
function cloneChildMessage(message: ChildRuntimeMessage): ChildRuntimeMessage {
  const parsedClone =
    message.parsed === null ? null : JSON.parse(JSON.stringify(message.parsed));
  return { ...message, parsed: parsedClone };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Extracts an array of strings ignoring falsy or non-string entries. */
function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const normalised = entry.trim();
      if (normalised.length > 0) {
        result.push(normalised);
      }
    }
  }
  return result;
}

/**
 * Extracts a stable signature representing the current task identifier so loop
 * alerts can mention the relevant job or instruction when available.
 */
function extractTaskIdentifier(metadata?: Record<string, unknown>): string | null {
  if (!metadata) {
    return null;
  }
  const candidates = [metadata.task_id, metadata.taskId, metadata.job_id, metadata.jobId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Resolves the logical task category leveraged by the loop detector telemetry.
 */
function extractTaskType(metadata?: Record<string, unknown>): string {
  if (metadata) {
    const candidates = [metadata.task_type, metadata.taskType, metadata.role, metadata.mode];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "child_send";
}

/**
 * Normalises a payload so the loop detector can match alternating exchanges
 * regardless of direction. Strings are truncated and JSON payloads are reduced
 * to their `type`/`name` fields to avoid leaking sensitive data in alerts.
 */
function summariseLoopPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "null";
  }
  if (typeof payload === "string") {
    return payload.slice(0, 48);
  }
  if (typeof payload === "number" || typeof payload === "boolean") {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    return `array:${payload.length}`;
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const typeLike = record.type ?? record.name ?? record.action ?? record.kind;
    if (typeof typeLike === "string" && typeLike.trim()) {
      return typeLike.trim().slice(0, 48);
    }
    return `object:${Object.keys(record)
      .sort()
      .slice(0, 3)
      .join(",")}`;
  }
  return "unknown";
}

/**
 * Computes and caches the signature associated with the latest outbound
 * payload. The helper intentionally keeps the signature compact while
 * leveraging metadata hints to reduce false positives (different jobs sharing
 * a child will not collide).
 */
function rememberLoopSignature(
  childId: string,
  metadata: Record<string, unknown> | undefined,
  payload: unknown,
): string {
  const taskId = extractTaskIdentifier(metadata) ?? "default";
  const taskType = extractTaskType(metadata);
  const payloadSummary = summariseLoopPayload(payload);
  const signature = `child:${childId}|task:${taskType}|id:${taskId}|payload:${payloadSummary}`;
  pendingLoopSignatures.set(childId, signature);
  return signature;
}

/**
 * Merges two loop alerts and logs the most severe one. The return value is the
 * alert that should be surfaced to callers.
 */
function mergeLoopAlerts(
  existing: LoopAlert | null,
  candidate: LoopAlert | null,
  context: ChildToolContext,
): LoopAlert | null {
  const alert = chooseMostSevereAlert(existing, candidate);
  if (alert && (!existing || alert !== existing)) {
    context.logger.warn("loop_detector_alert", {
      child_ids: alert.childIds,
      participants: alert.participants,
      recommendation: alert.recommendation,
      reason: alert.reason,
      occurrences: alert.occurrences,
    });
  }
  return alert;
}

/**
 * Chooses the most severe alert between the provided candidates.
 */
function chooseMostSevereAlert(first: LoopAlert | null, second: LoopAlert | null): LoopAlert | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  if (first.recommendation === "kill" && second.recommendation !== "kill") {
    return first;
  }
  if (second.recommendation === "kill" && first.recommendation !== "kill") {
    return second;
  }
  return second.lastTimestamp >= first.lastTimestamp ? second : first;
}

/** Clears any cached loop signature for a child. */
function clearLoopSignature(childId: string): void {
  pendingLoopSignatures.delete(childId);
}

/**
 * Derives the tool identifier requested in the payload. The helper inspects the
 * most common fields used by Codex payloads so both present and legacy formats
 * are supported without leaking implementation details to the tests.
 */
function extractRequestedTool(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;

  const direct = record.tool;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  if (typeof record.type === "string") {
    const typeValue = record.type.toLowerCase();
    if ((typeValue === "tool" || typeValue === "call_tool") && typeof record.name === "string" && record.name.trim()) {
      return record.name.trim();
    }
  }

  const alt = record.tool_name ?? record.toolName;
  if (typeof alt === "string" && alt.trim()) {
    return alt.trim();
  }

  return null;
}

function isHighRiskTask(metadata?: Record<string, unknown>): boolean {
  if (!metadata) {
    return false;
  }
  const direct = [metadata.risk, metadata.risk_level, metadata.severity, metadata.safety];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim().toLowerCase() === "high") {
      return true;
    }
  }
  const booleanFlag = metadata.high_risk;
  if (booleanFlag === true || (typeof booleanFlag === "string" && booleanFlag.toLowerCase() === "true")) {
    return true;
  }
  const tags = metadata.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === "string" && tag.toLowerCase().includes("high-risk")) {
        return true;
      }
    }
  }
  return false;
}

const FINAL_MESSAGE_TYPES = new Set([
  "response",
  "result",
  "final",
  "completion",
  "done",
]);

/** Schema for the `child_status` tool. */
export const ChildStatusInputSchema = z.object({
  child_id: z.string().min(1),
});
export const ChildStatusInputShape = ChildStatusInputSchema.shape;

/** Shape returned by {@link handleChildStatus}. */
export interface ChildStatusResult extends Record<string, unknown> {
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
}

/**
 * Collects a consistent snapshot for the targeted child runtime.
 */
export function handleChildStatus(
  context: ChildToolContext,
  input: z.infer<typeof ChildStatusInputSchema>,
): ChildStatusResult {
  context.logger.info("child_status", { child_id: input.child_id });
  const snapshot = context.supervisor.status(input.child_id);
  return {
    child_id: input.child_id,
    runtime_status: snapshot.runtime,
    index_snapshot: snapshot.index,
  };
}

/** Schema for the `child_collect` tool. */
export const ChildCollectInputSchema = z.object({
  child_id: z.string().min(1),
});
export const ChildCollectInputShape = ChildCollectInputSchema.shape;

/** Shape returned by {@link handleChildCollect}. */
export interface ChildCollectResult extends Record<string, unknown> {
  child_id: string;
  outputs: ChildCollectedOutputs;
}

/**
 * Aggregates logs and artifacts produced by the child.
 */
export async function handleChildCollect(
  context: ChildToolContext,
  input: z.infer<typeof ChildCollectInputSchema>,
): Promise<ChildCollectResult> {
  context.logger.info("child_collect", { child_id: input.child_id });
  const outputs = await context.supervisor.collect(input.child_id);
  return { child_id: input.child_id, outputs };
}

/** Schema for the `child_stream` tool. */
export const ChildStreamInputSchema = z.object({
  child_id: z.string().min(1),
  after_sequence: z.number().int().min(-1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  streams: z.array(z.enum(["stdout", "stderr"]))
    .min(1, "streams requires at least one entry")
    .max(2, "streams accepts stdout/stderr only")
    .optional(),
});
export const ChildStreamInputShape = ChildStreamInputSchema.shape;

/** Shape returned by {@link handleChildStream}. */
export interface ChildStreamResult extends Record<string, unknown> {
  child_id: string;
  slice: ChildMessageStreamResult;
}

/**
 * Streams recorded messages for a child with pagination. Useful for live
 * transcript viewers that cannot afford to fetch the full backlog at once.
 */
export function handleChildStream(
  context: ChildToolContext,
  input: z.infer<typeof ChildStreamInputSchema>,
): ChildStreamResult {
  context.logger.info("child_stream", {
    child_id: input.child_id,
    after_sequence: input.after_sequence ?? null,
    limit: input.limit ?? null,
    streams: input.streams ?? null,
  });

  const slice = context.supervisor.stream(input.child_id, {
    afterSequence: input.after_sequence,
    limit: input.limit,
    streams: input.streams,
  });

  return {
    child_id: input.child_id,
    slice,
  };
}

/** Schema for the `child_cancel` tool. */
export const ChildCancelInputSchema = z.object({
  child_id: z.string().min(1),
  signal: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});
export const ChildCancelInputShape = ChildCancelInputSchema.shape;

/** Shape returned by {@link handleChildCancel}. */
export interface ChildCancelResult extends Record<string, unknown> {
  child_id: string;
  shutdown: ChildShutdownResult;
}

/**
 * Requests a graceful shutdown of the child process.
 */
export async function handleChildCancel(
  context: ChildToolContext,
  input: z.infer<typeof ChildCancelInputSchema>,
): Promise<ChildCancelResult> {
  context.logger.info("child_cancel", {
    child_id: input.child_id,
    signal: input.signal ?? "SIGINT",
    timeout_ms: input.timeout_ms ?? null,
  });

  const shutdown = await context.supervisor.cancel(input.child_id, {
    signal: input.signal as NodeJS.Signals | undefined,
    timeoutMs: input.timeout_ms,
  });

  clearLoopSignature(input.child_id);

  return { child_id: input.child_id, shutdown };
}

/** Schema for the `child_kill` tool. */
export const ChildKillInputSchema = z.object({
  child_id: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
});
export const ChildKillInputShape = ChildKillInputSchema.shape;

/** Shape returned by {@link handleChildKill}. */
export interface ChildKillResult extends Record<string, unknown> {
  child_id: string;
  shutdown: ChildShutdownResult;
}

/**
 * Forcefully terminates the child runtime.
 */
export async function handleChildKill(
  context: ChildToolContext,
  input: z.infer<typeof ChildKillInputSchema>,
): Promise<ChildKillResult> {
  context.logger.warn("child_kill", { child_id: input.child_id, timeout_ms: input.timeout_ms ?? null });
  const shutdown = await context.supervisor.kill(input.child_id, { timeoutMs: input.timeout_ms });
  clearLoopSignature(input.child_id);
  return { child_id: input.child_id, shutdown };
}

/** Schema for the `child_gc` tool. */
export const ChildGcInputSchema = z.object({
  child_id: z.string().min(1),
});
export const ChildGcInputShape = ChildGcInputSchema.shape;

/** Shape returned by {@link handleChildGc}. */
export interface ChildGcResult extends Record<string, unknown> {
  child_id: string;
  removed: boolean;
}

/**
 * Reclaims resources associated with the child after it terminated.
 */
export function handleChildGc(
  context: ChildToolContext,
  input: z.infer<typeof ChildGcInputSchema>,
): ChildGcResult {
  context.logger.info("child_gc", { child_id: input.child_id });
  context.supervisor.gc(input.child_id);
  clearLoopSignature(input.child_id);
  return { child_id: input.child_id, removed: true };
}
