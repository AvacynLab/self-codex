import { describe, it } from "mocha";
import { expect } from "chai";

import {
  extractPlanCorrelationHints,
  normalisePlanImpact,
  serialiseCorrelationForPayload,
  toEventCorrelationHints,
  type PlanCorrelationHintsCandidate,
} from "../../../src/tools/plan/validate.js";

describe("plan tools / validate", () => {
  it("normalises node impacts and preserves correlation hints", () => {
    const impact = normalisePlanImpact(
      {
        value: "ethics",
        impact: "risk",
        severity: 0.4,
        rationale: "Sensitive data",
        node_id: "node-1",
      },
      "fallback-node",
    );

    expect(impact).to.deep.equal({
      value: "ethics",
      impact: "risk",
      severity: 0.4,
      rationale: "Sensitive data",
      nodeId: "node-1",
    });
  });

  it("derives correlation hints from snake case inputs", () => {
    const candidate: PlanCorrelationHintsCandidate = {
      run_id: "run-42",
      job_id: "job-9",
      node_id: "node-1",
    };

    const hints = extractPlanCorrelationHints(candidate);
    expect(hints).to.deep.equal({ runId: "run-42", jobId: "job-9", nodeId: "node-1" });

    const correlation = toEventCorrelationHints(hints);
    expect(correlation).to.deep.equal({ runId: "run-42", jobId: "job-9", nodeId: "node-1" });
  });

  it("serialises empty hints with explicit null placeholders", () => {
    const correlation = toEventCorrelationHints(null);
    const payload = serialiseCorrelationForPayload(correlation);

    expect(payload).to.deep.equal({
      run_id: null,
      op_id: null,
      job_id: null,
      graph_id: null,
      node_id: null,
      child_id: null,
    });
  });
});
