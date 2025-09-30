import { z } from "zod";
/**
 * Schema describing the payload accepted by the `child_create` tool.
 *
 * Operators can optionally override the executable, provide extra arguments,
 * and attach metadata persisted alongside the runtime manifest. The initial
 * payload is sent to the child immediately after the ready handshake when
 * provided.
 */
/**
 * Schema describing prompt segments accepted when spawning a child. Each
 * segment can either be a single string or an array of strings that will be
 * rendered sequentially by the orchestrator. The structure mirrors the
 * templating helpers used by the planning tools so the manifest can capture
 * the exact bootstrap instructions sent to the runtime.
 */
const PromptSegmentSchema = z.union([z.string(), z.array(z.string())]);
const PromptSchema = z
    .object({
    system: PromptSegmentSchema.optional(),
    user: PromptSegmentSchema.optional(),
    assistant: PromptSegmentSchema.optional(),
})
    .strict();
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
        manifestExtras: buildManifestExtras(input),
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
        workdir: runtimeStatus.workdir,
        started_at: runtimeStatus.startedAt,
        ready_message: readyMessage,
        sent_initial_payload: sentInitialPayload,
    };
}
/**
 * Builds the set of additional manifest fields persisted alongside the runtime
 * metadata. The helper keeps the construction logic isolated so new fields can
 * be introduced without cluttering {@link handleChildCreate}.
 */
function buildManifestExtras(input) {
    const extras = {
        ...(input.manifest_extras ?? {}),
    };
    if (input.prompt) {
        extras.prompt = input.prompt;
    }
    if (input.tools_allow) {
        extras.tools_allow = input.tools_allow;
    }
    if (input.timeouts) {
        extras.timeouts = input.timeouts;
    }
    if (input.budget) {
        extras.budget = input.budget;
    }
    return Object.keys(extras).length > 0 ? extras : undefined;
}
/** Schema for the `child_send` tool. */
const ChildSendExpectationSchema = z.enum(["stream", "final"]);
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
});
export const ChildSendInputSchema = ChildSendInputBaseSchema.refine((input) => (input.timeout_ms === undefined ? true : input.expect !== undefined), {
    message: "timeout_ms requires expect to be provided",
    path: ["timeout_ms"],
});
export const ChildSendInputShape = ChildSendInputBaseSchema.shape;
/**
 * Sends an arbitrary JSON payload to a child process.
 */
export async function handleChildSend(context, input) {
    context.logger.info("child_send", { child_id: input.child_id });
    let baselineSequence = 0;
    if (input.expect) {
        const snapshot = context.supervisor.stream(input.child_id, { limit: 1 });
        baselineSequence = snapshot.totalMessages;
    }
    const message = await context.supervisor.send(input.child_id, input.payload);
    if (!input.expect) {
        return { child_id: input.child_id, message, awaited_message: null };
    }
    const timeoutMs = input.timeout_ms ?? (input.expect === "final" ? 8_000 : 2_000);
    const matcher = input.expect === "final" ? matchesFinalMessage : matchesStreamMessage;
    try {
        const awaited = await context.supervisor.waitForMessage(input.child_id, (msg) => msg.sequence >= baselineSequence && matcher(msg), timeoutMs);
        return {
            child_id: input.child_id,
            message,
            awaited_message: cloneChildMessage(awaited),
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`child_send awaited a ${input.expect} message but failed after ${timeoutMs}ms: ${reason}`);
    }
}
/** Determine if a runtime message satisfies the "stream" expectation. */
function matchesStreamMessage(message) {
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
function matchesFinalMessage(message) {
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
function extractMessageType(message) {
    if (!message.parsed || typeof message.parsed !== "object") {
        return null;
    }
    const candidate = message.parsed.type;
    return typeof candidate === "string" ? candidate : null;
}
/** Clone a child runtime message to avoid exposing internal buffers. */
function cloneChildMessage(message) {
    const parsedClone = message.parsed === null ? null : JSON.parse(JSON.stringify(message.parsed));
    return { ...message, parsed: parsedClone };
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
