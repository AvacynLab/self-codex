import { z } from "zod";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { PromptTemplateSchema } from "../prompts.js";
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
    tool_calls: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    wallclock_ms: z.number().int().positive().optional(),
    bytes_in: z.number().int().nonnegative().optional(),
    bytes_out: z.number().int().nonnegative().optional(),
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
const ChildSandboxProfileSchema = z.enum(["strict", "standard", "permissive"]);
const ChildSandboxOptionsSchema = z
    .object({
    profile: ChildSandboxProfileSchema.optional(),
    allow_env: z
        .array(z.string().min(1, "allow_env entries must be non-empty strings"))
        .max(64, "cannot allow more than 64 environment variables")
        .optional(),
    env: z.record(z.string()).optional(),
    inherit_default_env: z.boolean().optional(),
})
    .strict();
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
    ready_timeout_ms: z.number().int().positive().optional(),
    idempotency_key: z.string().min(1).optional(),
    sandbox: ChildSandboxOptionsSchema.optional(),
});
export const ChildSpawnCodexInputShape = ChildSpawnCodexInputSchema.shape;
const ChildBatchCreateEntrySchema = ChildSpawnCodexInputSchema.strict();
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
export const ChildSendInputSchema = ChildSendInputBaseSchema.refine((input) => (input.timeout_ms === undefined ? true : input.expect !== undefined), {
    message: "timeout_ms requires expect to be provided",
    path: ["timeout_ms"],
});
export const ChildSendInputShape = ChildSendInputBaseSchema.shape;
export const ChildStatusInputSchema = z.object({
    child_id: z.string().min(1),
});
export const ChildStatusInputShape = ChildStatusInputSchema.shape;
export const ChildCollectInputSchema = z.object({
    child_id: z.string().min(1),
});
export const ChildCollectInputShape = ChildCollectInputSchema.shape;
export const ChildStreamInputSchema = z.object({
    child_id: z.string().min(1),
    after_sequence: z.number().int().min(-1).optional(),
    limit: z.number().int().positive().max(200).optional(),
    streams: z
        .array(z.enum(["stdout", "stderr"]))
        .min(1, "streams requires at least one entry")
        .max(2, "streams accepts stdout/stderr only")
        .optional(),
});
export const ChildStreamInputShape = ChildStreamInputSchema.shape;
export const ChildCancelInputSchema = z.object({
    child_id: z.string().min(1),
    signal: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
});
export const ChildCancelInputShape = ChildCancelInputSchema.shape;
export const ChildKillInputSchema = z.object({
    child_id: z.string().min(1),
    timeout_ms: z.number().int().positive().optional(),
});
export const ChildKillInputShape = ChildKillInputSchema.shape;
export const ChildGcInputSchema = z.object({
    child_id: z.string().min(1),
});
export const ChildGcInputShape = ChildGcInputSchema.shape;
export { handleChildAttach, handleChildBatchCreate, handleChildCancel, handleChildCollect, handleChildCreate, handleChildGc, handleChildKill, handleChildSend, handleChildSetLimits, handleChildSetRole, handleChildSpawnCodex, handleChildStatus, handleChildStream, } from "../children/api.js";
//# sourceMappingURL=childTools.js.map