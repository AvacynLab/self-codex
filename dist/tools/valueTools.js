import { z } from "zod";
/** Schema describing a single value definition accepted by the set tool. */
const ValueNodeSchema = z
    .object({
    id: z.string().min(1, "value id must not be empty"),
    label: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(240).optional(),
    weight: z.number().min(0).max(100).optional(),
    tolerance: z.number().min(0).max(1).optional(),
})
    .strict();
/** Schema describing a relationship between two values. */
const ValueRelationshipSchema = z
    .object({
    from: z.string().min(1, "relationship source must not be empty"),
    to: z.string().min(1, "relationship target must not be empty"),
    kind: z.enum(["supports", "conflicts"]).default("supports"),
    weight: z.number().min(0).max(1).optional(),
})
    .strict();
/** Schema describing a plan impact considered by the guard. */
export const ValueImpactSchema = z
    .object({
    value: z.string().min(1, "value impact must reference a value id"),
    impact: z.enum(["support", "risk"]).default("risk"),
    severity: z.number().min(0).max(1).optional(),
    rationale: z.string().min(1).max(240).optional(),
    source: z.string().min(1).optional(),
})
    .strict();
/** Schema validating the payload accepted by the `values_set` tool. */
export const ValuesSetInputSchema = z
    .object({
    values: z.array(ValueNodeSchema).min(1).max(128),
    relationships: z.array(ValueRelationshipSchema).max(512).optional(),
    default_threshold: z.number().min(0).max(1).optional(),
})
    .strict();
export const ValuesSetInputShape = ValuesSetInputSchema.shape;
/** Schema validating the payload accepted by the `values_score` tool. */
export const ValuesScoreInputSchema = z
    .object({
    id: z.string().min(1, "plan id must not be empty"),
    label: z.string().min(1).max(200).optional(),
    impacts: z.array(ValueImpactSchema).min(1).max(64),
})
    .strict();
export const ValuesScoreInputShape = ValuesScoreInputSchema.shape;
/** Schema validating the payload accepted by the `values_filter` tool. */
export const ValuesFilterInputSchema = ValuesScoreInputSchema.extend({
    threshold: z.number().min(0).max(1).optional(),
}).strict();
export const ValuesFilterInputShape = ValuesFilterInputSchema.shape;
/**
 * Replace the value graph configuration with the provided specification.
 *
 * The handler persists the new values, updates the relationship map and returns
 * the summary produced by {@link ValueGraph.set}. Logging keeps CI runs and
 * operators aware of the applied threshold and the graph size.
 */
export function handleValuesSet(context, input) {
    const config = {
        values: input.values.map((value) => ({
            id: value.id,
            label: value.label,
            description: value.description,
            weight: value.weight,
            tolerance: value.tolerance,
        })),
        relationships: input.relationships?.map((relationship) => ({
            from: relationship.from,
            to: relationship.to,
            kind: relationship.kind,
            weight: relationship.weight,
        })),
        defaultThreshold: input.default_threshold,
    };
    const summary = context.valueGraph.set(config);
    context.logger.info("values_set", {
        values: summary.values,
        relationships: summary.relationships,
        default_threshold: summary.default_threshold,
        version: summary.version,
    });
    return { summary };
}
/**
 * Computes the guard decision without enforcing the threshold. The score and
 * breakdown mirror the structure consumed by the orchestrator when annotating
 * plan results.
 */
export function handleValuesScore(context, input) {
    const score = context.valueGraph.score({
        id: input.id,
        label: input.label,
        impacts: normaliseImpacts(input.impacts),
    });
    const threshold = context.valueGraph.getDefaultThreshold();
    const allowed = score.score >= threshold && score.violations.length === 0;
    context.logger.info("values_score", {
        plan_id: input.id,
        impacts: input.impacts.length,
        score: score.score,
        total: score.total,
    });
    return { decision: { ...score, allowed, threshold } };
}
/**
 * Applies the guard threshold and returns whether the plan can proceed. The
 * detailed decision is returned so the caller can surface it to operators.
 */
export function handleValuesFilter(context, input) {
    const decision = context.valueGraph.filter({
        id: input.id,
        label: input.label,
        impacts: normaliseImpacts(input.impacts),
        threshold: input.threshold,
    });
    context.logger.info("values_filter", {
        plan_id: input.id,
        impacts: input.impacts.length,
        score: decision.score,
        threshold: decision.threshold,
        allowed: decision.allowed,
        violations: decision.violations.length,
    });
    return decision;
}
/** Normalises impacts to match the {@link ValueImpactInput} contract. */
function normaliseImpacts(impacts) {
    return impacts.map((impact) => ({
        value: impact.value,
        impact: impact.impact,
        severity: impact.severity,
        rationale: impact.rationale,
        source: impact.source,
    }));
}
