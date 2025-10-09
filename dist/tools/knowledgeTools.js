import { z } from "zod";
import { suggestPlanFragments } from "../knowledge/assist.js";
/** Schema describing a single triple accepted by the insert tool. */
const KnowledgeTripleInputSchema = z
    .object({
    subject: z.string().min(1, "subject must not be empty"),
    predicate: z.string().min(1, "predicate must not be empty"),
    object: z.string().min(1, "object must not be empty"),
    source: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
})
    .strict();
/** Schema validating the payload accepted by the `kg_insert` tool. */
export const KgInsertInputSchema = z
    .object({
    triples: z.array(KnowledgeTripleInputSchema).min(1).max(256),
})
    .strict();
export const KgInsertInputShape = KgInsertInputSchema.shape;
/** Schema validating the payload accepted by the `kg_query` tool. */
export const KgQueryInputSchema = z
    .object({
    subject: z.string().min(1).optional(),
    predicate: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(500).default(50),
    order: z.enum(["asc", "desc"]).default("asc"),
})
    .strict();
export const KgQueryInputShape = KgQueryInputSchema.shape;
/** Schema validating the payload accepted by the `kg_export` tool. */
export const KgExportInputSchema = z.object({}).strict();
export const KgExportInputShape = KgExportInputSchema.shape;
const KgSuggestPlanContextSchema = z
    .object({
    preferred_sources: z.array(z.string().min(1).max(120)).max(16).optional(),
    exclude_tasks: z.array(z.string().min(1).max(120)).max(256).optional(),
    max_fragments: z.number().int().min(1).max(5).optional(),
})
    .strict();
/** Schema validating the payload accepted by the `kg_suggest_plan` tool. */
export const KgSuggestPlanInputSchema = z
    .object({
    goal: z.string().min(1, "goal must not be empty"),
    context: KgSuggestPlanContextSchema.optional(),
})
    .strict();
export const KgSuggestPlanInputShape = KgSuggestPlanInputSchema.shape;
/** Stores or updates a batch of triples on the knowledge graph. */
export function handleKgInsert(context, input) {
    let created = 0;
    let updated = 0;
    const inserted = input.triples.map((triple) => {
        const result = context.knowledgeGraph.insert(triple);
        if (result.created)
            created += 1;
        if (result.updated)
            updated += 1;
        return serializeTriple(result.snapshot);
    });
    const total = context.knowledgeGraph.count();
    context.logger.info("kg_insert", {
        triples: input.triples.length,
        created,
        updated,
        total,
    });
    return { inserted, created, updated, total };
}
/** Queries triples matching the provided motif and returns deterministic slices. */
export function handleKgQuery(context, input) {
    const triples = context.knowledgeGraph.query({
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        source: input.source,
        minConfidence: input.min_confidence,
    }, { limit: input.limit, order: input.order });
    const serialised = triples.map(serializeTriple);
    const nextCursor = serialised.length ? serialised[serialised.length - 1].ordinal : null;
    context.logger.info("kg_query", {
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        object: input.object ?? null,
        source: input.source ?? null,
        returned: serialised.length,
        limit: input.limit,
    });
    return { triples: serialised, total: serialised.length, next_cursor: nextCursor };
}
/** Dumps the entire knowledge graph in insertion order. */
export function handleKgExport(context, _input) {
    const triples = context.knowledgeGraph.exportAll().map(serializeTriple);
    context.logger.info("kg_export", { total: triples.length });
    return { triples, total: triples.length };
}
/** Generates plan fragments aligned with the stored knowledge graph patterns. */
export function handleKgSuggestPlan(context, input) {
    const suggestion = suggestPlanFragments(context.knowledgeGraph, {
        goal: input.goal,
        context: {
            preferredSources: input.context?.preferred_sources,
            excludeTasks: input.context?.exclude_tasks,
            maxFragments: input.context?.max_fragments,
        },
    });
    context.logger.info("kg_suggest_plan", {
        goal: suggestion.goal,
        fragments: suggestion.fragments.length,
        suggested_tasks: suggestion.coverage.suggested_tasks.length,
        preferred_sources_applied: suggestion.preferred_sources_applied.length,
        preferred_sources_ignored: suggestion.preferred_sources_ignored.length,
    });
    return suggestion;
}
function serializeTriple(snapshot) {
    return {
        id: snapshot.id,
        subject: snapshot.subject,
        predicate: snapshot.predicate,
        object: snapshot.object,
        source: snapshot.source,
        confidence: snapshot.confidence,
        inserted_at: snapshot.insertedAt,
        updated_at: snapshot.updatedAt,
        revision: snapshot.revision,
        ordinal: snapshot.ordinal,
    };
}
//# sourceMappingURL=knowledgeTools.js.map