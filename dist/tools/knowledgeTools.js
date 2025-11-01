import { z } from "zod";
import { assistKnowledgeQuery, suggestPlanFragments, } from "../knowledge/assist.js";
import { PROVENANCE_TYPES, normaliseProvenanceList, } from "../types/provenance.js";
/** Schema describing a single triple accepted by the insert tool. */
const ProvenanceSchema = z
    .object({
    sourceId: z.string().min(1, "sourceId must not be empty"),
    type: z.enum(PROVENANCE_TYPES),
    span: z
        .tuple([z.number(), z.number()])
        .refine((tuple) => tuple.every((value) => Number.isFinite(value)), "span values must be finite")
        .refine((tuple) => tuple[1] >= tuple[0], "span end must be >= start")
        .optional(),
    confidence: z.number().min(0).max(1).optional(),
})
    .strict();
const KnowledgeTripleInputSchema = z
    .object({
    subject: z.string().min(1, "subject must not be empty"),
    predicate: z.string().min(1, "predicate must not be empty"),
    object: z.string().min(1, "object must not be empty"),
    source: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    provenance: z.array(ProvenanceSchema).max(50).optional(),
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
export const KgExportInputSchema = z
    .object({
    format: z.enum(["triples", "rag_documents"]).default("triples").optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    include_predicates: z.array(z.string().min(1)).max(64).optional(),
    max_triples_per_subject: z.number().int().min(1).max(200).optional(),
})
    .strict();
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
/** Schema validating the payload accepted by the `kg_assist` tool. */
export const KgAssistInputSchema = z
    .object({
    query: z.string().min(1, "query must not be empty"),
    context: z.string().min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(6).default(3),
    min_score: z.number().min(0).max(1).default(0.15),
    domain_tags: z.array(z.string().min(1).max(64)).max(16).optional(),
})
    .strict();
export const KgAssistInputShape = KgAssistInputSchema.shape;
/** Stores or updates a batch of triples on the knowledge graph. */
export function handleKgInsert(context, input) {
    let created = 0;
    let updated = 0;
    const inserted = input.triples.map((triple) => {
        const payload = {
            subject: triple.subject,
            predicate: triple.predicate,
            object: triple.object,
        };
        if (triple.source !== undefined) {
            // Forward optional fields only when present so the call remains valid once
            // `exactOptionalPropertyTypes` is enabled on the project.
            payload.source = triple.source;
        }
        if (triple.confidence !== undefined) {
            payload.confidence = triple.confidence;
        }
        if (triple.provenance !== undefined) {
            const provenance = normaliseProvenanceList(triple.provenance);
            if (provenance.length > 0) {
                payload.provenance = provenance;
            }
        }
        const result = context.knowledgeGraph.insert(payload);
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
    const pattern = {};
    if (input.subject !== undefined) {
        pattern.subject = input.subject;
    }
    if (input.predicate !== undefined) {
        pattern.predicate = input.predicate;
    }
    if (input.object !== undefined) {
        pattern.object = input.object;
    }
    if (input.source !== undefined) {
        pattern.source = input.source;
    }
    if (input.min_confidence !== undefined) {
        pattern.minConfidence = input.min_confidence;
    }
    const triples = context.knowledgeGraph.query(pattern, {
        limit: input.limit,
        order: input.order,
    });
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
export function handleKgExport(context, input) {
    if (input.format === "rag_documents") {
        const exportOptions = {};
        if (input.min_confidence !== undefined) {
            exportOptions.minConfidence = input.min_confidence;
        }
        if (input.include_predicates !== undefined) {
            exportOptions.includePredicates = input.include_predicates;
        }
        if (input.max_triples_per_subject !== undefined) {
            exportOptions.maxTriplesPerSubject = input.max_triples_per_subject;
        }
        const documents = exportKnowledgeForRag(context.knowledgeGraph, exportOptions);
        context.logger.info("kg_export", {
            format: "rag_documents",
            total: documents.length,
            min_confidence: input.min_confidence ?? null,
            include_predicates: input.include_predicates ?? null,
            max_triples_per_subject: input.max_triples_per_subject ?? null,
        });
        return { format: "rag_documents", documents, total: documents.length };
    }
    const triples = context.knowledgeGraph.exportAll().map(serializeTriple);
    context.logger.info("kg_export", { format: "triples", total: triples.length });
    return { format: "triples", triples, total: triples.length };
}
/**
 * Clones the documents produced by {@link KnowledgeGraph.exportForRag} so the
 * returned payload is decoupled from the underlying store. This guarantees
 * callers can mutate tags or metadata before piping the documents into
 * `rag_ingest` without corrupting the graph snapshots held in memory.
 */
function exportKnowledgeForRag(knowledgeGraph, options) {
    return knowledgeGraph.exportForRag(options).map((document) => ({
        ...document,
        tags: [...document.tags],
        metadata: { ...document.metadata },
        provenance: [...document.provenance],
    }));
}
/** Generates plan fragments aligned with the stored knowledge graph patterns. */
export async function handleKgSuggestPlan(context, input) {
    // Normalise the optional context without leaking `undefined` properties so
    // the assistant remains compatible with strict optional typing.
    let planContext;
    if (input.context) {
        const overrides = {};
        if (input.context.preferred_sources !== undefined) {
            overrides.preferredSources = input.context.preferred_sources;
        }
        if (input.context.exclude_tasks !== undefined) {
            overrides.excludeTasks = input.context.exclude_tasks;
        }
        if (input.context.max_fragments !== undefined) {
            overrides.maxFragments = input.context.max_fragments;
        }
        if (Object.keys(overrides).length > 0) {
            planContext = overrides;
        }
    }
    const suggestion = suggestPlanFragments(context.knowledgeGraph, {
        goal: input.goal,
        ...(planContext ? { context: planContext } : {}),
    });
    const ragConfig = context.rag;
    const ragDomainTags = normaliseDomainTags([...(ragConfig?.defaultDomainTags ?? [])]);
    const ragMinScore = clampScore(ragConfig?.minScore ?? 0.15);
    let ragEnabled = false;
    let ragQuery;
    if (ragConfig?.getRetriever) {
        const retriever = await ragConfig.getRetriever();
        if (retriever) {
            ragEnabled = true;
            if (needsPlanRagFallback(suggestion)) {
                const fallback = await collectPlanRagFallback({
                    retriever,
                    goal: input.goal,
                    suggestion,
                    domainTags: ragDomainTags,
                    minScore: ragMinScore,
                    preferredSources: input.context?.preferred_sources ?? [],
                    excludedTasks: input.context?.exclude_tasks ?? [],
                });
                ragQuery = fallback.query;
                const coverage = { ...suggestion.coverage, rag_hits: fallback.evidence.length };
                const augmented = {
                    ...suggestion,
                    coverage,
                    rag_evidence: fallback.evidence,
                    rag_query: fallback.query,
                    rag_domain_tags: fallback.domainTags,
                    rag_min_score: fallback.minScore,
                };
                context.logger.info("kg_suggest_plan", {
                    goal: augmented.goal,
                    fragments: augmented.fragments.length,
                    suggested_tasks: augmented.coverage.suggested_tasks.length,
                    preferred_sources_applied: augmented.preferred_sources_applied.length,
                    preferred_sources_ignored: augmented.preferred_sources_ignored.length,
                    rag_enabled: ragEnabled,
                    rag_hits: augmented.coverage.rag_hits,
                    rag_domain_tags: augmented.rag_domain_tags,
                    rag_min_score: augmented.rag_min_score,
                });
                return augmented;
            }
        }
    }
    const coverage = { ...suggestion.coverage, rag_hits: suggestion.coverage.rag_hits ?? 0 };
    const result = { ...suggestion, coverage };
    context.logger.info("kg_suggest_plan", {
        goal: result.goal,
        fragments: result.fragments.length,
        suggested_tasks: result.coverage.suggested_tasks.length,
        preferred_sources_applied: result.preferred_sources_applied.length,
        preferred_sources_ignored: result.preferred_sources_ignored.length,
        rag_enabled: ragEnabled,
        rag_hits: result.coverage.rag_hits,
        rag_domain_tags: ragDomainTags,
        rag_min_score: ragMinScore,
        rag_query_length: ragQuery ? ragQuery.length : 0,
    });
    return result;
}
/** Answers a knowledge query by combining graph facts and optional RAG fallbacks. */
export async function handleKgAssist(context, input) {
    const combinedTags = normaliseDomainTags([
        ...(context.rag?.defaultDomainTags ?? []),
        ...(input.domain_tags ?? []),
    ]);
    const retriever = context.rag?.getRetriever ? await context.rag.getRetriever() : null;
    const resolvedMinScore = Math.max(context.rag?.minScore ?? 0, Number.isFinite(input.min_score) ? input.min_score : 0);
    // Assemble the assist options lazily so optional fields stay omitted when
    // callers leave them blank, keeping strict optional property typing satisfied.
    const assistOptions = {
        query: input.query,
        limit: input.limit,
        ragLimit: Math.max(input.limit, 3),
        ragMinScore: resolvedMinScore,
        domainTags: combinedTags,
        ...(typeof input.context === "string" && input.context.trim().length > 0
            ? { context: input.context }
            : {}),
        ...(retriever ? { ragRetriever: retriever } : {}),
    };
    const result = await assistKnowledgeQuery(context.knowledgeGraph, assistOptions);
    context.logger.info("kg_assist", {
        query_length: input.query.length,
        limit: input.limit,
        min_score: resolvedMinScore,
        domain_tags: combinedTags,
        rag_enabled: Boolean(retriever),
        knowledge_hits: result.knowledge_evidence.length,
        rag_hits: result.rag_evidence.length,
    });
    return result;
}
function serializeTriple(snapshot) {
    return {
        id: snapshot.id,
        subject: snapshot.subject,
        predicate: snapshot.predicate,
        object: snapshot.object,
        source: snapshot.source,
        provenance: normaliseProvenanceList(snapshot.provenance),
        confidence: snapshot.confidence,
        inserted_at: snapshot.insertedAt,
        updated_at: snapshot.updatedAt,
        revision: snapshot.revision,
        ordinal: snapshot.ordinal,
    };
}
/** Determines if the current plan coverage warrants a RAG fallback. */
function needsPlanRagFallback(suggestion) {
    if (suggestion.fragments.length === 0) {
        return true;
    }
    if (suggestion.coverage.missing_dependencies.length > 0) {
        return true;
    }
    if (suggestion.coverage.unknown_dependencies.length > 0) {
        return true;
    }
    return false;
}
const PLAN_RAG_LIMIT = 5;
const PLAN_RAG_SNIPPET_MAX_LENGTH = 220;
/**
 * Executes the retriever to gather complementary passages when the knowledge graph
 * lacks enough structure to build a plan. The query summarises the current
 * coverage and missing dependencies so retrieved snippets stay on topic.
 */
async function collectPlanRagFallback(context) {
    const domainTags = normaliseDomainTags(context.domainTags);
    const minScore = clampScore(context.minScore);
    const query = buildPlanRagQuery(context.goal, context.suggestion, context.preferredSources, context.excludedTasks);
    // Avoid forwarding optional retriever hints when they are absent so strict
    // optional property typing remains satisfied.
    const searchOptions = {
        limit: PLAN_RAG_LIMIT,
        minScore,
        ...(domainTags.length > 0 ? { requiredTags: domainTags } : {}),
    };
    const hits = await context.retriever.search(query, searchOptions);
    if (hits.length === 0) {
        return { evidence: [], query, domainTags, minScore };
    }
    const queryTokens = tokeniseForRag(query);
    const evidence = hits.map((hit) => ({
        id: hit.id,
        text: truncatePlanRagSnippet(hit.text),
        score: roundScore(hit.score),
        vector_score: roundScore(hit.vectorScore),
        lexical_score: roundScore(hit.lexicalScore),
        tags: [...hit.tags],
        matched_tags: [...hit.matchedTags],
        matched_terms: computeMatchedTerms(queryTokens, hit.text),
        provenance: normaliseProvenanceList(hit.provenance),
    }));
    return { evidence, query, domainTags, minScore };
}
/** Builds the retriever query string summarising the plan coverage gap. */
function buildPlanRagQuery(goal, suggestion, preferredSources, excludedTasks) {
    const lines = [];
    lines.push(`Plan recherché : ${goal}`);
    if (suggestion.coverage.suggested_tasks.length > 0) {
        lines.push(`Tâches connues : ${suggestion.coverage.suggested_tasks.join(", ")}`);
    }
    else {
        lines.push("Aucune tâche confirmée dans le graphe.");
    }
    if (suggestion.coverage.missing_dependencies.length > 0) {
        const missing = suggestion.coverage.missing_dependencies
            .map((entry) => `${entry.task} -> ${entry.dependencies.join("/")}`)
            .join(", ");
        lines.push(`Dépendances manquantes : ${missing}`);
    }
    if (suggestion.coverage.unknown_dependencies.length > 0) {
        const unknown = suggestion.coverage.unknown_dependencies
            .map((entry) => `${entry.task} -> ${entry.dependencies.join("/")}`)
            .join(", ");
        lines.push(`Dépendances inconnues : ${unknown}`);
    }
    if (preferredSources.length > 0) {
        lines.push(`Sources privilégiées : ${preferredSources.join(", ")}`);
    }
    if (excludedTasks.length > 0) {
        lines.push(`Tâches exclues : ${excludedTasks.join(", ")}`);
    }
    lines.push("Cherche des étapes structurées et leur justification.");
    return lines.join("\n");
}
/** Tokenises a string for lexical comparisons in RAG fallbacks. */
function tokeniseForRag(text) {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 1);
}
/** Computes matched terms between the query tokens and a candidate passage. */
function computeMatchedTerms(queryTokens, text) {
    if (queryTokens.length === 0) {
        return [];
    }
    const documentTokens = new Set(tokeniseForRag(text));
    const matches = [];
    for (const token of queryTokens) {
        if (documentTokens.has(token)) {
            matches.push(token);
        }
    }
    return Array.from(new Set(matches)).sort();
}
/** Truncates a passage so the summary fits comfortably in tool outputs. */
function truncatePlanRagSnippet(text) {
    const trimmed = text.trim();
    if (trimmed.length <= PLAN_RAG_SNIPPET_MAX_LENGTH) {
        return trimmed;
    }
    const slice = trimmed.slice(0, PLAN_RAG_SNIPPET_MAX_LENGTH - 1);
    return `${slice.trimEnd()}…`;
}
/** Rounds scores to four decimals for deterministic payloads. */
function roundScore(value, decimals = 4) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
/** Clamps cosine similarity thresholds to the inclusive [0, 1] interval. */
function clampScore(value) {
    if (!Number.isFinite(value)) {
        return 0.15;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}
/** Normalises optional domain tags into a deduplicated lowercase list. */
function normaliseDomainTags(raw) {
    if (!raw.length) {
        return [];
    }
    const unique = new Set();
    for (const entry of raw) {
        if (typeof entry !== "string") {
            continue;
        }
        const normalised = entry.trim().toLowerCase();
        if (normalised) {
            unique.add(normalised);
        }
    }
    return Array.from(unique).slice(0, 16);
}
//# sourceMappingURL=knowledgeTools.js.map