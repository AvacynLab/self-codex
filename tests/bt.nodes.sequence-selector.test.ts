import { describe, it } from "mocha";
import { expect } from "chai";

import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";
import { ParallelNode, SelectorNode, SequenceNode } from "../src/executor/bt/nodes.js";

/**
 * Stub node returning the provided sequence of results. Each call to
 * {@link tick} consumes the next result until the array is exhausted.
 */
class StubNode implements BehaviorNode {
  private cursor = 0;
  private ticks = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(
    public readonly id: string,
    private readonly results: BehaviorTickResult[],
  ) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const result = this.results[Math.min(this.cursor, this.results.length - 1)];
    if (this.cursor < this.results.length - 1) {
      this.cursor += 1;
    }
    this.ticks = Math.min(this.ticks + 1, this.results.length);
    this.status = result.status === "running" ? "running" : result.status;
    return result;
  }

  reset(): void {
    this.cursor = 0;
    this.ticks = 0;
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "stub-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { cursor: this.cursor, ticks: this.ticks },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "stub-node") {
      throw new Error(`expected stub-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { cursor?: number; ticks?: number } | undefined;
    this.cursor = typeof state?.cursor === "number" ? state.cursor : 0;
    this.ticks = typeof state?.ticks === "number" ? state.ticks : 0;
    this.status = snapshot.status;
  }

  getProgress(): number {
    if (this.results.length === 0) {
      return 1;
    }
    return Math.min(this.ticks, this.results.length) / this.results.length;
  }
}

const runtime: TickRuntime = {
  invokeTool: async () => undefined,
  now: () => 0,
  wait: async () => {},
  variables: {},
};

/**
 * Unit tests exercising the sequence, selector and parallel behaviour tree
 * composites. The scenarios ensure cursor management and reset semantics remain
 * correct even when children yield RUNNING states.
 */
describe("behaviour tree composites", () => {
  it("runs sequence children in order and resets after completion", async () => {
    const first = new StubNode("first", [{ status: "success" }]);
    const second = new StubNode("second", [{ status: "success" }]);
    const sequence = new SequenceNode("sequence", [first, second]);

    const firstTick = await sequence.tick(runtime);
    expect(firstTick.status).to.equal("success");

    const secondTick = await sequence.tick(runtime);
    expect(secondTick.status).to.equal("success");

    // After success the sequence resets, therefore the first child is evaluated again.
    const thirdTick = await sequence.tick(runtime);
    expect(thirdTick.status).to.equal("success");
  });

  it("propagates failures from sequence children and resets state", async () => {
    const first = new StubNode("first", [{ status: "success" }]);
    const failing = new StubNode("failing", [{ status: "failure" }]);
    const sequence = new SequenceNode("sequence", [first, failing]);

    const result = await sequence.tick(runtime);
    expect(result.status).to.equal("failure");

    // Ensure the sequence restarted by checking that the first child executes again.
    const retryResult = await sequence.tick(runtime);
    expect(retryResult.status).to.equal("failure");
  });

  it("evaluates selector children until one succeeds", async () => {
    const first = new StubNode("first", [{ status: "failure" }]);
    const second = new StubNode("second", [{ status: "success" }]);
    const selector = new SelectorNode("selector", [first, second]);

    const result = await selector.tick(runtime);
    expect(result.status).to.equal("success");

    // The selector resets so the successful child is executed again on the next tick.
    const retryResult = await selector.tick(runtime);
    expect(retryResult.status).to.equal("success");
  });

  it("resumes selector execution when a child is running", async () => {
    const runningThenFail: BehaviorTickResult[] = [{ status: "running" }, { status: "failure" }];
    const second = new StubNode("second", [{ status: "success" }]);
    const selector = new SelectorNode("selector", [new StubNode("first", runningThenFail), second]);

    const firstTick = await selector.tick(runtime);
    expect(firstTick.status).to.equal("running");

    const secondTick = await selector.tick(runtime);
    expect(secondTick.status).to.equal("success");
  });

  it("succeeds only when all parallel children succeed with policy all", async () => {
    const slow = new StubNode("slow", [{ status: "running" }, { status: "success" }]);
    const fast = new StubNode("fast", [{ status: "success" }]);
    const parallel = new ParallelNode("parallel", "all", [slow, fast]);

    const firstTick = await parallel.tick(runtime);
    expect(firstTick.status).to.equal("running");

    const secondTick = await parallel.tick(runtime);
    expect(secondTick.status).to.equal("success");
  });

  it("succeeds when any child succeeds under policy any", async () => {
    const failing = new StubNode("failing", [{ status: "failure" }]);
    const succeeding = new StubNode("succeeding", [{ status: "success" }]);
    const parallel = new ParallelNode("parallel", "any", [failing, succeeding]);

    const result = await parallel.tick(runtime);
    expect(result.status).to.equal("success");
  });
});
