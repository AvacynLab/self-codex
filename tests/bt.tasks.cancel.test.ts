import { expect } from "chai";
import sinon from "sinon";

import { BehaviorTreeCancellationError, TaskLeaf } from "../src/executor/bt/nodes.js";
import { OperationCancelledError } from "../src/executor/cancel.js";
import type { TickRuntime } from "../src/executor/bt/types.js";

/**
 * Cancellation-focused coverage for TaskLeaf nodes to ensure orchestrator tools
 * invoked via `invokeTool` respect cooperative cancellation semantics even when
 * the runtime signals aborts mid-flight.
 */
describe("behaviour tree task leaves", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("does not invoke tools when cancellation triggers before resolution", async () => {
    const invokeTool = sinon.stub();
    let cancellationChecks = 0;
    const runtime: TickRuntime = {
      invokeTool,
      variables: { payload: { value: 42 } },
      throwIfCancelled: () => {
        cancellationChecks += 1;
        if (cancellationChecks === 1) {
          throw new BehaviorTreeCancellationError("pre-invocation cancel");
        }
      },
    };

    const leaf = new TaskLeaf("cancelled-task", "noop", { inputKey: "payload" });

    await leaf.tick(runtime).then(
      () => {
        expect.fail("TaskLeaf should not invoke tools when cancellation is detected upfront");
      },
      (error) => {
        expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
      },
    );
    expect(invokeTool.callCount).to.equal(0);
  });

  it("propagates OperationCancelledError raised by invokeTool", async () => {
    const cancellation = new OperationCancelledError({
      opId: "op-task",
      runId: "run-task",
      jobId: null,
      graphId: null,
      nodeId: null,
      childId: null,
      reason: "tool cancellation",
    });

    const invokeTool = sinon.stub().rejects(cancellation);
    const runtime: TickRuntime = {
      invokeTool,
      variables: {},
    };

    const leaf = new TaskLeaf("tool-cancel", "noop");

    await leaf.tick(runtime).then(
      () => {
        expect.fail("TaskLeaf should propagate cancellation raised by invokeTool");
      },
      (error) => {
        expect(error).to.equal(cancellation);
      },
    );
  });

  it("wraps abort-like errors from invokeTool as BehaviourTreeCancellationError", async () => {
    const abortError = new Error("aborted by orchestrator");
    abortError.name = "AbortError";

    const invokeTool = sinon.stub().rejects(abortError);
    const runtime: TickRuntime = {
      invokeTool,
      variables: {},
    };

    const leaf = new TaskLeaf("abort-task", "noop");

    await leaf.tick(runtime).then(
      () => {
        expect.fail("TaskLeaf should convert abort signals into cancellation errors");
      },
      (error) => {
        expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
        expect(error.cause).to.equal(abortError);
      },
    );
  });

  it("checks for cancellation after tool completion", async () => {
    const invokeTool = sinon.stub().resolves({ ok: true });
    let cancellationChecks = 0;
    const runtime: TickRuntime = {
      invokeTool,
      variables: {},
      throwIfCancelled: () => {
        cancellationChecks += 1;
        if (cancellationChecks === 3) {
          throw new BehaviorTreeCancellationError("post-tool cancel");
        }
      },
    };

    const leaf = new TaskLeaf("post-cancel", "noop");

    await leaf.tick(runtime).then(
      () => {
        expect.fail("TaskLeaf should surface cancellations raised after invokeTool resolves");
      },
      (error) => {
        expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
      },
    );

    sinon.assert.calledOnceWithExactly(invokeTool, "noop", {});
  });
});
