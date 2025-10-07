import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import {
  registerCancellation,
  requestCancellation,
  resetCancellationRegistry,
  OperationCancelledError,
} from "../src/executor/cancel.js";
import { __testing as planTesting } from "../src/tools/planTools.js";

/**
 * Ensures the concurrency helper observes cancellation signals before and after
 * awaited work so long-running fan-out operations react promptly to abort
 * requests.
 */
describe("plan tools cancellation-aware concurrency", () => {
  beforeEach(() => {
    resetCancellationRegistry();
  });

  it("throws before scheduling tasks when the operation is already cancelled", async () => {
    const handle = registerCancellation("op-cancel-before", {});
    let executed = false;
    const tasks = [async () => {
      executed = true;
      return "executed";
    }];

    requestCancellation("op-cancel-before", { reason: "preflight" });

    try {
      await planTesting.runWithConcurrency(1, tasks, { cancellation: handle });
      expect.fail("runWithConcurrency should throw once cancellation is detected");
    } catch (error) {
      expect(error).to.be.instanceOf(OperationCancelledError);
      expect((error as OperationCancelledError).details.opId).to.equal("op-cancel-before");
    }

    expect(executed).to.equal(false, "tasks should not execute after pre-cancellation");
  });

  it("stops scheduling additional tasks after a mid-flight cancellation", async () => {
    const handle = registerCancellation("op-cancel-mid", {});
    const executed: string[] = [];
    const tasks = [
      async () => {
        executed.push("first");
        requestCancellation("op-cancel-mid", { reason: "mid-flight" });
        return "first";
      },
      async () => {
        executed.push("second");
        return "second";
      },
    ];

    try {
      await planTesting.runWithConcurrency(1, tasks, { cancellation: handle });
      expect.fail("runWithConcurrency should propagate OperationCancelledError");
    } catch (error) {
      expect(error).to.be.instanceOf(OperationCancelledError);
      expect((error as OperationCancelledError).details.reason).to.equal("mid-flight");
    }

    expect(executed).to.deep.equal(["first"], "subsequent tasks must not start after cancellation");
  });
});
