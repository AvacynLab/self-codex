import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
const DEFAULT_THRESHOLD = 0.6;
/** Deterministic helper capping a number within the inclusive `[min, max]` range. */
function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    if (value < min)
        return min;
    if (value > max)
        return max;
    return value;
}
/** Normalises an optional severity value to the closed interval `[0, 1]`. */
function normaliseSeverity(severity) {
    if (severity === undefined)
        return 1;
    return clamp(severity, 0, 1);
}
/** Normalises a tolerance value, falling back to a sane default. */
function normaliseTolerance(tolerance) {
    if (tolerance === undefined) {
        return 0.35;
    }
    return clamp(tolerance, 0, 1);
}
/** Normalises the weight associated with a value node. */
function normaliseWeight(weight) {
    if (weight === undefined) {
        return 1;
    }
    const clamped = clamp(weight, 0, Number.POSITIVE_INFINITY);
    return clamped === 0 ? 1 : clamped;
}
/** Normalises relationship weights to the `[0, 1]` interval. */
function normaliseRelationshipWeight(weight) {
    if (weight === undefined) {
        return 0.5;
    }
    return clamp(weight, 0, 1);
}
/** Utility ensuring a map contains a record for the provided key. */
function ensureRecord(map, key, create) {
    const existing = map.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const next = create();
    map.set(key, next);
    return next;
}
/** Internal event channel identifier used by the value graph emitter. */
const VALUE_EVENT = "value_event";
/** Create defensive copies of impacts so emitted events remain immutable. */
function cloneImpacts(impacts) {
    return impacts.map((impact) => ({ ...impact }));
}
/**
 * Produces a defensive copy of correlation hints so downstream listeners cannot
 * mutate the metadata stored alongside emitted events.
 */
function cloneCorrelationHints(hints) {
    if (!hints) {
        return null;
    }
    const clone = {};
    if (hints.runId !== undefined)
        clone.runId = hints.runId ?? null;
    if (hints.opId !== undefined)
        clone.opId = hints.opId ?? null;
    if (hints.jobId !== undefined)
        clone.jobId = hints.jobId ?? null;
    if (hints.graphId !== undefined)
        clone.graphId = hints.graphId ?? null;
    if (hints.nodeId !== undefined)
        clone.nodeId = hints.nodeId ?? null;
    if (hints.childId !== undefined)
        clone.childId = hints.childId ?? null;
    return Object.keys(clone).length > 0 ? clone : null;
}
/**
 * Stores the value definitions declared by operators and exposes scoring
 * utilities to guard plans before launching expensive fan-outs.
 */
export class ValueGraph {
    /** Incremental version incremented on every successful configuration update. */
    version = 0;
    /** Default threshold applied when filtering plans. */
    defaultThreshold = DEFAULT_THRESHOLD;
    /** Normalised nodes keyed by their identifier. */
    nodes = new Map();
    /** Directed adjacency list describing how values influence each other. */
    adjacency = new Map();
    /** Internal event emitter broadcasting value guard telemetry. */
    emitter = new EventEmitter();
    /** Clock used to timestamp emitted events. */
    now;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
    }
    /** Subscribe to value guard events. Returns a disposer unregistering the listener. */
    subscribe(listener) {
        this.emitter.on(VALUE_EVENT, listener);
        return () => {
            this.emitter.off(VALUE_EVENT, listener);
        };
    }
    /** Dispatch an event to every registered listener. */
    emitEvent(event) {
        this.emitter.emit(VALUE_EVENT, event);
    }
    /** Replace the entire graph configuration with the provided specification. */
    set(config) {
        assert(config.values.length > 0, "value graph requires at least one value definition");
        this.nodes.clear();
        this.adjacency.clear();
        for (const value of config.values) {
            assert(value.id.trim().length > 0, "value id must not be empty");
            const id = value.id.trim();
            if (this.nodes.has(id)) {
                throw new Error(`duplicate value id '${id}' in configuration`);
            }
            this.nodes.set(id, {
                id,
                label: value.label?.trim() || undefined,
                description: value.description?.trim() || undefined,
                weight: normaliseWeight(value.weight),
                tolerance: normaliseTolerance(value.tolerance),
            });
        }
        if (config.relationships) {
            for (const relationship of config.relationships) {
                const from = relationship.from.trim();
                const to = relationship.to.trim();
                if (!this.nodes.has(from)) {
                    throw new Error(`relationship source '${from}' is not declared as a value`);
                }
                if (!this.nodes.has(to)) {
                    throw new Error(`relationship target '${to}' is not declared as a value`);
                }
                if (from === to) {
                    continue; // Self-influence does not bring any signal, ignore silently.
                }
                const entry = {
                    from,
                    to,
                    kind: relationship.kind,
                    weight: normaliseRelationshipWeight(relationship.weight),
                };
                if (entry.weight === 0) {
                    continue; // Zero-weight edges would not influence the score anyway.
                }
                const bucket = ensureRecord(this.adjacency, entry.from, () => []);
                bucket.push(entry);
            }
        }
        this.defaultThreshold = clamp(config.defaultThreshold ?? this.defaultThreshold, 0, 1);
        this.version += 1;
        const summary = {
            version: this.version,
            values: this.nodes.size,
            relationships: Array.from(this.adjacency.values()).reduce((acc, list) => acc + list.length, 0),
            default_threshold: this.defaultThreshold,
        };
        this.emitEvent({
            kind: "config_updated",
            at: this.now(),
            summary,
        });
        return summary;
    }
    /**
     * Removes every configured value and relationship, restoring the default
     * threshold. The version counter is incremented so downstream listeners can
     * observe the reset through the emitted configuration event.
     */
    clear() {
        this.nodes.clear();
        this.adjacency.clear();
        this.defaultThreshold = DEFAULT_THRESHOLD;
        this.version += 1;
        const summary = {
            version: this.version,
            values: 0,
            relationships: 0,
            default_threshold: this.defaultThreshold,
        };
        this.emitEvent({
            kind: "config_updated",
            at: this.now(),
            summary,
        });
    }
    /**
     * Produces a serialisable configuration describing the current state of the
     * graph. Returning `null` keeps callers aware that no values have been
     * declared yet.
     */
    exportConfiguration() {
        if (this.nodes.size === 0) {
            return null;
        }
        const values = Array.from(this.nodes.values()).map((node) => ({
            id: node.id,
            label: node.label,
            description: node.description,
            weight: node.weight,
            tolerance: node.tolerance,
        }));
        const relationships = [];
        for (const entries of this.adjacency.values()) {
            for (const relation of entries) {
                relationships.push({
                    from: relation.from,
                    to: relation.to,
                    kind: relation.kind,
                    weight: relation.weight,
                });
            }
        }
        const config = {
            values,
            defaultThreshold: this.defaultThreshold,
        };
        if (relationships.length > 0) {
            config.relationships = relationships;
        }
        return config;
    }
    /**
     * Restores the graph configuration captured via {@link exportConfiguration}.
     * When no configuration is provided the graph falls back to an empty state
     * to avoid leaking values across tests.
     */
    restoreConfiguration(config) {
        if (!config || config.values.length === 0) {
            this.clear();
            return;
        }
        this.set(config);
    }
    /** Retrieve the current default threshold guarding plan execution. */
    getDefaultThreshold() {
        return this.defaultThreshold;
    }
    /** Evaluate the impacts of a plan without applying the threshold. */
    score(input, options = {}) {
        const evaluation = this.evaluatePlan(input);
        const result = {
            score: evaluation.score,
            total: Number(evaluation.totalWeight.toFixed(6)),
            breakdown: evaluation.breakdown,
            violations: evaluation.violations,
        };
        this.emitEvent({
            kind: "plan_scored",
            at: this.now(),
            planId: input.id,
            planLabel: input.label ?? null,
            impacts: cloneImpacts(input.impacts),
            result,
            correlation: cloneCorrelationHints(options.correlation),
        });
        return result;
    }
    /**
     * Evaluate a plan and return whether it satisfies the configured threshold.
     * Violations are preserved in the result so operators can review the
     * contributing impacts when diagnosing a rejection.
     */
    filter(input, options = {}) {
        const evaluation = this.evaluatePlan(input);
        const threshold = clamp(input.threshold ?? this.defaultThreshold, 0, 1);
        const allowed = evaluation.score >= threshold && evaluation.violations.length === 0;
        const decision = {
            score: evaluation.score,
            total: Number(evaluation.totalWeight.toFixed(6)),
            breakdown: evaluation.breakdown,
            violations: evaluation.violations,
            allowed,
            threshold,
        };
        this.emitEvent({
            kind: "plan_filtered",
            at: this.now(),
            planId: input.id,
            planLabel: input.label ?? null,
            impacts: cloneImpacts(input.impacts),
            decision,
            correlation: cloneCorrelationHints(options.correlation),
        });
        return decision;
    }
    /**
     * Provides a human readable explanation for each violation. The returned
     * payload mirrors the filtering decision and adds actionable hints so
     * operators can quickly identify the dominant risk contributors.
     */
    explain(input, options = {}) {
        const evaluation = this.evaluatePlan(input);
        const threshold = clamp(input.threshold ?? this.defaultThreshold, 0, 1);
        const allowed = evaluation.score >= threshold && evaluation.violations.length === 0;
        const decision = {
            score: evaluation.score,
            total: Number(evaluation.totalWeight.toFixed(6)),
            breakdown: evaluation.breakdown,
            violations: evaluation.violations,
            allowed,
            threshold,
        };
        const violations = this.buildViolationInsights(decision, evaluation);
        const result = { decision, violations };
        this.emitEvent({
            kind: "plan_explained",
            at: this.now(),
            planId: input.id,
            planLabel: input.label ?? null,
            impacts: cloneImpacts(input.impacts),
            result,
            correlation: cloneCorrelationHints(options.correlation),
        });
        return result;
    }
    /** Compute the full evaluation for a plan, including intermediate metrics. */
    evaluatePlan(input) {
        const perValue = new Map();
        for (const node of this.nodes.values()) {
            perValue.set(node.id, { node, support: 0, risk: 0, contributions: [] });
        }
        const unknownImpacts = [];
        const recordContribution = (targetId, contribution) => {
            const bucket = perValue.get(targetId);
            if (!bucket) {
                unknownImpacts.push(contribution.impact);
                return;
            }
            if (contribution.type === "support") {
                bucket.support += contribution.amount;
            }
            else {
                bucket.risk += contribution.amount;
            }
            bucket.contributions.push(contribution);
        };
        for (const impact of input.impacts) {
            const severity = normaliseSeverity(impact.severity);
            const node = this.nodes.get(impact.value);
            if (!node) {
                unknownImpacts.push(impact);
                continue;
            }
            const amount = node.weight * severity;
            recordContribution(node.id, { type: impact.impact, amount, impact });
            const neighbours = this.adjacency.get(node.id);
            if (!neighbours?.length) {
                continue;
            }
            for (const relation of neighbours) {
                const propagatedAmount = amount * relation.weight;
                const propagatedType = this.resolvePropagatedType(impact.impact, relation.kind);
                recordContribution(relation.to, {
                    type: propagatedType,
                    amount: propagatedAmount,
                    impact,
                    propagatedFrom: node.id,
                    relationKind: relation.kind,
                });
            }
        }
        let totalWeight = 0;
        let weightedScoreSum = 0;
        const breakdown = [];
        const violations = [];
        for (const bucket of perValue.values()) {
            const { node, support, risk, contributions } = bucket;
            const mitigatedRisk = Math.max(0, risk - support);
            const satisfaction = node.weight === 0 ? 1 : 1 - clamp(mitigatedRisk / node.weight, 0, 1);
            totalWeight += node.weight;
            weightedScoreSum += satisfaction * node.weight;
            breakdown.push({
                value: node.id,
                weight: Number(node.weight.toFixed(6)),
                support: Number(support.toFixed(6)),
                risk: Number(risk.toFixed(6)),
                residual: Number(mitigatedRisk.toFixed(6)),
                satisfaction: Number(satisfaction.toFixed(6)),
            });
            const severityRatio = node.weight === 0 ? 0 : mitigatedRisk / node.weight;
            if (severityRatio > node.tolerance + 1e-6) {
                violations.push({
                    value: node.id,
                    severity: Number(severityRatio.toFixed(6)),
                    tolerance: node.tolerance,
                    message: `residual risk ${severityRatio.toFixed(2)} exceeds tolerance ${node.tolerance.toFixed(2)}`,
                    contributors: contributions.map((entry) => ({
                        impact: entry.impact,
                        amount: Number(entry.amount.toFixed(6)),
                        type: entry.type,
                        propagated: entry.propagatedFrom !== undefined,
                        via: entry.relationKind,
                        from: entry.propagatedFrom,
                    })),
                });
            }
        }
        for (const impact of unknownImpacts) {
            violations.push({
                value: impact.value,
                severity: 1,
                tolerance: 0,
                message: `referenced value '${impact.value}' is not declared in the graph`,
                contributors: [
                    {
                        impact,
                        amount: 1,
                        type: "risk",
                        propagated: false,
                    },
                ],
            });
        }
        const score = totalWeight === 0 ? 1 : clamp(weightedScoreSum / totalWeight, 0, 1);
        return {
            perValue,
            breakdown,
            violations,
            score,
            totalWeight,
        };
    }
    /** Builds enriched violation payloads suitable for MCP responses. */
    buildViolationInsights(decision, evaluation) {
        const insights = [];
        for (const violation of decision.violations) {
            const dominant = this.pickDominantContributor(violation.contributors);
            const bucket = evaluation.perValue.get(violation.value);
            const nodeLabel = bucket?.node.label ?? null;
            const nodeId = dominant?.impact.nodeId ?? null;
            const hint = this.composeHint(violation, dominant, nodeLabel);
            insights.push({
                ...violation,
                nodeId,
                nodeLabel,
                hint,
                primaryContributor: dominant ?? null,
            });
        }
        return insights;
    }
    /** Selects the dominant risk contribution driving a violation. */
    pickDominantContributor(contributors) {
        let candidate = null;
        for (const entry of contributors) {
            if (entry.type !== "risk") {
                continue;
            }
            if (!candidate || entry.amount > candidate.amount) {
                candidate = entry;
            }
        }
        return candidate;
    }
    /**
     * Generates a human readable hint summarising why the violation triggered and
     * how operators could mitigate it.
     */
    composeHint(violation, dominant, nodeLabel) {
        const severityPercent = (violation.severity * 100).toFixed(1);
        const tolerancePercent = (violation.tolerance * 100).toFixed(1);
        const base = `Residual risk ${severityPercent}% exceeds tolerance ${tolerancePercent}% for value '${violation.value}'.`;
        if (violation.message.includes("not declared")) {
            return `${base} Declare the missing value in the graph or remove the unknown impact.`;
        }
        if (!dominant) {
            return `${base} Review the contributing impacts to restore compliance.`;
        }
        const origin = dominant.propagated
            ? `Risk propagated from value '${dominant.from ?? "unknown"}'` + (dominant.via ? ` via ${dominant.via}` : "")
            : "Direct risk impact";
        const location = dominant.impact.nodeId
            ? `on plan node '${dominant.impact.nodeId}'`
            : "within the evaluated plan";
        const rationale = dominant.impact.rationale ?? dominant.impact.source ?? `impact '${dominant.impact.value}'`;
        const labelPart = nodeLabel ? ` (value label: ${nodeLabel})` : "";
        return `${base}${labelPart} ${origin} ${location}: ${rationale}. Mitigate or reduce this contribution to pass the guard.`;
    }
    /** Derive the propagated contribution type from the original impact. */
    resolvePropagatedType(impact, relation) {
        if (relation === "supports") {
            return impact;
        }
        return impact === "support" ? "risk" : "support";
    }
}
//# sourceMappingURL=valueGraph.js.map