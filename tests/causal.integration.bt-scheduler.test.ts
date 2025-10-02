import { describe, it } from "mocha";
import { expect } from "chai";

import { handlePlanRunBT, type PlanToolContext } from "../src/tools/planTools.js";
import { CausalMemory } from "../src/knowledge/causalMemory.js";
import { StructuredLogger } from "../src/logger.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import type { ChildSupervisor } from "../src/childSupervisor.js";
import type { GraphState } from "../src/graphState.js";

/** Manual clock controlling timestamps for deterministic assertions. */
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
 * Integration test verifying that the Behaviour Tree scheduler records causal
 * events when the feature toggle is enabled.
 */
describe("causal memory integration with BT scheduler", () => {
  it("records scheduler ticks and tool invocations", async () => {
    const clock = new ManualClock();
    const memory = new CausalMemory({ now: () => clock.now() });
    const context = {
      supervisor: {} as ChildSupervisor,
      graphState: {} as GraphState,
      logger: new StructuredLogger(),
      childrenRoot: "/tmp",
      defaultChildRuntime: "codex",
      emitEvent: () => undefined,
      stigmergy: new StigmergyField({ now: () => clock.now() }),
      supervisorAgent: undefined,
      causalMemory: memory,
    } satisfies PlanToolContext;

    const result = await handlePlanRunBT(context, {
      tree: {
        id: "bt-test",
        root: { type: "task", node_id: "root-task", tool: "noop" },
      },
      dry_run: false,
      variables: {},
    });

    expect(result.status).to.equal("success");
    expect(result.invocations).to.have.length(1);

    const events = memory.exportAll();
    expect(events.map((event) => event.type)).to.deep.equal([
      "scheduler.event.taskReady",
      "scheduler.tick.start",
      "bt.tool.invoke",
      "bt.tool.success",
      "scheduler.tick.result",
    ]);

    const [taskReady, tickStart, toolInvoke, toolSuccess, tickResult] = events;
    expect(tickStart.causes).to.deep.equal([taskReady.id]);
    expect(toolInvoke.causes).to.deep.equal([tickStart.id]);
    expect(toolSuccess.causes).to.deep.equal([toolInvoke.id]);
    expect(tickResult.causes).to.deep.equal([tickStart.id]);

    const explanation = memory.explain(tickResult.id);
    expect(explanation.ancestors.map((event) => event.id)).to.deep.equal([
      taskReady.id,
      tickStart.id,
    ]);
  });
});
