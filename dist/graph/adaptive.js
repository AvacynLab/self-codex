import { applyAll, createInlineSubgraphRule, createRerouteAvoidRule, createSplitParallelRule } from "./rewrite.js";
const DEFAULT_OPTIONS = {
    targetDurationMs: 2_000,
    successWeight: 0.6,
    durationWeight: 0.3,
    rewardWeight: 0.1,
    minSamplesForConfidence: 3,
    decayMs: 10 * 60_000,
    boostThreshold: 0.65,
    pruneThreshold: 0.25,
};
/** Creates an empty adaptive state. */
export function createAdaptiveGraphState() {
    return { edges: new Map() };
}
/**
 * Records the outcome of a path execution inside the adaptive state. The
 * duration and reward are evenly distributed across the traversed edges to keep
 * the scoring logic simple and deterministic.
 */
export function recordPathOutcome(state, outcome) {
    if (outcome.path.length < 2) {
        return;
    }
    const timestamp = outcome.timestamp ?? Date.now();
    const edgeCount = outcome.path.length - 1;
    const durationPerEdge = outcome.durationMs / edgeCount;
    const rewardPerEdge = (outcome.reward ?? (outcome.success ? 1 : 0)) / edgeCount;
    for (let index = 0; index < outcome.path.length - 1; index += 1) {
        const from = outcome.path[index];
        const to = outcome.path[index + 1];
        const key = edgeKey(from, to);
        const existing = state.edges.get(key);
        const attempts = (existing?.successes ?? 0) + (existing?.failures ?? 0);
        const nextMetrics = existing
            ? {
                successes: existing.successes + (outcome.success ? 1 : 0),
                failures: existing.failures + (outcome.success ? 0 : 1),
                totalDurationMs: existing.totalDurationMs + durationPerEdge,
                totalReward: existing.totalReward + rewardPerEdge,
                lastUpdatedAt: timestamp,
            }
            : {
                successes: outcome.success ? 1 : 0,
                failures: outcome.success ? 0 : 1,
                totalDurationMs: durationPerEdge,
                totalReward: rewardPerEdge,
                lastUpdatedAt: timestamp,
            };
        // Guard against pathological NaN/Infinity propagations when we receive
        // inconsistent telemetry by defaulting to the previous totals.
        if (!Number.isFinite(nextMetrics.totalDurationMs)) {
            nextMetrics.totalDurationMs = existing?.totalDurationMs ?? 0;
        }
        if (!Number.isFinite(nextMetrics.totalReward)) {
            nextMetrics.totalReward = existing?.totalReward ?? 0;
        }
        if (attempts === 0 && !Number.isFinite(nextMetrics.totalDurationMs)) {
            nextMetrics.totalDurationMs = 0;
        }
        state.edges.set(key, nextMetrics);
    }
}
/**
 * Computes reinforcement insights for every edge of the provided graph using
 * the stored adaptive metrics.
 */
export function evaluateAdaptiveGraph(graph, state, options = {}) {
    const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
    const now = options.now ?? Date.now();
    const insights = [];
    const edgesToPrune = [];
    const edgesToBoost = [];
    for (const edge of graph.edges) {
        const key = edgeKey(edge.from, edge.to);
        const metrics = state.edges.get(key);
        if (!metrics) {
            // Without telemetry we keep the edge neutral to avoid destructive
            // pruning. The caller can decide how to handle missing signals.
            insights.push({
                edgeKey: key,
                reinforcement: 0,
                confidence: 0,
                recommendation: "keep",
                metrics: {
                    successes: 0,
                    failures: 0,
                    totalDurationMs: 0,
                    totalReward: 0,
                    lastUpdatedAt: 0,
                    attempts: 0,
                    successRate: 0,
                    averageDurationMs: Number.POSITIVE_INFINITY,
                },
            });
            continue;
        }
        const attempts = metrics.successes + metrics.failures;
        const successRate = attempts === 0 ? 0 : metrics.successes / attempts;
        const averageDurationMs = attempts === 0 ? Number.POSITIVE_INFINITY : metrics.totalDurationMs / attempts;
        const rewardAverage = attempts === 0 ? 0 : metrics.totalReward / attempts;
        const confidence = Math.min(1, attempts / mergedOptions.minSamplesForConfidence);
        const decayFactor = computeDecayFactor(metrics.lastUpdatedAt, now, mergedOptions.decayMs);
        const durationTerm = 1 - Math.min(1, averageDurationMs / mergedOptions.targetDurationMs);
        const rewardTerm = Math.min(1, Math.max(0, rewardAverage));
        const reinforcementRaw = mergedOptions.successWeight * successRate +
            mergedOptions.durationWeight * durationTerm +
            mergedOptions.rewardWeight * rewardTerm;
        const reinforcement = clamp01(reinforcementRaw * confidence * decayFactor);
        const recommendation = reinforcement >= mergedOptions.boostThreshold
            ? "boost"
            : reinforcement <= mergedOptions.pruneThreshold
                ? "prune"
                : "keep";
        if (recommendation === "prune") {
            edgesToPrune.push(key);
        }
        else if (recommendation === "boost") {
            edgesToBoost.push(key);
        }
        insights.push({
            edgeKey: key,
            reinforcement,
            confidence,
            recommendation,
            metrics: {
                ...metrics,
                attempts,
                successRate,
                averageDurationMs,
            },
        });
    }
    // Keep the output stable for deterministic tests and audit logs.
    insights.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
    edgesToPrune.sort();
    edgesToBoost.sort();
    return { insights, edgesToPrune, edgesToBoost };
}
/**
 * Applies pruning recommendations by returning a new graph descriptor with the
 * weak edges removed. The original graph is not mutated so callers can inspect
 * the delta before committing to the change.
 */
export function pruneWeakBranches(graph, evaluation) {
    const edgesToRemove = new Set(evaluation.edgesToPrune);
    let removedEdges = 0;
    const retainedEdges = graph.edges.filter((edge) => {
        const shouldRemove = edgesToRemove.has(edgeKey(edge.from, edge.to));
        if (shouldRemove) {
            removedEdges += 1;
        }
        return !shouldRemove;
    });
    // Keep the structure immutable while ensuring repeated pruning rounds are
    // idempotent: once the weak edges disappeared we simply retain the current
    // version number so subsequent passes do not drift.
    return {
        ...graph,
        edges: removedEdges > 0 ? retainedEdges : [...graph.edges],
        graphVersion: graph.graphVersion + (removedEdges > 0 ? 1 : 0),
    };
}
/**
 * Builds a map of weight multipliers that can be applied to the graph when the
 * orchestrator wants to bias path-finding algorithms towards reinforced edges.
 */
export function deriveWeightMultipliers(evaluation, options = {}) {
    const boostMultiplier = options.boostMultiplier ?? 1.2;
    const baseMultiplier = options.baseMultiplier ?? 1;
    const pruneMultiplier = options.pruneMultiplier ?? 0.5;
    const multipliers = new Map();
    for (const insight of evaluation.insights) {
        const multiplier = insight.recommendation === "boost"
            ? boostMultiplier
            : insight.recommendation === "prune"
                ? pruneMultiplier
                : baseMultiplier;
        multipliers.set(insight.edgeKey, multiplier);
    }
    return multipliers;
}
/**
 * Apply the default rewrite rules using the adaptive evaluation outcome as a
 * signal to decide which branches should be transformed.
 */
export function applyAdaptiveRewrites(graph, evaluation, options = {}) {
    const boostTargets = new Set(evaluation.edgesToBoost);
    const pruneTargets = new Set();
    for (const key of evaluation.edgesToPrune) {
        const [, target] = key.split("→");
        if (target) {
            pruneTargets.add(target);
        }
    }
    const avoidLabels = options.avoidLabels ? new Set(options.avoidLabels) : undefined;
    const baseRules = [];
    if (boostTargets.size > 0) {
        baseRules.push(createSplitParallelRule(boostTargets));
    }
    else {
        baseRules.push(createSplitParallelRule());
    }
    baseRules.push(createInlineSubgraphRule());
    baseRules.push(createRerouteAvoidRule({
        avoidNodeIds: pruneTargets.size > 0 ? pruneTargets : undefined,
        avoidLabels,
    }));
    const rules = baseRules.concat(options.additionalRules ?? []);
    return applyAll(graph, rules, options.stopOnNoChange ?? true);
}
function edgeKey(from, to) {
    return `${from}→${to}`;
}
function clamp01(value) {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}
function computeDecayFactor(lastUpdatedAt, now, decayMs) {
    if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt <= 0) {
        return 0.5;
    }
    if (!Number.isFinite(decayMs) || decayMs <= 0) {
        return 1;
    }
    const elapsed = Math.max(0, now - lastUpdatedAt);
    if (elapsed === 0) {
        return 1;
    }
    const halfLives = elapsed / decayMs;
    return Math.pow(0.5, halfLives);
}
//# sourceMappingURL=adaptive.js.map