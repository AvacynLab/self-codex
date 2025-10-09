import { cloneCorrelationHints, extractCorrelationHints, mergeCorrelationHints, } from "./correlation.js";
/**
 * Normalises the provided correlation sources and synthesises a single record
 * that contains the identifiers expected by the unified event bus.
 */
function buildCorrelationHints(options) {
    const hints = {};
    mergeCorrelationHints(hints, { childId: options.childId });
    if (options.jobId !== undefined) {
        mergeCorrelationHints(hints, { jobId: options.jobId ?? null });
    }
    for (const source of options.sources ?? []) {
        if (!source) {
            continue;
        }
        mergeCorrelationHints(hints, extractCorrelationHints(source));
    }
    return hints;
}
/**
 * Build structured events describing the meta-review (and optional self
 * reflection) performed after a `child_collect` invocation. The helper keeps
 * payloads compact yet informative so downstream MCP clients can surface
 * actionable telemetry without reimplementing the orchestrator logic.
 */
export function buildChildCognitiveEvents(options) {
    const baseCorrelation = buildCorrelationHints({
        childId: options.childId,
        jobId: options.jobId,
        sources: options.correlationSources,
    });
    const sharedEnvelope = {
        kind: "COGNITIVE",
        level: "info",
        childId: options.childId,
        jobId: options.jobId ?? null,
    };
    const basePayloadFields = {
        child_id: options.childId,
        job_id: options.jobId ?? null,
        run_id: baseCorrelation.runId ?? null,
        op_id: baseCorrelation.opId ?? null,
        graph_id: baseCorrelation.graphId ?? null,
        node_id: baseCorrelation.nodeId ?? null,
    };
    const reviewPayload = {
        ...basePayloadFields,
        msg: "child_meta_review",
        summary: {
            kind: options.summary.kind,
            text: options.summary.text,
            tags: [...options.summary.tags],
        },
        review: {
            overall: options.review.overall,
            verdict: options.review.verdict,
            feedback: [...options.review.feedback],
            suggestions: [...options.review.suggestions],
            breakdown: options.review.breakdown.map((entry) => ({ ...entry })),
        },
        metrics: {
            artifacts: options.artifactCount,
            messages: options.messageCount,
        },
        quality_assessment: options.quality
            ? {
                kind: options.quality.kind,
                score: options.quality.score,
                rubric: { ...options.quality.rubric },
                metrics: { ...options.quality.metrics },
                gate: { ...options.quality.gate },
            }
            : null,
    };
    const reviewEvent = {
        ...sharedEnvelope,
        payload: reviewPayload,
        correlation: cloneCorrelationHints(baseCorrelation),
    };
    let reflectionEvent = null;
    if (options.reflection) {
        const reflectionPayload = {
            ...basePayloadFields,
            msg: "child_reflection",
            summary: {
                kind: options.summary.kind,
                text: options.summary.text,
                tags: [...options.summary.tags],
            },
            reflection: {
                insights: [...options.reflection.insights],
                next_steps: [...options.reflection.nextSteps],
                risks: [...options.reflection.risks],
            },
        };
        reflectionEvent = {
            ...sharedEnvelope,
            payload: reflectionPayload,
            correlation: cloneCorrelationHints(baseCorrelation),
        };
    }
    return { review: reviewEvent, reflection: reflectionEvent };
}
//# sourceMappingURL=cognitive.js.map