import { strict as assert } from "node:assert";

import {
  ParallelNode,
  type BehaviorNode,
  type BehaviorTickResult,
} from "../../../src/executor/bt/nodes.js";
import { type TickRuntime } from "../../../src/executor/bt/types.js";

/**
 * Behaviour Tree runtime tests focusing on composite node coordination. The
 * scenarios ensure parallel policies aggregate child outcomes without relying
 * on incidental array filtering logic.
 */
describe("executor/bt/nodes", () => {
  function createRuntime(): TickRuntime {
    return {
      invokeTool: async () => undefined,
      now: () => 0,
      wait: async () => {},
      variables: {},
    };
  }

  class StubNode implements BehaviorNode {
    private readonly results: BehaviorTickResult[];
    private callIndex = 0;

    constructor(
      public readonly id: string,
      results: readonly BehaviorTickResult[],
    ) {
      this.results = [...results];
    }

    async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
      const index = Math.min(this.callIndex, this.results.length - 1);
      this.callIndex += 1;
      return this.results[index];
    }

    reset(): void {
      this.callIndex = 0;
    }
  }

  it("returns running when any child remains in-flight under the 'all' policy", async () => {
    const runtime = createRuntime();
    const node = new ParallelNode("parallel", "all", [
      new StubNode("child-1", [{ status: "success" }]),
      new StubNode("child-2", [{ status: "running" }]),
    ]);

    const result = await node.tick(runtime);

    assert.deepStrictEqual(result, { status: "running" });
  });

  it("fails when every child fails under the 'any' policy", async () => {
    const runtime = createRuntime();
    const node = new ParallelNode("parallel", "any", [
      new StubNode("child-1", [{ status: "failure" }]),
      new StubNode("child-2", [{ status: "failure" }]),
    ]);

    const result = await node.tick(runtime);

    assert.deepStrictEqual(result, { status: "failure" });
  });

  it("clamps quota policies to the number of children before resolving", async () => {
    const runtime = createRuntime();
    const node = new ParallelNode("parallel", { mode: "quota", threshold: 5 }, [
      new StubNode("child-1", [{ status: "success" }]),
      new StubNode("child-2", [{ status: "success" }]),
    ]);

    const result = await node.tick(runtime);

    assert.deepStrictEqual(result, { status: "success" });
  });

  it("fails quota policies early when the remaining potential cannot satisfy the threshold", async () => {
    const runtime = createRuntime();
    const node = new ParallelNode("parallel", { mode: "quota", threshold: 2 }, [
      new StubNode("child-1", [{ status: "failure" }]),
      new StubNode("child-2", [{ status: "running" }]),
    ]);

    const result = await node.tick(runtime);

    assert.deepStrictEqual(result, { status: "failure" });
  });
});
