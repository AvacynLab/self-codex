import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeCancellationError, ParallelNode } from "../src/executor/bt/nodes.js";
import { OperationCancelledError } from "../src/executor/cancel.js";
import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";

/**
 * Scenario-based scripted child used by the parallel cancellation tests. Each reset
 * progresses to the next scripted run so the suite can assert that cancellations
 * rewind branch-specific state before the composite retries.
 */
class ScriptedParallelChild implements BehaviorNode {
  private runIndex = 0;
  private stepIndex = 0;
  public readonly id: string;
  private readonly runs: ScriptedStep[][];
  public resets = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(id: string, runs: ScriptedStep[][]) {
    this.id = id;
    this.runs = runs;
  }

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const run = this.runs[Math.min(this.runIndex, this.runs.length - 1)];
    const currentStep = run[Math.min(this.stepIndex, run.length - 1)];
    this.stepIndex = Math.min(run.length - 1, this.stepIndex + 1);
    if (currentStep.kind === "throw") {
      this.status = "failure";
      throw currentStep.error;
    }
    this.status = currentStep.status === "running" ? "running" : currentStep.status;
    return currentStep;
  }

  reset(): void {
    this.stepIndex = 0;
    if (this.runIndex < this.runs.length - 1) {
      this.runIndex += 1;
    }
    this.resets += 1;
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "scripted-parallel-child",
      status: this.status,
      progress: this.getProgress() * 100,
      state: {
        runIndex: this.runIndex,
        stepIndex: this.stepIndex,
        resets: this.resets,
      },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "scripted-parallel-child") {
      throw new Error(`expected scripted-parallel-child snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { runIndex?: number; stepIndex?: number; resets?: number } | undefined;
    this.runIndex = typeof state?.runIndex === "number" ? state.runIndex : 0;
    this.stepIndex = typeof state?.stepIndex === "number" ? state.stepIndex : 0;
    this.resets = typeof state?.resets === "number" ? state.resets : 0;
    this.status = snapshot.status;
  }

  getProgress(): number {
    const run = this.runs[Math.min(this.runIndex, this.runs.length - 1)] ?? [];
    if (run.length === 0) {
      return 1;
    }
    const completed = Math.min(this.stepIndex, run.length);
    return completed / run.length;
  }
}

interface ThrowStep {
  readonly kind: "throw";
  readonly error: Error;
}

type ScriptedStep = BehaviorTickResult | ThrowStep;

const idleRuntime: TickRuntime = { invokeTool: async () => null, variables: {} };

describe("ParallelNode cancellation", () => {
  it("resets cached statuses when a child surfaces cancellation", async () => {
    const first = new ScriptedParallelChild("first", [
      [{ status: "success" }],
      [{ status: "success" }],
    ]);
    const second = new ScriptedParallelChild("second", [
      [
        { status: "running" },
        { kind: "throw", error: new BehaviorTreeCancellationError("child cancelled") },
      ],
      [{ status: "running" }, { status: "success" }],
    ]);
    const third = new ScriptedParallelChild("third", [
      [{ status: "running" }, { status: "success" }],
      [{ status: "running" }, { status: "success" }],
    ]);
    const node = new ParallelNode("parallel-quota-cancel", { mode: "quota", threshold: 2 }, [
      first,
      second,
      third,
    ]);

    const firstTick = await node.tick(idleRuntime);
    expect(firstTick.status).to.equal("running");
    expect(first.resets).to.equal(0);
    expect(second.resets).to.equal(0);
    expect(third.resets).to.equal(0);

    await node.tick(idleRuntime).then(
      () => {
        expect.fail("ParallelNode should propagate the cancellation surfaced by the child");
      },
      (error) => {
        expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
      },
    );

    expect(first.resets).to.equal(1);
    expect(second.resets).to.equal(1);
    expect(third.resets).to.equal(1);

    const retryTick = await node.tick(idleRuntime);
    expect(retryTick.status).to.equal("running");
    expect(first.resets).to.equal(1);
    expect(second.resets).to.equal(1);
    expect(third.resets).to.equal(1);

    const completion = await node.tick(idleRuntime);
    expect(completion.status).to.equal("success");
    expect(first.resets).to.equal(2);
    expect(second.resets).to.equal(2);
    expect(third.resets).to.equal(2);
  });

  it("propagates runtime cancellations and clears per-branch state", async () => {
    const first = new ScriptedParallelChild("first-runtime", [
      [{ status: "success" }],
      [{ status: "success" }],
    ]);
    const second = new ScriptedParallelChild("second-runtime", [
      [{ status: "running" }, { status: "success" }],
      [{ status: "running" }, { status: "success" }],
    ]);
    const third = new ScriptedParallelChild("third-runtime", [
      [{ status: "running" }, { status: "success" }],
      [{ status: "running" }, { status: "success" }],
    ]);
    const node = new ParallelNode("parallel-runtime-cancel", { mode: "quota", threshold: 2 }, [
      first,
      second,
      third,
    ]);

    const initialTick = await node.tick(idleRuntime);
    expect(initialTick.status).to.equal("running");

    let cancellationChecks = 0;
    const runtimeCancellation = new OperationCancelledError({
      opId: "op-parallel",
      runId: "run-parallel",
      jobId: null,
      graphId: null,
      nodeId: null,
      childId: null,
      reason: "runtime cancelled",
    });
    const cancellingRuntime: TickRuntime = {
      ...idleRuntime,
      throwIfCancelled: () => {
        cancellationChecks += 1;
        if (cancellationChecks === 3) {
          throw runtimeCancellation;
        }
      },
    };

    await node.tick(cancellingRuntime).then(
      () => {
        expect.fail("ParallelNode should surface runtime cancellations");
      },
      (error) => {
        expect(error).to.equal(runtimeCancellation);
      },
    );

    expect(first.resets).to.equal(1);
    expect(second.resets).to.equal(1);
    expect(third.resets).to.equal(1);

    const resumedTick = await node.tick(idleRuntime);
    expect(resumedTick.status).to.equal("running");

    const resumedCompletion = await node.tick(idleRuntime);
    expect(resumedCompletion.status).to.equal("success");
    expect(first.resets).to.equal(2);
    expect(second.resets).to.equal(2);
    expect(third.resets).to.equal(2);
  });

  it("replays every branch under all-mode when a child cancels", async () => {
    const first = new ScriptedParallelChild("all-first", [
      [{ status: "running" }, { status: "success" }],
      [{ status: "success" }],
    ]);
    const second = new ScriptedParallelChild("all-second", [
      [
        { status: "running" },
        { kind: "throw", error: new BehaviorTreeCancellationError("all child cancelled") },
      ],
      [{ status: "running" }, { status: "success" }],
    ]);
    const third = new ScriptedParallelChild("all-third", [
      [{ status: "running" }, { status: "success" }],
      [{ status: "running" }, { status: "success" }],
    ]);
    const node = new ParallelNode("parallel-all-cancel", "all", [first, second, third]);

    const initialTick = await node.tick(idleRuntime);
    expect(initialTick.status).to.equal("running");

    await node.tick(idleRuntime).then(
      () => {
        expect.fail("ParallelNode should propagate cancellation surfaced by a child when running in all-mode");
      },
      (error) => {
        expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
      },
    );

    expect(first.resets).to.equal(1);
    expect(second.resets).to.equal(1);
    expect(third.resets).to.equal(1);

    const resumedTick = await node.tick(idleRuntime);
    expect(resumedTick.status).to.equal("running");

    const completion = await node.tick(idleRuntime);
    expect(completion.status).to.equal("success");
    expect(first.resets).to.equal(2);
    expect(second.resets).to.equal(2);
    expect(third.resets).to.equal(2);
  });

  it("forgets cached successes when runtime cancellation interrupts any-mode", async () => {
    const first = new ScriptedParallelChild("any-first", [
      [{ status: "running" }, { status: "success" }],
      [{ status: "success" }],
    ]);
    const second = new ScriptedParallelChild("any-second", [
      [{ status: "running" }, { status: "failure" }],
      [{ status: "failure" }],
      [{ status: "success" }],
    ]);
    const third = new ScriptedParallelChild("any-third", [
      [{ status: "running" }, { status: "failure" }],
      [{ status: "failure" }],
      [{ status: "failure" }],
    ]);
    const node = new ParallelNode("parallel-any-cancel", "any", [first, second, third]);

    const firstTick = await node.tick(idleRuntime);
    expect(firstTick.status).to.equal("running");

    let cancellationChecks = 0;
    const runtimeCancellation = new BehaviorTreeCancellationError("runtime requested cancellation");
    const cancellingRuntime: TickRuntime = {
      ...idleRuntime,
      throwIfCancelled: () => {
        cancellationChecks += 1;
        // The parallel node performs five cooperative cancellation checks per tick
        // (entry, pre-child ×3, post-children). Raise on the final guard so the
        // children have completed and cached their results before the abort.
        if (cancellationChecks === 5) {
          throw runtimeCancellation;
        }
      },
    };

    await node.tick(cancellingRuntime).then(
      () => {
        expect.fail("ParallelNode should surface runtime cancellations even if a child already succeeded under any-mode");
      },
      (error) => {
        expect(error).to.equal(runtimeCancellation);
      },
    );

    expect(first.resets).to.equal(1);
    expect(second.resets).to.equal(1);
    expect(third.resets).to.equal(1);

    const resumed = await node.tick(idleRuntime);
    expect(resumed.status).to.equal("success");
    expect(first.resets).to.equal(2);
    expect(second.resets).to.equal(2);
    expect(third.resets).to.equal(2);
  });
});
