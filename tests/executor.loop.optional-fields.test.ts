import { describe, it } from "mocha";
import { expect } from "chai";

import {
  CooperativeBudget,
  ExecutionLoop,
  type LoopAfterTickDetails,
} from "../src/executor/loop.js";
import type { IntervalHandle } from "../src/runtime/timers.js";

/**
 * Execution loop telemetry must omit optional properties when no data is
 * available so the upcoming `exactOptionalPropertyTypes` enforcement does not
 * surface `undefined` placeholders.
 */
describe("execution loop optional field sanitisation", () => {
  it("omits absent budgets and drops undefined reconciler error messages", async () => {
    const intervalHandlers: Array<() => void> = [];
    const captured: LoopAfterTickDetails[] = [];

    const loop = new ExecutionLoop({
      intervalMs: 5,
      tick: () => undefined,
      reconcilers: [
        {
          id: "unstable",
          reconcile: () => {
            throw null;
          },
        },
      ],
      onError: () => {
        // Errors emitted by reconcilers are intentionally swallowed during the
        // test so assertions can focus on telemetry sanitisation.
      },
      now: () => 0,
      setIntervalFn: (handler: () => void): IntervalHandle => {
        intervalHandlers.push(handler);
        return intervalHandlers.length as unknown as IntervalHandle;
      },
      clearIntervalFn: () => undefined,
      afterTick: (details) => {
        captured.push({
          ...details,
          context: { ...details.context },
          reconcilers: details.reconcilers.map((entry) => ({ ...entry })),
        });
      },
    });

    loop.start();
    intervalHandlers[0]!();
    await loop.whenIdle();

    expect(captured).to.have.lengthOf(1);
    const snapshot = captured[0];

    expect(Object.prototype.hasOwnProperty.call(snapshot.context, "budget")).to.equal(false);
    expect(snapshot.reconcilers).to.have.lengthOf(1);
    const reconcilerTelemetry = snapshot.reconcilers[0] as Record<string, unknown>;
    expect(reconcilerTelemetry.status).to.equal("error");
    expect(Object.prototype.hasOwnProperty.call(reconcilerTelemetry, "errorMessage")).to.equal(false);

    await loop.stop();
  });

  it("surfaces cooperative budgets when ticks receive an allowance", async () => {
    const intervalHandlers: Array<() => void> = [];
    const captured: LoopAfterTickDetails[] = [];

    const loop = new ExecutionLoop({
      intervalMs: 5,
      tick: () => undefined,
      budgetMs: 10,
      now: () => 0,
      setIntervalFn: (handler: () => void): IntervalHandle => {
        intervalHandlers.push(handler);
        return intervalHandlers.length as unknown as IntervalHandle;
      },
      clearIntervalFn: () => undefined,
      afterTick: (details) => {
        captured.push({
          ...details,
          context: { ...details.context },
          reconcilers: details.reconcilers.map((entry) => ({ ...entry })),
        });
      },
    });

    loop.start();
    intervalHandlers[0]!();
    await loop.whenIdle();

    expect(captured).to.have.lengthOf(1);
    const [snapshot] = captured;
    expect(Object.prototype.hasOwnProperty.call(snapshot.context, "budget")).to.equal(true);
    expect(snapshot.context.budget).to.be.instanceOf(CooperativeBudget);

    await loop.stop();
  });
});
