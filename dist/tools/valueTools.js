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
    nodeId: z.string().min(1).optional(),
})
    .strict();
/** Optional correlation metadata accepted by plan evaluation tools. */
const ValuePlanCorrelationSchema = z
    .object({
    run_id: z.string().min(1).optional(),
    op_id: z.string().min(1).optional(),
    job_id: z.string().min(1).optional(),
    graph_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
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
    .extend(ValuePlanCorrelationSchema.shape)
    .strict();
export const ValuesScoreInputShape = ValuesScoreInputSchema.shape;
/** Schema validating the payload accepted by the `values_filter` tool. */
export const ValuesFilterInputSchema = ValuesScoreInputSchema.extend({
    threshold: z.number().min(0).max(1).optional(),
}).strict();
export const ValuesFilterInputShape = ValuesFilterInputSchema.shape;
/** Schema validating the payload accepted by the `values_explain` tool. */
export const ValuesExplainInputSchema = z
    .object({
    plan: ValuesFilterInputSchema,
})
    .strict();
export const ValuesExplainInputShape = ValuesExplainInputSchema.shape;
/**
 * Normalises optional correlation metadata supplied alongside value guard
 * inputs. Returning `null` keeps downstream logging and event emission tidy.
 */
function extractCorrelationHints(input) {
    const hints = {};
    if (input.run_id !== undefined)
        hints.runId = input.run_id;
    if (input.op_id !== undefined)
        hints.opId = input.op_id;
    if (input.job_id !== undefined)
        hints.jobId = input.job_id;
    if (input.graph_id !== undefined)
        hints.graphId = input.graph_id;
    if (input.node_id !== undefined)
        hints.nodeId = input.node_id;
    return Object.keys(hints).length > 0 ? hints : null;
}
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
    const correlation = extractCorrelationHints(input);
    const score = context.valueGraph.score({
        id: input.id,
        label: input.label,
        impacts: normaliseImpacts(input.impacts),
    }, { correlation });
    const threshold = context.valueGraph.getDefaultThreshold();
    const allowed = score.score >= threshold && score.violations.length === 0;
    context.logger.info("values_score", {
        plan_id: input.id,
        impacts: input.impacts.length,
        score: score.score,
        total: score.total,
        run_id: correlation?.runId ?? null,
        op_id: correlation?.opId ?? null,
    });
    return { decision: { ...score, allowed, threshold } };
}
/**
 * Applies the guard threshold and returns whether the plan can proceed. The
 * detailed decision is returned so the caller can surface it to operators.
 */
export function handleValuesFilter(context, input) {
    const correlation = extractCorrelationHints(input);
    const decision = context.valueGraph.filter({
        id: input.id,
        label: input.label,
        impacts: normaliseImpacts(input.impacts),
        threshold: input.threshold,
    }, { correlation });
    context.logger.info("values_filter", {
        plan_id: input.id,
        impacts: input.impacts.length,
        score: decision.score,
        threshold: decision.threshold,
        allowed: decision.allowed,
        violations: decision.violations.length,
        run_id: correlation?.runId ?? null,
        op_id: correlation?.opId ?? null,
    });
    return decision;
}
/**
 * Explains the guard decision by enriching violations with hints and
 * correlation metadata. The response mirrors {@link ValueGraph.explain} so
 * downstream MCP clients can surface the narrative directly to operators.
 */
export function handleValuesExplain(context, input) {
    const plan = input.plan;
    const correlation = extractCorrelationHints(plan);
    const explanation = context.valueGraph.explain({
        id: plan.id,
        label: plan.label,
        impacts: normaliseImpacts(plan.impacts),
        threshold: plan.threshold,
    }, { correlation });
    context.logger.info("values_explain", {
        plan_id: plan.id,
        impacts: plan.impacts.length,
        score: explanation.decision.score,
        threshold: explanation.decision.threshold,
        allowed: explanation.decision.allowed,
        violations: explanation.violations.length,
        run_id: correlation?.runId ?? null,
        op_id: correlation?.opId ?? null,
    });
    return explanation;
}
/** Normalises impacts to match the {@link ValueImpactInput} contract. */
function normaliseImpacts(impacts) {
    return impacts.map((impact) => ({
        value: impact.value,
        impact: impact.impact,
        severity: impact.severity,
        rationale: impact.rationale,
        source: impact.source,
        nodeId: impact.nodeId,
    }));
}
