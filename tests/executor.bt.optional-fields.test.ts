import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeInterpreter, buildBehaviorTree } from "../src/executor/bt/interpreter.js";
import type {
  BehaviorNode,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";

/**
 * Behaviour Tree interpreter optional-field handling. These regressions verify
 * the runtime sanitisation introduced while enabling `exactOptionalPropertyTypes`.
 */
describe("behavior tree interpreter optional runtime fields", () => {
  it("omits undefined runtime hooks when wiring a tick", async () => {
    const captured: TickRuntime[] = [];
    const stubNode: BehaviorNode = {
      id: "stub",
      async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
        captured.push(runtime);
        return { status: "success" };
      },
      reset(): void {
        // noop reset for the stub node used in the regression.
      },
    };
    const interpreter = new BehaviorTreeInterpreter(stubNode);

    await interpreter.tick({
      // The interpreter expects an invoker even when the stub never calls it.
      invokeTool: async () => undefined,
    });

    expect(captured).to.have.lengthOf(1);
    const runtime = captured[0];
    // The sanitiser must avoid materialising optional keys when the caller
    // omits them so strict optional typing can be enabled globally.
    expect(Object.prototype.hasOwnProperty.call(runtime, "cancellationSignal")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "isCancelled")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "throwIfCancelled")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "recommendTimeout")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "recordTimeoutOutcome")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, "random")).to.equal(false);
  });

  it("preserves provided optional hooks and forwards them verbatim", async () => {
    const captured: TickRuntime[] = [];
    const controller = new AbortController();
    const stubNode: BehaviorNode = {
      id: "stub-hooks",
      async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
        captured.push(runtime);
        return { status: "success" };
      },
      reset(): void {},
    };
    const interpreter = new BehaviorTreeInterpreter(stubNode);

    const optionalHooks = {
      cancellationSignal: controller.signal,
      isCancelled: () => true,
      throwIfCancelled: () => {
        throw new Error("cancelled");
      },
      recommendTimeout: () => 42,
      recordTimeoutOutcome: () => undefined,
      random: () => 0.5,
    } as const;

    await interpreter.tick({
      invokeTool: async () => undefined,
      ...optionalHooks,
    });

    expect(captured).to.have.lengthOf(1);
    const runtime = captured[0];
    // All optional hooks must be preserved exactly as provided by callers.
    for (const [key, value] of Object.entries(optionalHooks)) {
      expect(runtime[key as keyof TickRuntime]).to.equal(value);
    }
  });

  it("omits undefined task outputs in the tick result", async () => {
    const tree = buildBehaviorTree(
      {
        type: "task",
        node_id: "noop-task",
        tool: "noop",
      },
      {},
      "bt",
    );
    const interpreter = new BehaviorTreeInterpreter(tree);

    const result = await interpreter.tick({
      invokeTool: async () => undefined,
    });

    expect(result.status).to.equal("success");
    expect(Object.prototype.hasOwnProperty.call(result, "output")).to.equal(false);
  });

  it("preserves concrete task outputs returned by tools", async () => {
    const tree = buildBehaviorTree(
      {
        type: "task",
        node_id: "echo-task",
        tool: "echo",
      },
      {},
      "bt",
    );
    const interpreter = new BehaviorTreeInterpreter(tree);

    const payload = { greeting: "hello" } as const;
    const result = await interpreter.tick({
      invokeTool: async () => payload,
    });

    expect(result).to.deep.equal({ status: "success", output: payload });
  });
});
