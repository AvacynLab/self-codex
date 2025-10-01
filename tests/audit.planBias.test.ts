import { describe, it } from "mocha";
import { expect } from "chai";

import { analysePlanBias } from "../src/audit/planBias.js";
import { PlanStep } from "../src/strategies/hypotheses.js";

describe("audit.planBias", () => {
  const biasedPlan: PlanStep[] = [
    { id: "analyse", summary: "Analyser le besoin", effort: 2, risk: 0.6, domain: "analysis", tags: ["analysis"] },
    { id: "design", summary: "Proposer un design", effort: 3, risk: 0.7, domain: "analysis", tags: ["analysis"] },
    { id: "implement", summary: "Implémenter", effort: 5, risk: 0.8, domain: "analysis", tags: ["delivery"] },
  ];

  it("detects monoculture and anchoring biases", () => {
    const report = analysePlanBias(biasedPlan);
    const types = report.insights.map((insight) => insight.type);

    expect(types).to.include("anchoring");
    expect(types).to.include("monoculture");
    expect(report.hasCriticalBias).to.equal(true);
  });

  it("reports missing exploration and risk blindness when applicable", () => {
    const report = analysePlanBias(biasedPlan, {
      explorationTags: ["explore"],
      highRiskThreshold: 0.7,
      lowRiskDiversity: 0.2,
    });

    const missingExploration = report.insights.find((insight) => insight.type === "missing_alternatives");
    const riskBlind = report.insights.find((insight) => insight.type === "risk_blind");

    expect(missingExploration).to.not.equal(undefined);
    expect(riskBlind).to.not.equal(undefined);
    expect(riskBlind?.severity).to.equal("medium");
  });

  it("returns empty insights when the plan is already diversified", () => {
    const diversifiedPlan: PlanStep[] = [
      { id: "analyse", summary: "Analyser", effort: 2, risk: 0.2, domain: "analysis", tags: ["analysis", "explore"] },
      { id: "design", summary: "Concevoir", effort: 3, risk: 0.3, domain: "design", tags: ["design", "quality"] },
      { id: "revue", summary: "Revoir", effort: 2, risk: 0.2, domain: "qa", tags: ["quality", "explore"] },
    ];

    const report = analysePlanBias(diversifiedPlan);
    expect(report.insights).to.have.length(0);
    expect(report.hasCriticalBias).to.equal(false);
  });

  it("avoids anchoring false positives when a challenger step is present", () => {
    // The second step purposely challenges the initial hypothesis using a dedicated review tag.
    const challengedPlan: PlanStep[] = [
      { id: "analyse", summary: "Analyse initiale", effort: 2, risk: 0.4, domain: "analysis", tags: ["analysis"] },
      {
        id: "challenge",
        summary: "Revue critique",
        effort: 1,
        risk: 0.3,
        domain: "analysis",
        tags: ["analysis", "challenge"],
      },
      { id: "livrer", summary: "Livraison", effort: 3, risk: 0.5, domain: "delivery", tags: ["delivery"] },
    ];

    const report = analysePlanBias(challengedPlan);
    const anchoring = report.insights.find((insight) => insight.type === "anchoring");

    expect(anchoring).to.equal(undefined);
    expect(report.hasCriticalBias).to.equal(false);
  });
});
