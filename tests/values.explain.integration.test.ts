import { describe, it } from "mocha";
import { expect } from "chai";

import { ValueGraph } from "../src/values/valueGraph.js";

/**
 * Integration-level coverage for the value guard explanation helper. The tests
 * verify that violations are enriched with correlation metadata and human
 * readable hints so MCP clients can present actionable diagnostics.
 */
describe("values guard explanations", () => {
  it("produces actionable hints and correlation metadata", () => {
    const graph = new ValueGraph();
    graph.set({
      defaultThreshold: 0.6,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.25, label: "Privacy" },
        { id: "compliance", weight: 0.8, tolerance: 0.5, label: "Compliance" },
      ],
      relationships: [
        { from: "privacy", to: "compliance", kind: "supports", weight: 0.6 },
      ],
    });

    const explanation = graph.explain({
      id: "plan-risk",
      label: "Risky data export",
      impacts: [
        {
          value: "privacy",
          impact: "risk",
          severity: 0.9,
          rationale: "shares raw customer data",
          source: "task:export",
          nodeId: "task-export",
        },
      ],
    });

    expect(explanation.decision.allowed).to.equal(false);
    expect(explanation.decision.violations).to.have.lengthOf(2);
    expect(explanation.violations).to.have.lengthOf(explanation.decision.violations.length);

    const privacy = explanation.violations.find((entry) => entry.value === "privacy");
    expect(privacy).to.not.equal(undefined);
    expect(privacy?.nodeId).to.equal("task-export");
    expect(privacy?.primaryContributor?.amount).to.be.closeTo(0.9, 1e-6);
    expect(privacy?.hint).to.include("Direct risk impact");
    expect(privacy?.hint).to.include("shares raw customer data");

    const compliance = explanation.violations.find((entry) => entry.value === "compliance");
    expect(compliance).to.not.equal(undefined);
    expect(compliance?.primaryContributor?.propagated).to.equal(true);
    expect(compliance?.primaryContributor?.via).to.equal("supports");
    expect(compliance?.hint).to.include("Risk propagated from value 'privacy'");
    expect(compliance?.hint).to.include("via supports");
    expect(compliance?.hint).to.include("plan node 'task-export'");
  });

  it("guides operators when a plan references an unknown value", () => {
    const graph = new ValueGraph();
    graph.set({
      defaultThreshold: 0.6,
      values: [{ id: "safety", weight: 1, tolerance: 0.3 }],
    });

    const explanation = graph.explain({
      id: "plan-unknown",
      label: "Plan referencing undefined value",
      impacts: [
        {
          value: "undefined",
          impact: "risk",
          severity: 0.5,
          rationale: "touches unspecified principle",
        },
      ],
    });

    const violation = explanation.violations.find((entry) => entry.value === "undefined");
    expect(violation).to.not.equal(undefined);
    expect(violation?.nodeId).to.equal(null);
    expect(violation?.hint).to.include("Declare the missing value");
    expect(explanation.decision.allowed).to.equal(false);
  });
});
