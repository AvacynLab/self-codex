import { z } from "zod";
/** Schema validating the payload accepted by the `causal_export` tool. */
export const CausalExportInputSchema = z.object({}).strict();
export const CausalExportInputShape = CausalExportInputSchema.shape;
/** Schema validating the payload accepted by the `causal_explain` tool. */
export const CausalExplainInputSchema = z
    .object({
    outcome_id: z.string().min(1),
    max_depth: z.number().int().min(1).max(32).optional(),
})
    .strict();
export const CausalExplainInputShape = CausalExplainInputSchema.shape;
/** Dumps the entire causal memory for offline audits. */
export function handleCausalExport(context, _input) {
    const events = context.causalMemory.exportAll().map(serializeEvent);
    context.logger.info("causal_export", { count: events.length });
    return { events, total: events.length };
}
/** Computes an explanation graph for a given outcome event. */
export function handleCausalExplain(context, input) {
    const explanation = context.causalMemory.explain(input.outcome_id, { maxDepth: input.max_depth });
    context.logger.info("causal_explain", {
        outcome_id: input.outcome_id,
        ancestors: explanation.ancestors.length,
        depth: explanation.depth,
    });
    return serializeExplanation(explanation);
}
function serializeExplanation(explanation) {
    return {
        outcome: serializeEvent(explanation.outcome),
        ancestors: explanation.ancestors.map(serializeEvent),
        edges: explanation.edges.map((edge) => ({ from: edge.from, to: edge.to })),
        depth: explanation.depth,
    };
}
function serializeEvent(snapshot) {
    return {
        id: snapshot.id,
        type: snapshot.type,
        label: snapshot.label,
        data: snapshot.data,
        tags: [...snapshot.tags],
        causes: [...snapshot.causes],
        effects: [...snapshot.effects],
        created_at: snapshot.createdAt,
        ordinal: snapshot.ordinal,
    };
}
//# sourceMappingURL=causalTools.js.map