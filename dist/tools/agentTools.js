import { z } from "zod";
/** Schema describing the payload accepted by `agent_autoscale_set`. */
const AgentAutoscaleSetInputBase = z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    cooldown_ms: z.number().int().nonnegative().optional(),
});
export const AgentAutoscaleSetInputSchema = AgentAutoscaleSetInputBase.superRefine((value, ctx) => {
    if (value.max < value.min) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "invalid_bounds",
            params: {
                code: "invalid_bounds",
                message: "max must be greater than or equal to min",
                hint: "increase max or lower min",
            },
        });
    }
});
export const AgentAutoscaleSetInputShape = AgentAutoscaleSetInputBase.shape;
/**
 * Updates the autoscaler bounds and cooldown, returning the applied values so
 * operators can persist the configuration.
 */
export function handleAgentAutoscaleSet(context, input) {
    const patch = {
        minChildren: input.min,
        maxChildren: input.max,
        ...(input.cooldown_ms !== undefined ? { cooldownMs: input.cooldown_ms } : {}),
    };
    const config = context.autoscaler.configure(patch);
    context.logger.info("agent_autoscale_config_applied", {
        min: config.minChildren,
        max: config.maxChildren,
        cooldown_ms: config.cooldownMs,
    });
    return {
        min: config.minChildren,
        max: config.maxChildren,
        cooldown_ms: config.cooldownMs,
    };
}
