import { describe, it } from "mocha";
import { expect } from "chai";

import type { BehaviorNode, BehaviorTickResult, TickRuntime } from "../src/executor/bt/types.js";
import { BehaviorTreeInterpreter } from "../src/executor/bt/interpreter.js";
import { ReactiveScheduler } from "../src/executor/reactiveScheduler.js";

/**
 * Minimal deterministic clock used to drive scheduler tests without relying on
 * real timers. The helpers mimic the behaviour of {@link setTimeout} while
 * giving the test control over the current time.
 */
class ManualClock {
  private current = 0;
  private readonly scheduled: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.current;
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduled.push({ at: this.current + ms, resolve });
    });
  }

  advance(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  advanceTo(target: number): void {
    if (target < this.current) {
      this.current = target;
      return;
    }
    this.current = target;
    const remaining: Array<{ at: number; resolve: () => void }> = [];
    for (const entry of this.scheduled) {
      if (entry.at <= this.current) {
        entry.resolve();
      } else {
        remaining.push(entry);
      }
    }
    this.scheduled.length = 0;
    this.scheduled.push(...remaining);
  }
}

/** Behaviour node incrementing a counter every time the interpreter ticks. */
class CountingNode implements BehaviorNode {
  public readonly id = "counter";
  public readonly ticks: number[] = [];

  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    this.ticks.push(runtime.now());
    return { status: "running" };
  }

  reset(): void {
    // No internal state to reset.
  }
}

/**
 * Scheduler unit tests ensure events trigger interpreter ticks immediately and
 * that the scheduler keeps counting ticks for diagnostics.
 */
describe("reactive scheduler", () => {
  it("ticks the interpreter whenever events are emitted", async () => {
    const clock = new ManualClock();
    const node = new CountingNode();
    const interpreter = new BehaviorTreeInterpreter(node);

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
    });

    await scheduler.runUntilSettled({
      type: "taskReady",
      payload: { nodeId: "root", criticality: 1 },
    });

    expect(node.ticks).to.have.length(1);
    expect(node.ticks[0]).to.equal(0);

    clock.advance(25);

    await scheduler.runUntilSettled({
      type: "blackboardChanged",
      payload: { key: "status", importance: 2 },
    });

    expect(node.ticks).to.have.length(2);
    expect(node.ticks[1]).to.equal(25);
    expect(scheduler.tickCount).to.equal(2);

    scheduler.stop();
  });
});
