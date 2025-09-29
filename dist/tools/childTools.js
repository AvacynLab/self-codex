import { z } from "zod";
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
/**
 * Launches a new child runtime and optionally forwards an initial payload.
 */
export async function handleChildCreate(context, input) {
    const options = {
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
/**
 * Sends an arbitrary JSON payload to a child process.
 */
export async function handleChildSend(context, input) {
    context.logger.info("child_send", { child_id: input.child_id });
    const message = await context.supervisor.send(input.child_id, input.payload);
    return { child_id: input.child_id, message };
}
/** Schema for the `child_status` tool. */
export const ChildStatusInputSchema = z.object({
    child_id: z.string().min(1),
});
export const ChildStatusInputShape = ChildStatusInputSchema.shape;
/**
 * Collects a consistent snapshot for the targeted child runtime.
 */
export function handleChildStatus(context, input) {
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
/**
 * Aggregates logs and artifacts produced by the child.
 */
export async function handleChildCollect(context, input) {
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
/**
 * Streams recorded messages for a child with pagination. Useful for live
 * transcript viewers that cannot afford to fetch the full backlog at once.
 */
export function handleChildStream(context, input) {
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
/**
 * Requests a graceful shutdown of the child process.
 */
export async function handleChildCancel(context, input) {
    context.logger.info("child_cancel", {
        child_id: input.child_id,
        signal: input.signal ?? "SIGINT",
        timeout_ms: input.timeout_ms ?? null,
    });
    const shutdown = await context.supervisor.cancel(input.child_id, {
        signal: input.signal,
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
/**
 * Forcefully terminates the child runtime.
 */
export async function handleChildKill(context, input) {
    context.logger.warn("child_kill", { child_id: input.child_id, timeout_ms: input.timeout_ms ?? null });
    const shutdown = await context.supervisor.kill(input.child_id, { timeoutMs: input.timeout_ms });
    return { child_id: input.child_id, shutdown };
}
/** Schema for the `child_gc` tool. */
export const ChildGcInputSchema = z.object({
    child_id: z.string().min(1),
});
export const ChildGcInputShape = ChildGcInputSchema.shape;
/**
 * Reclaims resources associated with the child after it terminated.
 */
export function handleChildGc(context, input) {
    context.logger.info("child_gc", { child_id: input.child_id });
    context.supervisor.gc(input.child_id);
    return { child_id: input.child_id, removed: true };
}
