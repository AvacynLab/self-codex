import { describe, it } from "mocha";
import { expect } from "chai";

import { Autoscaler, AutoscalerSupervisor } from "../src/agents/autoscaler.js";
import { ChildrenIndex } from "../src/state/childrenIndex.js";
import type { LoopTickContext } from "../src/executor/loop.js";

/** Deterministic clock mirroring the `Date.now` contract. */
class ManualClock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

/** Lightweight supervisor double tracking creations and cancellations. */
class StubSupervisor implements AutoscalerSupervisor {
  public readonly childrenIndex = new ChildrenIndex();
  public readonly created: string[] = [];
  public readonly cancelled: string[] = [];

  constructor(private readonly clock: ManualClock) {}

  async createChild(): Promise<void> {
    const childId = `child-${this.created.length + 1}`;
    this.childrenIndex.registerChild({
      childId,
      pid: 100 + this.created.length,
      workdir: `/tmp/${childId}`,
      startedAt: this.clock.now(),
      state: "ready",
    });
    this.created.push(childId);
  }

  async cancel(childId: string): Promise<void> {
    const snapshot = this.childrenIndex.getChild(childId);
    if (!snapshot) {
      throw new Error(`unknown child ${childId}`);
    }
    this.childrenIndex.removeChild(childId);
    this.cancelled.push(childId);
  }
}

/** Builds a minimal loop context compatible with the autoscaler reconciler. */
function buildContext(clock: ManualClock, tickIndex = 0): LoopTickContext {
  const controller = new AbortController();
  return {
    startedAt: clock.now(),
    now: () => clock.now(),
    tickIndex,
    signal: controller.signal,
    budget: undefined,
  };
}

/** Validates the autoscaler behaviour in nominal pressure and relaxation flows. */
describe("agents autoscaler scale up/down", () => {
  it("spawns new children under pressure and retires idle ones once relaxed", async () => {
    const clock = new ManualClock();
    const supervisor = new StubSupervisor(clock);
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 1, maxChildren: 3, cooldownMs: 1_000 },
      thresholds: {
        backlogHigh: 3,
        backlogLow: 0,
        latencyHighMs: 1_200,
        latencyLowMs: 400,
        failureRateHigh: 0.6,
        failureRateLow: 0.2,
      },
    });
    expect(autoscaler.getConfiguration().minChildren).to.equal(1);

    await autoscaler.reconcile(buildContext(clock));
    expect(supervisor.created).to.deep.equal(["child-1"]);

    autoscaler.updateBacklog(5);
    autoscaler.recordTaskResult({ durationMs: 1_500, success: true });
    clock.advance(1_200);
    await autoscaler.reconcile(buildContext(clock, 1));
    expect(supervisor.created).to.deep.equal(["child-1", "child-2"]);

    autoscaler.updateBacklog(0);
    autoscaler.recordTaskResult({ durationMs: 220, success: true });
    autoscaler.recordTaskResult({ durationMs: 180, success: true });
    autoscaler.recordTaskResult({ durationMs: 150, success: true });
    autoscaler.recordTaskResult({ durationMs: 140, success: true });
    // Additional short-latency samples ensure the average dips below the
    // relaxation threshold so the scale-down path becomes eligible.
    autoscaler.recordTaskResult({ durationMs: 120, success: true });
    autoscaler.recordTaskResult({ durationMs: 110, success: true });
    const retireCandidate = supervisor.created[0]!;
    supervisor.childrenIndex.updateState(retireCandidate, "idle");
    clock.advance(1_200);
    await autoscaler.reconcile(buildContext(clock, 2));

    expect(supervisor.cancelled).to.deep.equal([retireCandidate]);
    const remainingIds = supervisor.childrenIndex.list().map((child) => child.childId).sort();
    expect(remainingIds).to.deep.equal(["child-2"]);
  });
});
