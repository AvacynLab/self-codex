import { strict as assert } from "node:assert";
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
/**
 * Stores the value definitions declared by operators and exposes scoring
 * utilities to guard plans before launching expensive fan-outs.
 */
export class ValueGraph {
    /** Incremental version incremented on every successful configuration update. */
    version = 0;
    /** Default threshold applied when filtering plans. */
    defaultThreshold = 0.6;
    /** Normalised nodes keyed by their identifier. */
    nodes = new Map();
    /** Directed adjacency list describing how values influence each other. */
    adjacency = new Map();
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
        return {
            version: this.version,
            values: this.nodes.size,
            relationships: Array.from(this.adjacency.values()).reduce((acc, list) => acc + list.length, 0),
            default_threshold: this.defaultThreshold,
        };
    }
    /** Retrieve the current default threshold guarding plan execution. */
    getDefaultThreshold() {
        return this.defaultThreshold;
    }
    /** Evaluate the impacts of a plan without applying the threshold. */
    score(input) {
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
            const satisfaction = node.weight === 0
                ? 1
                : 1 - clamp(mitigatedRisk / node.weight, 0, 1);
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
                    },
                ],
            });
        }
        const score = totalWeight === 0 ? 1 : clamp(weightedScoreSum / totalWeight, 0, 1);
        return {
            score,
            total: Number(totalWeight.toFixed(6)),
            breakdown,
            violations,
        };
    }
    /**
     * Evaluate a plan and return whether it satisfies the configured threshold.
     * Violations are preserved in the result so operators can review the
     * contributing impacts when diagnosing a rejection.
     */
    filter(input) {
        const score = this.score(input);
        const threshold = clamp(input.threshold ?? this.defaultThreshold, 0, 1);
        const allowed = score.score >= threshold && score.violations.length === 0;
        return { ...score, allowed, threshold };
    }
    /** Derive the propagated contribution type from the original impact. */
    resolvePropagatedType(impact, relation) {
        if (relation === "supports") {
            return impact;
        }
        return impact === "support" ? "risk" : "support";
    }
}
