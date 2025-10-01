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
});
