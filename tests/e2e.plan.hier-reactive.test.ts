import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import type { PlanToolContext } from "../src/tools/planTools.js";
import {
  PlanCompileBTInputSchema,
  PlanRunReactiveInputSchema,
  handlePlanCompileBT,
  handlePlanRunReactive,
} from "../src/tools/planTools.js";
import type { HierGraph } from "../src/graph/hierarchy.js";
import { BlackboardStore } from "../src/coord/blackboard.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { createPlanToolContext, createSpyPlanLogger } from "./helpers/planContext.js";

/** Build a minimal plan tool context with blackboard support for integration tests. */
function buildPlanContext(clock: sinon.SinonFakeTimers) {
  const { logger, spies: loggerSpies } = createSpyPlanLogger();
  const blackboard = new BlackboardStore({ now: () => clock.now });
  const context = createPlanToolContext({
    logger,
    stigmergy: new StigmergyField({ now: () => clock.now }),
    blackboard,
    emitEvent: () => {},
  });
  return { context, loggerSpies, blackboard };
}

describe("hierarchical plan → BT compile → reactive run", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("reorders scheduler ticks after a bb_set task updates the blackboard", async () => {
    const { context, loggerSpies, blackboard } = buildPlanContext(clock);

    const hierGraph: HierGraph = {
      id: "hier-e2e",
      nodes: [
        {
          id: "annotate",
          kind: "task",
          attributes: { bt_tool: "bb_set", bt_input_key: "bb_update" },
        },
        {
          id: "dispatch",
          kind: "task",
          attributes: { bt_tool: "noop", bt_input_key: "dispatch" },
        },
      ],
      edges: [
        { id: "annotate->dispatch", from: { nodeId: "annotate" }, to: { nodeId: "dispatch" } },
      ],
    };

    const compiled = handlePlanCompileBT(
      context,
      PlanCompileBTInputSchema.parse({ graph: hierGraph }),
    );

    const execution = handlePlanRunReactive(
      context,
      PlanRunReactiveInputSchema.parse({
        tree: compiled,
        variables: {
          bb_update: { key: "priority-task", value: { state: "ready" }, tags: ["critical"] },
          dispatch: { message: "processed" },
        },
        tick_ms: 25,
      }),
    );

    await clock.tickAsync(25);
    const result = await execution;

    expect(result.status).to.equal("success");
    expect(result.invocations.map((entry) => entry.tool)).to.deep.equal(["bb_set", "noop"]);
    expect(blackboard.get("priority-task")).to.not.equal(undefined);
    expect(result.scheduler_ticks).to.be.greaterThan(0);
    expect(
      loggerSpies.info.calledWithMatch(
        "plan_run_reactive_blackboard_event",
        sinon.match({ key: "priority-task" }),
      ),
    ).to.equal(true);
  });
});
