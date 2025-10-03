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
    registerCancellation("op-1", { runId: "run-cascade" });
    registerCancellation("op-2", { runId: "run-cascade" });
    registerCancellation("op-ignored", { runId: "other" });

    const outcomes = cancelRun("run-cascade", { reason: "manual" });

    expect(outcomes).to.deep.equal([
      { opId: "op-1", outcome: "requested" },
      { opId: "op-2", outcome: "requested" },
    ]);

    expect(isCancelled("op-1")).to.equal(true);
    expect(isCancelled("op-2")).to.equal(true);
    expect(isCancelled("op-ignored")).to.equal(false);

    const first = getCancellation("op-1");
    const second = getCancellation("op-2");
    expect(first?.reason).to.equal("manual");
    expect(second?.reason).to.equal("manual");
  });

  it("returns an empty array when no operations are registered for the run", () => {
    const outcomes = cancelRun("unknown-run", { reason: "noop" });
    expect(outcomes).to.deep.equal([]);
  });
});
