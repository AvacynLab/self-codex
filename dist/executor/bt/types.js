/**
 * Behaviour Tree type system centralising runtime contracts and serialisation schemas.
 * The shared definitions keep the interpreter strongly typed across runtime and persistence.
 */
import { z } from "zod";
import { omitUndefinedDeep } from "../../utils/object.js";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function hasOptionalString(record, key) {
    return !(key in record) || typeof record[key] === "string";
}
function hasOptionalNumber(record, key, predicate) {
    if (!(key in record)) {
        return true;
    }
    const value = record[key];
    if (typeof value !== "number" || Number.isNaN(value)) {
        return false;
    }
    return predicate ? predicate(value) : true;
}
function isParallelPolicyValue(value) {
    if (value === "all" || value === "any") {
        return true;
    }
    if (isRecord(value) && value.mode === "quota" && typeof value.threshold === "number" && Number.isFinite(value.threshold)) {
        return true;
    }
    return false;
}
function isBehaviorNodeDefinition(value) {
    if (!isRecord(value) || typeof value.type !== "string") {
        return false;
    }
    switch (value.type) {
        case "sequence":
        case "selector": {
            return (Array.isArray(value.children) &&
                value.children.every(isBehaviorNodeDefinition) &&
                hasOptionalString(value, "id"));
        }
        case "parallel": {
            return (Array.isArray(value.children) &&
                value.children.every(isBehaviorNodeDefinition) &&
                hasOptionalString(value, "id") &&
                isParallelPolicyValue(value.policy));
        }
        case "retry": {
            return (typeof value.max_attempts === "number" &&
                Number.isInteger(value.max_attempts) &&
                value.max_attempts >= 1 &&
                isBehaviorNodeDefinition(value.child) &&
                hasOptionalString(value, "id") &&
                hasOptionalNumber(value, "backoff_ms", (candidate) => Number.isInteger(candidate) && candidate >= 0) &&
                hasOptionalNumber(value, "backoff_jitter_ms", (candidate) => Number.isInteger(candidate) && candidate >= 0));
        }
        case "timeout": {
            return (isBehaviorNodeDefinition(value.child) &&
                hasOptionalString(value, "id") &&
                hasOptionalNumber(value, "timeout_ms", (candidate) => Number.isInteger(candidate) && candidate >= 1) &&
                hasOptionalString(value, "timeout_category") &&
                hasOptionalNumber(value, "complexity_score", (candidate) => Number.isFinite(candidate) && candidate > 0));
        }
        case "guard": {
            return (typeof value.condition_key === "string" &&
                hasOptionalString(value, "id") &&
                isBehaviorNodeDefinition(value.child));
        }
        case "cancellable": {
            return hasOptionalString(value, "id") && isBehaviorNodeDefinition(value.child);
        }
        case "task": {
            return (typeof value.node_id === "string" &&
                typeof value.tool === "string" &&
                hasOptionalString(value, "id") &&
                hasOptionalString(value, "input_key"));
        }
        default:
            return false;
    }
}
/** Schema validating a serialised Behaviour Tree definition. */
export const BehaviorNodeDefinitionSchema = z.lazy(() => {
    const schema = z
        .discriminatedUnion("type", [
        z.object({
            type: z.literal("sequence"),
            id: z.string().min(1).optional(),
            children: z.array(BehaviorNodeDefinitionSchema).min(1),
        }),
        z.object({
            type: z.literal("selector"),
            id: z.string().min(1).optional(),
            children: z.array(BehaviorNodeDefinitionSchema).min(1),
        }),
        z.object({
            type: z.literal("parallel"),
            id: z.string().min(1).optional(),
            policy: z.union([
                z.enum(["all", "any"]),
                z
                    .object({
                    mode: z.literal("quota"),
                    threshold: z.number().int().min(1),
                })
                    .strict(),
            ]),
            children: z.array(BehaviorNodeDefinitionSchema).min(1),
        }),
        z.object({
            type: z.literal("retry"),
            id: z.string().min(1).optional(),
            max_attempts: z.number().int().min(1),
            backoff_ms: z.number().int().min(0).optional(),
            backoff_jitter_ms: z.number().int().min(0).optional(),
            child: BehaviorNodeDefinitionSchema,
        }),
        z.object({
            type: z.literal("timeout"),
            id: z.string().min(1).optional(),
            timeout_ms: z.number().int().min(1).optional(),
            timeout_category: z.string().min(1).optional(),
            complexity_score: z.number().positive().max(100).optional(),
            child: BehaviorNodeDefinitionSchema,
        }),
        z.object({
            type: z.literal("guard"),
            id: z.string().min(1).optional(),
            condition_key: z.string().min(1),
            expected: z.unknown().optional(),
            child: BehaviorNodeDefinitionSchema,
        }),
        z.object({
            type: z.literal("cancellable"),
            id: z.string().min(1).optional(),
            child: BehaviorNodeDefinitionSchema,
        }),
        z.object({
            type: z.literal("task"),
            id: z.string().min(1).optional(),
            node_id: z.string().min(1),
            tool: z.string().min(1),
            input_key: z.string().min(1).optional(),
        }),
    ])
        .superRefine((value, ctx) => {
        if (value.type === "timeout" && value.timeout_ms === undefined && value.timeout_category === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "timeout nodes require timeout_ms or timeout_category",
                path: ["timeout_ms"],
            });
        }
        if (value.type === "timeout" && value.complexity_score !== undefined && !Number.isFinite(value.complexity_score)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "complexity_score must be finite",
                path: ["complexity_score"],
            });
        }
    })
        .transform((value) => {
        const sanitised = omitUndefinedDeep(value);
        if (!isBehaviorNodeDefinition(sanitised)) {
            throw new Error("invalid behavior node definition");
        }
        return sanitised;
    });
    return schema;
});
/** Schema validating an entire compiled Behaviour Tree payload. */
export const CompiledBehaviorTreeSchema = z.object({
    id: z.string().min(1),
    root: BehaviorNodeDefinitionSchema,
});
//# sourceMappingURL=types.js.map