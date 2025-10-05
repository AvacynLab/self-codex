import { describe, it } from "mocha";
import { expect } from "chai";

import { ParallelNode } from "../src/executor/bt/nodes.js";
import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";

/**
 * Deterministic behaviour node returning scripted results across ticks. The
 * implementation keeps the script immutable so {@link ParallelNode.reset}
 * reliably restarts the node from its initial state.
 */
class ScriptedNode implements BehaviorNode {
  private index = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(
    public readonly id: string,
    private readonly script: BehaviorTickResult[],
  ) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const currentIndex = Math.min(this.index, this.script.length - 1);
    const result = this.script[currentIndex];
    this.index = Math.min(this.script.length, this.index + 1);
    this.status = result.status === "running" ? "running" : result.status;
    return result;
  }

  reset(): void {
    this.index = 0;
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "scripted-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { index: this.index, status: this.status },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "scripted-node") {
      throw new Error(`expected scripted-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { index?: number; status?: BehaviorNodeSnapshot["status"] } | undefined;
    this.index = typeof state?.index === "number" ? state.index : 0;
    this.status = state?.status ?? "idle";
  }

  getProgress(): number {
    if (this.script.length === 0) {
      return 1;
    }
    const consumed = Math.min(this.index, this.script.length);
    return consumed / this.script.length;
  }
}

const idleRuntime: TickRuntime = {
  invokeTool: async () => null,
  now: () => 0,
  wait: async () => {},
  variables: {},
};

/**
 * The quota policy should resolve successfully once a subset of children reach
 * the configured threshold, even if other branches fail.
 */
describe("parallel node quota policy", () => {
  it("completes once the success threshold is met", async () => {
    const node = new ParallelNode(
      "quota",
      { mode: "quota", threshold: 2 },
      [
        new ScriptedNode("a", [{ status: "success" }]),
        new ScriptedNode("b", [{ status: "failure" }]),
        new ScriptedNode("c", [{ status: "running" }, { status: "success" }]),
      ],
    );

    const firstTick = await node.tick(idleRuntime);
    expect(firstTick.status).to.equal("running");

    const secondTick = await node.tick(idleRuntime);
    expect(secondTick.status).to.equal("success");
  });

  it("fails when remaining branches cannot satisfy the threshold", async () => {
    const node = new ParallelNode(
      "quota-fail",
      { mode: "quota", threshold: 3 },
      [
        new ScriptedNode("a", [{ status: "success" }]),
        new ScriptedNode("b", [{ status: "failure" }]),
        new ScriptedNode("c", [{ status: "failure" }]),
      ],
    );

    const result = await node.tick(idleRuntime);
    expect(result.status).to.equal("failure");
  });
});
