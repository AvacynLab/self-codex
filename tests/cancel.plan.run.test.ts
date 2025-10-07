import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import {
  registerCancellation,
  cancelRun,
  getCancellation,
  isCancelled,
  requestCancellation,
  resetCancellationRegistry,
  CancellationNotFoundError,
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

  it("throws a structured not-found error when cancelling an unknown op", () => {
    try {
      requestCancellation("missing-op", { reason: "noop" });
      expect.fail("requestCancellation should throw for unknown operations");
    } catch (error) {
      expect(error).to.be.instanceOf(CancellationNotFoundError);
      expect((error as CancellationNotFoundError).code).to.equal("E-CANCEL-NOTFOUND");
      expect((error as CancellationNotFoundError).message).to.equal("unknown opId");
      expect((error as CancellationNotFoundError).hint).to.equal("verify opId via events_subscribe");
      expect((error as CancellationNotFoundError).details).to.deep.equal({ opId: "missing-op" });
    }
  });
});
