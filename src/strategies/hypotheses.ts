import { randomUUID } from "crypto";

/**
 * Descriptor for a single step in a plan hypothesis. Every step keeps basic
 * metadata so the strategy module can reason about novelty, risk and effort
 * without inspecting external structures.
 */
export interface PlanStep {
  id: string;
  summary: string;
  effort: number;
  risk: number;
  domain?: string;
  tags?: string[];
}

/** Blueprint describing how a divergence should transform the base plan. */
export interface DivergenceDescriptor {
  id: string;
  description: string;
  emphasis?: "speed" | "quality" | "explore";
  addSteps?: PlanStep[];
  removeStepIds?: string[];
  adjustEffortFactor?: number;
  adjustRiskFactor?: number;
}

/** Input describing the base plan and candidate divergences. */
export interface HypothesisSeed {
  objective: string;
  basePlan: PlanStep[];
  divergences: DivergenceDescriptor[];
}

/** Structure returned for each generated hypothesis. */
export interface PlanHypothesis {
  id: string;
  label: string;
  steps: PlanStep[];
  novelty: number;
  risk: number;
  effort: number;
  rationale: string[];
  score?: number;
}

/** Options used when generating hypotheses. */
export interface HypothesisGenerationOptions {
  maxHypotheses?: number;
  noveltyBoost?: number;
}

/** Options used when evaluating hypotheses. */
export interface HypothesisEvaluationOptions {
  noveltyWeight?: number;
  riskWeight?: number;
  effortWeight?: number;
  coverageWeight?: number;
}

/**
 * Result of the convergence step. The orchestrator obtains the fused plan,
 * rationales and the identifiers of the hypotheses that influenced the result.
 */
export interface HypothesisConvergenceResult {
  fusedPlan: PlanStep[];
  selectedHypotheses: PlanHypothesis[];
  rationale: string[];
}

const DEFAULT_GENERATION_OPTIONS: Required<Pick<HypothesisGenerationOptions, "maxHypotheses" | "noveltyBoost">> = {
  maxHypotheses: 5,
  noveltyBoost: 0.15,
};

const DEFAULT_EVALUATION_OPTIONS: Required<
  Pick<HypothesisEvaluationOptions, "noveltyWeight" | "riskWeight" | "effortWeight" | "coverageWeight">
> = {
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
export function generateHypotheses(
  seed: HypothesisSeed,
  options: HypothesisGenerationOptions = {},
): PlanHypothesis[] {
  const mergedOptions = { ...DEFAULT_GENERATION_OPTIONS, ...options };
  const hypotheses: PlanHypothesis[] = [];

  const baseHypothesis: PlanHypothesis = {
    id: `base-${randomUUID()}`,
    label: "baseline",
    steps: cloneSteps(seed.basePlan),
    novelty: 0,
    risk: average(seed.basePlan.map((step) => step.risk)) ?? 0,
    effort: total(seed.basePlan.map((step) => step.effort)) ?? 0,
    rationale: ["Plan de base fourni par l'orchestrateur."],
  };
  hypotheses.push(baseHypothesis);

  for (const divergence of seed.divergences) {
    const derived = applyDivergence(seed.basePlan, divergence, mergedOptions.noveltyBoost);
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
export function evaluateHypotheses(
  hypotheses: PlanHypothesis[],
  basePlan: PlanStep[],
  options: HypothesisEvaluationOptions = {},
): PlanHypothesis[] {
  const mergedOptions = { ...DEFAULT_EVALUATION_OPTIONS, ...options };
  const baseStepIds = new Set(basePlan.map((step) => step.id));

  return hypotheses
    .map((hypothesis) => {
      const coverage = computeCoverage(hypothesis.steps, baseStepIds);
      const normalisedRisk = normalise(hypothesis.risk);
      const normalisedEffort = normalise(hypothesis.effort);
      const score =
        mergedOptions.noveltyWeight * clamp01(hypothesis.novelty) +
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
export function convergeHypotheses(
  ranked: PlanHypothesis[],
  options: { maxSelected?: number } = {},
): HypothesisConvergenceResult {
  const maxSelected = options.maxSelected ?? Math.min(3, ranked.length);
  const selected = ranked.slice(0, maxSelected);
  const seen = new Set<string>();
  const fused: PlanStep[] = [];

  for (const hypothesis of selected) {
    for (const step of hypothesis.steps) {
      if (seen.has(step.id)) {
        continue;
      }
      fused.push({ ...step });
      seen.add(step.id);
    }
  }

  const rationale = selected.flatMap((hypothesis) => [
    `Hypothèse ${hypothesis.label}: ${hypothesis.rationale.join(" ")}`,
  ]);

  return {
    fusedPlan: fused,
    selectedHypotheses: selected,
    rationale,
  };
}

function applyDivergence(
  basePlan: PlanStep[],
  divergence: DivergenceDescriptor,
  noveltyBoost: number,
): PlanHypothesis {
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

  const rationale: string[] = [
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

function cloneSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) => ({ ...step, tags: step.tags ? [...step.tags] : undefined }));
}

function computeCoverage(steps: PlanStep[], baseIds: Set<string>): number {
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

function computeNovelty(
  basePlan: PlanStep[],
  derived: PlanStep[],
  emphasis: DivergenceDescriptor["emphasis"],
): number {
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
  } else if (emphasis === "quality") {
    novelty += 0.1;
  }
  return clamp01(novelty);
}

function average(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function total(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((acc, value) => acc + value, 0);
}

function normalise(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp01(value / 10);
}

function clampToPositive(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
