import { describe, it } from "mocha";
import { expect } from "chai";

import { ValueGraph } from "../src/values/valueGraph.js";

/**
 * Validates the scoring and filtering behaviour of the value guard. The tests
 * exercise propagation across relationships, tolerance enforcement and the
 * default threshold comparison exposed by the guard.
 */
describe("values graph scoring and filtering", () => {
  it("propagates impacts across relationships while keeping violations empty", () => {
    const graph = new ValueGraph();
    graph.set({
      defaultThreshold: 0.6,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.25 },
        { id: "safety", weight: 1, tolerance: 0.3 },
        { id: "compliance", weight: 0.8, tolerance: 0.6 },
      ],
      relationships: [
        { from: "privacy", to: "safety", kind: "supports", weight: 0.5 },
        { from: "safety", to: "compliance", kind: "supports", weight: 0.4 },
        { from: "privacy", to: "compliance", kind: "conflicts", weight: 0.3 },
      ],
    });

    const score = graph.score({
      id: "plan-safe",
      label: "Plan secure data handling",
      impacts: [
        { value: "privacy", impact: "support", severity: 0.9, rationale: "encryption enforced" },
        { value: "safety", impact: "risk", severity: 0.2, rationale: "reduced manual review" },
      ],
    });

    expect(score.score).to.be.closeTo(0.875, 1e-6);
    expect(score.violations).to.have.length(0);
    const compliance = score.breakdown.find((entry) => entry.value === "compliance");
    expect(compliance?.residual).to.be.closeTo(0.35, 1e-6);
    expect(compliance?.satisfaction).to.be.closeTo(0.5625, 1e-6);
  });

  it("rejects risky plans and surfaces detailed violations", () => {
    const graph = new ValueGraph();
    graph.set({
      defaultThreshold: 0.6,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.25 },
        { id: "safety", weight: 1, tolerance: 0.3 },
        { id: "compliance", weight: 0.8, tolerance: 0.6 },
      ],
      relationships: [
        { from: "privacy", to: "safety", kind: "supports", weight: 0.5 },
        { from: "safety", to: "compliance", kind: "supports", weight: 0.4 },
        { from: "privacy", to: "compliance", kind: "conflicts", weight: 0.3 },
      ],
    });

    const decision = graph.filter({
      id: "plan-risk",
      label: "Plan risky data sharing",
      impacts: [
        { value: "privacy", impact: "risk", severity: 0.9, rationale: "shares raw customer data" },
        { value: "safety", impact: "risk", severity: 0.7, rationale: "skips peer review" },
        { value: "unknown", impact: "support", severity: 1, rationale: "references undefined value" },
      ],
    });

    expect(decision.allowed).to.equal(false);
    expect(decision.score).to.be.below(0.4);
    expect(decision.threshold).to.equal(0.6);
    expect(decision.violations.length).to.be.greaterThanOrEqual(3);

    const privacyViolation = decision.violations.find((entry) => entry.value === "privacy");
    expect(privacyViolation?.severity).to.be.greaterThan(0.8);
    expect(privacyViolation?.message).to.match(/residual risk/);

    const safetyViolation = decision.violations.find((entry) => entry.value === "safety");
    expect(safetyViolation?.severity).to.be.greaterThan(1);

    const unknownViolation = decision.violations.find((entry) => entry.value === "unknown");
    expect(unknownViolation?.message).to.include("not declared");
  });
});
