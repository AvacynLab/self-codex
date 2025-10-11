import { randomUUID } from "node:crypto";
const DEFAULT_GENERATION_OPTIONS = {
    maxHypotheses: 5,
    noveltyBoost: 0.15,
};
const DEFAULT_EVALUATION_OPTIONS = {
    noveltyWeight: 0.35,
    riskWeight: 0.25,
    effortWeight: 0.2,
    coverageWeight: 0.2,
};
/**
 * Generates deterministic plan hypotheses by applying the provided divergences
 * to the base plan. The more disruptive a divergence is, the higher its novelty
 * score will be.
 */
export function generateHypotheses(seed, options = {}) {
    const mergedOptions = { ...DEFAULT_GENERATION_OPTIONS, ...options };
    const hypotheses = [];
    const fingerprints = new Set();
    const baseHypothesis = {
        id: `base-${randomUUID()}`,
        label: "baseline",
        steps: cloneSteps(seed.basePlan),
        novelty: 0,
        risk: average(seed.basePlan.map((step) => step.risk)) ?? 0,
        effort: total(seed.basePlan.map((step) => step.effort)) ?? 0,
        rationale: ["Plan de base fourni par l'orchestrateur."],
    };
    fingerprints.add(fingerprintSteps(baseHypothesis.steps));
    hypotheses.push(baseHypothesis);
    for (const divergence of seed.divergences) {
        const derived = applyDivergence(seed.basePlan, divergence, mergedOptions.noveltyBoost);
        const signature = fingerprintSteps(derived.steps);
        if (fingerprints.has(signature)) {
            // Ignore divergences that do not materially change the plan to ensure we
            // only surface distinct alternatives to the orchestrator.
            continue;
        }
        fingerprints.add(signature);
        hypotheses.push(derived);
        if (hypotheses.length >= mergedOptions.maxHypotheses) {
            break;
        }
    }
    return hypotheses;
}
/**
 * Computes a score for every hypothesis based on novelty, risk, effort and
 * coverage (ratio of base steps still present). Higher novelty increases the
 * score whereas high risk/effort penalise the hypothesis.
 */
export function evaluateHypotheses(hypotheses, basePlan, options = {}) {
    const mergedOptions = { ...DEFAULT_EVALUATION_OPTIONS, ...options };
    const baseStepIds = new Set(basePlan.map((step) => step.id));
    return hypotheses
        .map((hypothesis) => {
        const coverage = computeCoverage(hypothesis.steps, baseStepIds);
        const normalisedRisk = normalise(hypothesis.risk);
        const normalisedEffort = normalise(hypothesis.effort);
        const score = mergedOptions.noveltyWeight * clamp01(hypothesis.novelty) +
            mergedOptions.coverageWeight * coverage +
            mergedOptions.riskWeight * (1 - normalisedRisk) +
            mergedOptions.effortWeight * (1 - normalisedEffort);
        return { ...hypothesis, score };
    })
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}
/**
 * Selects the top hypotheses and produces a fused plan by merging unique steps
 * while preserving their original ordering as much as possible.
 */
export function convergeHypotheses(ranked, options = {}) {
    const maxSelected = options.maxSelected ?? Math.min(3, ranked.length);
    const selected = ranked.slice(0, maxSelected);
    const seen = new Map();
    selected.forEach((hypothesis, hypothesisIndex) => {
        hypothesis.steps.forEach((step, stepIndex) => {
            const existing = seen.get(step.id);
            const score = hypothesisIndex * 1_000 + stepIndex;
            if (!existing || score < existing.score) {
                // Copy the step so subsequent reasoning phases can safely mutate the
                // fused plan without altering historical hypotheses.
                seen.set(step.id, { step: { ...step, tags: step.tags ? [...step.tags] : undefined }, score });
            }
        });
    });
    const fused = [...seen.values()]
        .sort((left, right) => left.score - right.score)
        .map((entry) => entry.step);
    const rationale = selected.flatMap((hypothesis) => [
        `Hypothèse ${hypothesis.label}: ${hypothesis.rationale.join(" ")}`,
    ]);
    return {
        fusedPlan: fused,
        selectedHypotheses: selected,
        rationale,
    };
}
function fingerprintSteps(steps) {
    return steps
        .map((step) => [
        step.id,
        step.summary,
        step.domain ?? "",
        step.effort,
        step.risk,
        ...(step.tags ?? []),
    ].join("|"))
        .join("→");
}
function applyDivergence(basePlan, divergence, noveltyBoost) {
    const removed = new Set(divergence.removeStepIds ?? []);
    const steps = basePlan
        .filter((step) => !removed.has(step.id))
        .map((step) => ({ ...step }));
    for (const addition of divergence.addSteps ?? []) {
        steps.push({ ...addition });
    }
    const riskFactor = divergence.adjustRiskFactor ?? 1;
    const effortFactor = divergence.adjustEffortFactor ?? 1;
    for (const step of steps) {
        step.risk = clampToPositive(step.risk * riskFactor);
        step.effort = clampToPositive(step.effort * effortFactor);
    }
    const novelty = computeNovelty(basePlan, steps, divergence.emphasis) + noveltyBoost;
    const risk = average(steps.map((step) => step.risk)) ?? 0;
    const effort = total(steps.map((step) => step.effort)) ?? 0;
    const rationale = [
        `Divergence ${divergence.id}: ${divergence.description}`,
    ];
    if (divergence.emphasis) {
        rationale.push(`Mise en avant: ${divergence.emphasis}.`);
    }
    if (divergence.addSteps && divergence.addSteps.length > 0) {
        rationale.push(`Ajout de ${divergence.addSteps.length} étapes.`);
    }
    if (removed.size > 0) {
        rationale.push(`Suppression de ${removed.size} étapes.`);
    }
    return {
        id: divergence.id,
        label: divergence.description,
        steps,
        novelty,
        risk,
        effort,
        rationale,
    };
}
function cloneSteps(steps) {
    return steps.map((step) => ({ ...step, tags: step.tags ? [...step.tags] : undefined }));
}
function computeCoverage(steps, baseIds) {
    if (baseIds.size === 0) {
        return 1;
    }
    let covered = 0;
    for (const step of steps) {
        if (baseIds.has(step.id)) {
            covered += 1;
        }
    }
    return covered / baseIds.size;
}
function computeNovelty(basePlan, derived, emphasis) {
    const baseIds = new Set(basePlan.map((step) => step.id));
    let delta = 0;
    for (const step of derived) {
        if (!baseIds.has(step.id)) {
            delta += 1;
        }
    }
    const baseTotal = basePlan.length || 1;
    let novelty = delta / baseTotal;
    if (emphasis === "explore") {
        novelty += 0.2;
    }
    else if (emphasis === "quality") {
        novelty += 0.1;
    }
    return clamp01(novelty);
}
function average(values) {
    if (values.length === 0) {
        return undefined;
    }
    const sum = values.reduce((acc, value) => acc + value, 0);
    return sum / values.length;
}
function total(values) {
    if (values.length === 0) {
        return undefined;
    }
    return values.reduce((acc, value) => acc + value, 0);
}
function normalise(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return clamp01(value / 10);
}
function clampToPositive(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, value);
}
function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}
//# sourceMappingURL=hypotheses.js.map