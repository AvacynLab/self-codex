import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import type { PlanToolContext } from "../src/tools/planTools.js";
import {
  PlanRunReactiveInputSchema,
  handlePlanRunReactive,
} from "../src/tools/planTools.js";
import { createPlanToolContext, createSpyPlanLogger } from "./helpers/planContext.js";

// This suite focuses on repeatedly executing the reactive plan runner to ensure that
// fake timers, autoscaler feedback, and supervisor snapshots remain deterministic
// when exercised back-to-back. Historically these components were the most
// flake-prone because timing jitter or lingering observers could leak between
// runs. Replaying the same scenario ten times detects regressions without
// blowing up CI durations.

describe("plan_run_reactive flakiness guard", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  function buildContext(): PlanToolContext {
    const { logger } = createSpyPlanLogger();
    return createPlanToolContext({
      logger,
      emitEvent: sinon.spy(),
    });
  }

  it("stays stable across ten sequential executions", async () => {
    const executions = 10;
    const context = buildContext();

    for (let iteration = 0; iteration < executions; iteration += 1) {
      // Each iteration uses a fresh payload to ensure variable resolution stays
      // deterministic even when the tree executes rapidly.
      const input = PlanRunReactiveInputSchema.parse({
        tree: {
          id: `flaky-${iteration}`,
          root: {
            type: "task",
            id: "echo",
            node_id: "echo",
            tool: "noop",
            input_key: "payload",
          },
        },
        variables: { payload: { iteration } },
        tick_ms: 10,
      });

      const resultPromise = handlePlanRunReactive(context, input);
      await clock.tickAsync(10);
      const result = await resultPromise;

      expect(result.status).to.equal("success");
      expect(result.loop_ticks).to.equal(1);
      expect(result.scheduler_ticks).to.be.greaterThanOrEqual(1);
      expect(result.last_output).to.deep.equal({ iteration });
    }
  });
});
