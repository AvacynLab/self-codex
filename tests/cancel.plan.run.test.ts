import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import {
  registerCancellation,
  cancelRun,
  getCancellation,
  isCancelled,
  resetCancellationRegistry,
} from "../src/executor/cancel.js";

describe("plan cancellation registry", () => {
  beforeEach(() => {
    resetCancellationRegistry();
  });

  it("cancels every operation associated with a run identifier", () => {
    registerCancellation("op-1", {
      runId: "run-cascade",
      jobId: "job-1",
      graphId: "graph-7",
      nodeId: "node-3",
      childId: "child-1",
    });
    registerCancellation("op-2", {
      runId: "run-cascade",
      jobId: "job-1",
      graphId: "graph-7",
      nodeId: "node-4",
      childId: "child-2",
    });
    registerCancellation("op-ignored", { runId: "other" });

    const outcomes = cancelRun("run-cascade", { reason: "manual" });

    expect(outcomes).to.deep.equal([
      {
        opId: "op-1",
        outcome: "requested",
        runId: "run-cascade",
        jobId: "job-1",
        graphId: "graph-7",
        nodeId: "node-3",
        childId: "child-1",
      },
      {
        opId: "op-2",
        outcome: "requested",
        runId: "run-cascade",
        jobId: "job-1",
        graphId: "graph-7",
        nodeId: "node-4",
        childId: "child-2",
      },
    ]);

    expect(isCancelled("op-1")).to.equal(true);
    expect(isCancelled("op-2")).to.equal(true);
    expect(isCancelled("op-ignored")).to.equal(false);

    const first = getCancellation("op-1");
    const second = getCancellation("op-2");
    expect(first?.reason).to.equal("manual");
    expect(second?.reason).to.equal("manual");
    expect(first?.jobId).to.equal("job-1");
    expect(second?.nodeId).to.equal("node-4");
  });

  it("returns an empty array when no operations are registered for the run", () => {
    const outcomes = cancelRun("unknown-run", { reason: "noop" });
    expect(outcomes).to.deep.equal([]);
  });
});
