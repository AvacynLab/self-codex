import { z } from "zod";

import {
  ChildCollectedOutputs,
  ChildMessageStreamResult,
  ChildRuntimeStatus,
  ChildShutdownResult,
} from "../childRuntime.js";
import {
  ChildSupervisor,
  CreateChildOptions,
  SendResult,
} from "../childSupervisor.js";
import { ChildRecordSnapshot } from "../state/childrenIndex.js";
import { StructuredLogger } from "../logger.js";

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
}

/**
 * Schema describing the payload accepted by the `child_create` tool.
 *
 * Operators can optionally override the executable, provide extra arguments,
 * and attach metadata persisted alongside the runtime manifest. The initial
 * payload is sent to the child immediately after the ready handshake when
 * provided.
 */
export const ChildCreateInputSchema = z.object({
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
  metadata: z.record(z.unknown()).optional(),
  manifest_extras: z.record(z.unknown()).optional(),
  wait_for_ready: z.boolean().optional(),
  ready_type: z.string().min(1).optional(),
  ready_timeout_ms: z.number().int().positive().optional(),
  initial_payload: z.unknown().optional(),
});
export const ChildCreateInputShape = ChildCreateInputSchema.shape;

/** Shape returned by {@link handleChildCreate}. */
export interface ChildCreateResult extends Record<string, unknown> {
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  manifest_path: string;
  log_path: string;
  ready_message: unknown | null;
  sent_initial_payload: boolean;
}

/**
 * Launches a new child runtime and optionally forwards an initial payload.
 */
export async function handleChildCreate(
  context: ChildToolContext,
  input: z.infer<typeof ChildCreateInputSchema>,
): Promise<ChildCreateResult> {
  const options: CreateChildOptions = {
    childId: input.child_id,
    command: input.command,
    args: input.args,
    env: input.env,
    metadata: input.metadata,
    manifestExtras: input.manifest_extras,
    waitForReady: input.wait_for_ready,
    readyType: input.ready_type,
    readyTimeoutMs: input.ready_timeout_ms,
  };

  context.logger.info("child_create_requested", {
    child_id: options.childId ?? null,
    command: options.command ?? null,
    args: options.args?.length ?? 0,
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
    child_id: created.childId,
    pid: runtimeStatus.pid,
    workdir: runtimeStatus.workdir,
  });

  return {
    child_id: created.childId,
    runtime_status: runtimeStatus,
    index_snapshot: created.index,
    manifest_path: created.runtime.manifestPath,
    log_path: created.runtime.logPath,
    ready_message: readyMessage,
    sent_initial_payload: sentInitialPayload,
  };
}

/** Schema for the `child_send` tool. */
export const ChildSendInputSchema = z.object({
  child_id: z.string().min(1),
  payload: z.unknown(),
});
export const ChildSendInputShape = ChildSendInputSchema.shape;

/** Shape returned by {@link handleChildSend}. */
export interface ChildSendResult extends Record<string, unknown> {
  child_id: string;
  message: SendResult;
}

/**
 * Sends an arbitrary JSON payload to a child process.
 */
export async function handleChildSend(
  context: ChildToolContext,
  input: z.infer<typeof ChildSendInputSchema>,
): Promise<ChildSendResult> {
  context.logger.info("child_send", { child_id: input.child_id });
  const message = await context.supervisor.send(input.child_id, input.payload);
  return { child_id: input.child_id, message };
}

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
  return { child_id: input.child_id, removed: true };
}
