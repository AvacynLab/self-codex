import { describe, it } from "mocha";
import { expect } from "chai";

import { ExecutionLoop } from "../src/executor/loop.js";
import type { IntervalHandle } from "../src/runtime/timers.js";

/** Deterministic manual clock so tests can simulate work duration explicitly. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * Budget tests verify the cooperative yielding capabilities when the loop is
 * configured with a per-tick duration budget.
 */
describe("execution loop budget", () => {
  it("requests cooperative yields once the budget is consumed", async () => {
    const manualClock = new ManualClock();
    const events: string[] = [];

    const intervalHandlers: Array<() => void> = [];
    const scheduledResumes: Array<() => void> = [];
    const fakeTimer = {} as IntervalHandle;

    const loop = new ExecutionLoop({
      intervalMs: 100,
      now: () => manualClock.now(),
      budgetMs: 10,
      setIntervalFn: (handler) => {
        intervalHandlers.push(handler);
        return fakeTimer;
      },
      clearIntervalFn: () => {
        // The manual scheduler does not keep track of handles, no-op.
      },
      scheduleYield: (resume) => {
        scheduledResumes.push(resume);
        return undefined;
      },
      cancelYield: () => {
        // Manual scheduler has nothing to cancel.
      },
      tick: async ({ budget, now }) => {
        if (!budget) {
          throw new Error("budget missing");
        }
        for (let i = 0; i < 5; i += 1) {
          manualClock.advance(6);
          events.push(`work-${i}@${now()}`);
          if (await budget.yieldIfExceeded()) {
            events.push(`yield@${now()}`);
          }
        }
      },
    });

    loop.start();
    expect(loop.isRunning).to.equal(true);
    expect(intervalHandlers).to.have.length(1);

    const waitForScheduled = async () => {
      for (let attempts = 0; attempts < 10 && scheduledResumes.length === 0; attempts += 1) {
        await Promise.resolve();
      }
      expect(scheduledResumes).to.not.be.empty;
    };

    intervalHandlers[0]!();
    await waitForScheduled();

    scheduledResumes.shift()!();
    await Promise.resolve();
    await waitForScheduled();

    scheduledResumes.shift()!();
    await Promise.resolve();

    await loop.whenIdle();

    expect(events).to.deep.equal([
      "work-0@6",
      "work-1@12",
      "yield@12",
      "work-2@18",
      "work-3@24",
      "yield@24",
      "work-4@30",
    ]);
    expect(scheduledResumes).to.be.empty;
    expect(loop.tickCount).to.equal(1);

    await loop.stop();
    expect(loop.isRunning).to.equal(false);
  });
});
