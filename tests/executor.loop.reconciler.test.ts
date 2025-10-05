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
        id: "primary",
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

  it("surfaces reconciler telemetry via the afterTick hook", async () => {
    const timer = new ManualTimer();
    const recorded: Array<{ ids: string[]; statuses: string[]; errors: Array<string | null> }> = [];
    const observedErrors: unknown[] = [];
    let clock = 0;

    const reconcilers: LoopReconciler[] = [
      {
        id: "alpha",
        async reconcile() {
          clock += 2;
        },
      },
      {
        id: "bravo",
        async reconcile() {
          clock += 3;
          throw new Error("bravo failed");
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
      onError: (error) => {
        observedErrors.push(error);
      },
      afterTick: (details) => {
        recorded.push({
          ids: details.reconcilers.map((item) => item.id),
          statuses: details.reconcilers.map((item) => item.status),
          errors: details.reconcilers.map((item) => item.errorMessage ?? null),
        });
      },
    });

    loop.start();
    timer.handler?.();
    await loop.whenIdle();

    expect(recorded).to.have.length(1);
    const snapshot = recorded[0]!;
    expect(snapshot.ids).to.deep.equal(["alpha", "bravo"]);
    expect(snapshot.statuses).to.deep.equal(["ok", "error"]);
    expect(snapshot.errors).to.deep.equal([null, "bravo failed"]);
    expect(observedErrors).to.have.length(1);

    await loop.stop();
  });
});
