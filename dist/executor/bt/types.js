import { z } from "zod";
/** Schema validating a serialised Behaviour Tree definition. */
export const BehaviorNodeDefinitionSchema = z.lazy(() => z
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
        policy: z.enum(["all", "any"]),
        children: z.array(BehaviorNodeDefinitionSchema).min(1),
    }),
    z.object({
        type: z.literal("retry"),
        id: z.string().min(1).optional(),
        max_attempts: z.number().int().min(1),
        backoff_ms: z.number().int().min(0).optional(),
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
}));
/** Schema validating an entire compiled Behaviour Tree payload. */
export const CompiledBehaviorTreeSchema = z.object({
    id: z.string().min(1),
    root: BehaviorNodeDefinitionSchema,
});
