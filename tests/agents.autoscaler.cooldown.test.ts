import { describe, it } from "mocha";
import { expect } from "chai";

import { Autoscaler, AutoscalerSupervisor } from "../src/agents/autoscaler.js";
import { ChildrenIndex } from "../src/state/childrenIndex.js";
import type { LoopTickContext } from "../src/executor/loop.js";

/** Manual clock emulating {@link Date.now} for deterministic cooldown checks. */
class ManualClock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

/** Minimal supervisor double capturing spawn attempts for assertions. */
class StubSupervisor implements AutoscalerSupervisor {
  public readonly childrenIndex = new ChildrenIndex();
  public readonly created: string[] = [];

  constructor(private readonly clock: ManualClock) {}

  async createChild(): Promise<void> {
    const childId = `child-${this.created.length + 1}`;
    this.childrenIndex.registerChild({
      childId,
      pid: 1_000 + this.created.length,
      workdir: `/tmp/${childId}`,
      startedAt: this.clock.now(),
      state: "ready",
    });
    this.created.push(childId);
  }

  async cancel(): Promise<void> {
    /* Cooldown test focuses on scale-up decisions. */
  }
}

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

/** Ensures the autoscaler enforces the configured cooldown between actions. */
describe("agents autoscaler cooldown", () => {
  it("ignores pressure while the cooldown is active", async () => {
    const clock = new ManualClock();
    const supervisor = new StubSupervisor(clock);
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 0, maxChildren: 3, cooldownMs: 2_000 },
      thresholds: {
        backlogHigh: 2,
        backlogLow: 0,
        latencyHighMs: 1_000,
        latencyLowMs: 300,
        failureRateHigh: 0.5,
        failureRateLow: 0.1,
      },
    });

    autoscaler.updateBacklog(4);
    autoscaler.recordTaskResult({ durationMs: 1_200, success: false });
    await autoscaler.reconcile(buildContext(clock));
    expect(supervisor.created).to.deep.equal(["child-1"]);

    autoscaler.updateBacklog(5);
    clock.advance(500);
    await autoscaler.reconcile(buildContext(clock, 1));
    expect(supervisor.created).to.deep.equal(["child-1"]);

    clock.advance(2_100);
    autoscaler.updateBacklog(6);
    await autoscaler.reconcile(buildContext(clock, 2));
    expect(supervisor.created).to.deep.equal(["child-1", "child-2"]);
  });
});
