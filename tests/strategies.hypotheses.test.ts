import { describe, it } from "mocha";
import { expect } from "chai";

import {
  HypothesisConvergenceResult,
  PlanHypothesis,
  PlanStep,
  convergeHypotheses,
  evaluateHypotheses,
  generateHypotheses,
} from "../src/strategies/hypotheses.js";

describe("strategies.hypotheses", () => {
  const basePlan: PlanStep[] = [
    { id: "analyse", summary: "Analyser le besoin", effort: 2, risk: 0.3, domain: "analysis", tags: ["analysis"] },
    { id: "design", summary: "Proposer design", effort: 3, risk: 0.4, domain: "design", tags: ["design"] },
    { id: "implement", summary: "Implémenter", effort: 5, risk: 0.6, domain: "dev", tags: ["delivery"] },
  ];

  it("generates diversified hypotheses and scores them", () => {
    const hypotheses = generateHypotheses(
      {
        objective: "Livrer une fonctionnalité",
        basePlan,
        divergences: [
          {
            id: "quality",
            description: "Accent sur la qualité",
            emphasis: "quality",
            addSteps: [
              { id: "tests", summary: "Renforcer les tests", effort: 2, risk: 0.2, domain: "qa", tags: ["quality"] },
            ],
            adjustRiskFactor: 0.9,
          },
          {
            id: "explore",
            description: "Explorer alternatives",
            emphasis: "explore",
            addSteps: [
              { id: "benchmark", summary: "Comparer solutions", effort: 1, risk: 0.3, domain: "research", tags: ["explore"] },
            ],
            removeStepIds: ["design"],
            adjustEffortFactor: 0.8,
          },
        ],
      },
      { maxHypotheses: 4 },
    );

    expect(hypotheses).to.have.length(3);
    const labels = hypotheses.map((hypothesis) => hypothesis.label);
    expect(labels).to.include("baseline");
    expect(labels).to.include("Accent sur la qualité");
    expect(labels).to.include("Explorer alternatives");

    const ranked = evaluateHypotheses(hypotheses, basePlan, { noveltyWeight: 0.4, coverageWeight: 0.3 });
    expect(ranked[0].score).to.be.greaterThan(ranked[1].score ?? 0);
    const hasExploration = ranked.some((hypothesis) => hypothesis.label === "Explorer alternatives" && (hypothesis.score ?? 0) > 0.5);
    expect(hasExploration).to.equal(true);
  });

  it("ignore les overrides undefined pour conserver les poids et bonus par défaut", () => {
    const hypotheses = generateHypotheses(
      {
        objective: "Livrer une fonctionnalité",
        basePlan,
        divergences: [
          {
            id: "quality",
            description: "Accent sur la qualité",
            emphasis: "quality",
            addSteps: [
              { id: "tests", summary: "Renforcer les tests", effort: 2, risk: 0.2, domain: "qa", tags: ["quality"] },
            ],
          },
          {
            id: "explore",
            description: "Explorer alternatives",
            emphasis: "explore",
            addSteps: [
              { id: "benchmark", summary: "Comparer solutions", effort: 1, risk: 0.3, domain: "research", tags: ["explore"] },
            ],
          },
        ],
      },
      { maxHypotheses: undefined, noveltyBoost: undefined },
    );

    expect(hypotheses).to.have.length(3);
    const exploratory = hypotheses.find((hypothesis) => hypothesis.id === "explore");
    expect(exploratory).to.not.equal(undefined);
    // The novelty boost must remain numerical even when callers supply
    // `undefined`, otherwise downstream ranking would encounter NaN values.
    expect(Number.isNaN(exploratory?.novelty ?? NaN)).to.equal(false);

    const ranked = evaluateHypotheses(hypotheses, basePlan, {
      noveltyWeight: undefined,
      riskWeight: undefined,
      effortWeight: undefined,
      coverageWeight: undefined,
    });

    const baselineScore = ranked.find((hypothesis) => hypothesis.label === "baseline")?.score;
    expect(baselineScore).to.not.equal(undefined);
    // Scores should stay well-defined so orchestrator tie-breaking logic can
    // continue to rely on numeric comparisons.
    expect(Number.isNaN(baselineScore ?? NaN)).to.equal(false);
  });

  it("converges top hypotheses while preserving unique steps", () => {
    const hypotheses: PlanHypothesis[] = generateHypotheses(
      {
        objective: "Livrer une fonctionnalité",
        basePlan,
        divergences: [
          {
            id: "quality",
            description: "Accent sur la qualité",
            emphasis: "quality",
            addSteps: [
              { id: "tests", summary: "Renforcer les tests", effort: 2, risk: 0.2, domain: "qa", tags: ["quality"] },
            ],
          },
          {
            id: "explore",
            description: "Explorer alternatives",
            emphasis: "explore",
            addSteps: [
              { id: "benchmark", summary: "Comparer solutions", effort: 1, risk: 0.3, domain: "research", tags: ["explore"] },
            ],
          },
        ],
      },
      { maxHypotheses: 3 },
    );

    const ranked = evaluateHypotheses(hypotheses, basePlan);
    const convergence: HypothesisConvergenceResult = convergeHypotheses(ranked, { maxSelected: 2 });

    expect(convergence.selectedHypotheses).to.have.length(2);
    const fusedIds = convergence.fusedPlan.map((step) => step.id);
    expect(fusedIds).to.include("analyse");
    expect(fusedIds).to.include("tests");
    expect(fusedIds).to.include("benchmark");
    expect(new Set(fusedIds).size).to.equal(fusedIds.length);
    expect(convergence.rationale.length).to.equal(2);
  });

  it("ignore les divergences neutres et fusionne partiellement les alternatives", () => {
    const divergences = [
      {
        id: "noop",
        description: "Aucun changement",
        emphasis: "quality" as const,
        addSteps: [],
      },
      {
        id: "speed",
        description: "Accélérer le delivery",
        emphasis: "speed" as const,
        removeStepIds: ["design"],
        adjustEffortFactor: 0.7,
        addSteps: [
          { id: "spike", summary: "Spike technique", effort: 1, risk: 0.4, domain: "research", tags: ["explore"] },
        ],
      },
      {
        id: "qa",
        description: "Renforcer la QA",
        emphasis: "quality" as const,
        addSteps: [
          { id: "qa_plan", summary: "Plan de tests", effort: 2, risk: 0.3, domain: "qa", tags: ["quality"] },
        ],
      },
    ];

    const hypotheses = generateHypotheses(
      {
        objective: "Livrer une fonctionnalité",
        basePlan,
        divergences,
      },
      { maxHypotheses: 5 },
    );

    const hypothesisIds = hypotheses.map((hypothesis) => hypothesis.id);
    expect(hypothesisIds).to.not.include("noop");
    expect(hypotheses.length).to.equal(3);

    const ranked = evaluateHypotheses(hypotheses, basePlan, {
      noveltyWeight: 0.45,
      coverageWeight: 0.25,
      effortWeight: 0.15,
      riskWeight: 0.15,
    });

    const convergence = convergeHypotheses(ranked, { maxSelected: 2 });
    const fusedIds = convergence.fusedPlan.map((step) => step.id);

    expect(fusedIds).to.deep.equal(["analyse", "design", "implement", "qa_plan", "spike"]);
    expect(new Set(fusedIds).size).to.equal(fusedIds.length);
  });

  it("omits undefined optional fields when cloning plan steps", () => {
    const sparsePlan: PlanStep[] = [
      { id: "draft", summary: "Rédiger le plan", effort: 1, risk: 0.2 },
      { id: "review", summary: "Relire", effort: 1, risk: 0.1, tags: ["qa"] },
    ];

    const hypotheses = generateHypotheses(
      {
        objective: "Préparer un plan minimal",
        basePlan: sparsePlan,
        divergences: [
          {
            id: "enrich",
            description: "Ajouter un contrôle",
            emphasis: "quality",
            addSteps: [
              { id: "lint", summary: "Lancer lint", effort: 1, risk: 0.1 },
            ],
          },
        ],
      },
      { maxHypotheses: 2 },
    );

    expect(hypotheses).to.have.length(2);
    const baseline = hypotheses.find((hypothesis) => hypothesis.label === "baseline");
    expect(baseline).to.not.equal(undefined);
    expect(baseline?.steps).to.have.length(2);
    const firstBaselineStep = baseline?.steps[0] ?? {};
    expect(Object.prototype.hasOwnProperty.call(firstBaselineStep, "tags")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(firstBaselineStep, "domain")).to.equal(false);

    const ranked = evaluateHypotheses(hypotheses, sparsePlan);
    const convergence = convergeHypotheses(ranked);
    const fusedDraft = convergence.fusedPlan.find((step) => step.id === "draft");
    expect(fusedDraft).to.not.equal(undefined);
    expect(Object.prototype.hasOwnProperty.call(fusedDraft ?? {}, "tags")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(fusedDraft ?? {}, "domain")).to.equal(false);
  });
});
