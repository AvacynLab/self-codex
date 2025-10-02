import { describe, it } from "mocha";
import { expect } from "chai";

import { ExecutionLoop, LoopReconciler, LoopTickContext } from "../src/executor/loop.js";

/** Manual timer stub exposing hooks to trigger scheduled ticks deterministically. */
class ManualTimer {
  public handler: (() => void) | null = null;

  schedule(handler: () => void): NodeJS.Timeout {
    this.handler = handler;
    return {} as NodeJS.Timeout;
  }

  clear(): void {
    this.handler = null;
  }
}

/** Validates that reconcilers are invoked after every tick with the proper context. */
describe("executor loop reconcilers", () => {
  it("calls reconcilers once per tick", async () => {
    const timer = new ManualTimer();
    const observedContexts: LoopTickContext[] = [];
    let clock = 0;

    const reconcilers: LoopReconciler[] = [
      {
        async reconcile(context) {
          observedContexts.push(context);
        },
      },
    ];

    const loop = new ExecutionLoop({
      intervalMs: 1,
      tick: () => {
        clock += 5;
      },
      now: () => clock,
      setIntervalFn: (handler, _interval) => timer.schedule(handler),
      clearIntervalFn: () => timer.clear(),
      reconcilers,
    });

    loop.start();
    expect(timer.handler).to.be.a("function");

    timer.handler?.();
    await loop.whenIdle();
    timer.handler?.();
    await loop.whenIdle();

    expect(observedContexts.map((ctx) => ctx.tickIndex)).to.deep.equal([0, 1]);
    expect(observedContexts.every((ctx) => ctx.startedAt <= clock)).to.equal(true);

    await loop.stop();
  });
});
