import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import {
  registerCancellation,
  requestCancellation,
  resetCancellationRegistry,
  OperationCancelledError,
} from "../src/executor/cancel.js";
import { CancellableNode, type BehaviorNode, type BehaviorTickResult } from "../src/executor/bt/nodes.js";
import type { TickRuntime } from "../src/executor/bt/types.js";

describe("cancellation decorator", () => {
  beforeEach(() => {
    resetCancellationRegistry();
  });

  it("prevents the wrapped node from executing when cancelled", async () => {
    const handle = registerCancellation("op-test", { runId: "run-1", createdAt: 0 });
    const child: BehaviorNode = {
      id: "child",
      async tick(): Promise<BehaviorTickResult> {
        throw new Error("child should not execute when cancelled");
      },
      reset() {
        // no-op
      },
    };
    const node = new CancellableNode("decorator", child);
    const runtime: TickRuntime = {
      invokeTool: async () => null,
      now: () => 0,
      wait: async () => undefined,
      variables: {},
      throwIfCancelled: () => handle.throwIfCancelled(),
    };

    requestCancellation(handle.opId, { reason: "test" });

    let caught: unknown;
    try {
      await node.tick(runtime);
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(OperationCancelledError);
  });

  it("reports idempotent outcomes when requesting cancellation twice", () => {
    const handle = registerCancellation("op-second", { runId: "run-2", createdAt: 0 });
    const first = requestCancellation(handle.opId, { reason: "first" });
    const second = requestCancellation(handle.opId, { reason: "second" });

    expect(first).to.equal("requested");
    expect(second).to.equal("already_cancelled");
  });
});
