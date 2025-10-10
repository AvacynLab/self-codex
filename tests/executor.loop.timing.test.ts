import { describe, it } from "mocha";
import { expect } from "chai";

import { ExecutionLoop } from "../src/executor/loop.js";
import type { IntervalHandle } from "../src/runtime/timers.js";

/** Deterministic clock mirroring the manual scheduler used in the tests. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Manual interval runner to mimic {@link setInterval} deterministically. */
class ManualIntervalController {
  private handler: (() => void) | undefined;
  private interval: number | undefined;

  constructor(private readonly clock: ManualClock) {}

  set(handler: () => void, interval: number): IntervalHandle {
    this.handler = handler;
    this.interval = interval;
    return {} as IntervalHandle;
  }

  clear(): void {
    this.handler = undefined;
    this.interval = undefined;
  }

  /** Advances the clock by one interval and invokes the registered handler. */
  tick(): void {
    if (!this.handler || this.interval === undefined) {
      return;
    }
    this.clock.advance(this.interval);
    this.handler();
  }
}

/**
 * Timing-focused tests ensure the execution loop honours the configured
 * interval, supports pause/resume semantics and reports consistent timestamps.
 */
describe("execution loop timing", () => {
  it("fires ticks at the configured cadence without drift", async () => {
    const clock = new ManualClock();
    const scheduler = new ManualIntervalController(clock);
    const invocations: number[] = [];

    const loop = new ExecutionLoop({
      intervalMs: 50,
      now: () => clock.now(),
      setIntervalFn: (handler, interval) => scheduler.set(handler, interval),
      clearIntervalFn: () => scheduler.clear(),
      tick: ({ now }) => {
        invocations.push(now());
      },
    });

    loop.start();

    scheduler.tick();
    await loop.whenIdle();
    expect(invocations).to.deep.equal([50]);

    scheduler.tick();
    await loop.whenIdle();
    expect(invocations).to.deep.equal([50, 100]);

    expect(loop.pause()).to.equal(true);

    clock.advance(200);
    scheduler.tick();
    expect(invocations).to.deep.equal([50, 100]);

    expect(loop.resume()).to.equal(true);

    scheduler.tick();
    await loop.whenIdle();
    expect(invocations).to.deep.equal([50, 100, 350]);
    expect(loop.tickCount).to.equal(3);

    await loop.stop();
    expect(loop.isRunning).to.equal(false);
  });
});
