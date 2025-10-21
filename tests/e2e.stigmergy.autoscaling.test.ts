import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { PlanCompileBTInputSchema, handlePlanCompileBT } from "../src/tools/planTools.js";
import type { HierGraph } from "../src/graph/hierarchy.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { BlackboardStore } from "../src/coord/blackboard.js";
import type { AutoscalerSupervisor } from "../src/agents/autoscaler.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";
import type { CreateChildOptions } from "../src/children/supervisor.js";
import { BehaviorTreeInterpreter, buildBehaviorTree } from "../src/executor/bt/interpreter.js";
import type { BehaviorTickResult } from "../src/executor/bt/types.js";
import { ReactiveScheduler } from "../src/executor/reactiveScheduler.js";
import { createPlanToolContext } from "./helpers/planContext.js";

class ScriptedAutoscaler {
  public readonly backlogHistory: number[] = [];
  public readonly samples: Array<{ durationMs: number; success: boolean }> = [];

  private currentBacklog = 0;
  private scaledChildId: string | null = null;
  private retired = false;

  constructor(private readonly supervisor: AutoscalerSupervisor) {}

  updateBacklog(value: number): void {
    this.currentBacklog = value;
    this.backlogHistory.push(value);
  }

  recordTaskResult(sample: { durationMs: number; success: boolean }): void {
    this.samples.push(sample);
  }

  async reconcile(): Promise<void> {
    if (!this.scaledChildId && this.currentBacklog >= 3) {
      await this.supervisor.createChild();
      const latest = this.supervisor.childrenIndex.list().at(-1);
      this.scaledChildId = latest?.childId ?? null;
      return;
    }

    if (this.scaledChildId && !this.retired && this.currentBacklog === 0) {
      await this.supervisor.cancel(this.scaledChildId);
      this.retired = true;
    }
  }
}

function buildScheduler(
  interpreter: BehaviorTreeInterpreter,
  autoscaler: ScriptedAutoscaler,
): ReactiveScheduler {
  return new ReactiveScheduler({
    interpreter,
    runtime: {
      async invokeTool(_tool: string, input: unknown): Promise<unknown> {
        return input;
      },
      now: () => Date.now(),
      wait: async (ms: number) => {
        if (ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        }
      },
      variables: { payload: { message: "hydrate" } },
    },
    now: () => Date.now(),
    onTick: (trace) => {
      autoscaler.updateBacklog(trace.pendingAfter);
      autoscaler.recordTaskResult({
        durationMs: Math.max(0, trace.finishedAt - trace.startedAt),
        success: trace.result.status !== "failure",
      });
    },
  });
}

describe("stigmergy driven autoscaling", function () {
  this.timeout(5000);

  it("scales up under stigmergy pressure then scales down once backlog clears", async () => {
    const children: ChildRecordSnapshot[] = [];
    const createChild = sinon.spy((options?: CreateChildOptions) => {
      const childId = options?.childId ?? `child_${children.length + 1}`;
      children.push({
        childId,
        pid: 0,
        workdir: `/tmp/${childId}`,
        state: "ready",
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        retries: 0,
        metadata: {},
        endedAt: null,
        exitCode: null,
        exitSignal: null,
        forcedTermination: false,
        stopReason: null,
        role: null,
        limits: null,
        attachedAt: null,
      });
      return Promise.resolve();
    });
    const cancelChild = sinon.spy((childId: string) => {
      const index = children.findIndex((child) => child.childId === childId);
      if (index >= 0) {
        children.splice(index, 1);
      }
      return Promise.resolve();
    });

    const supervisor: AutoscalerSupervisor = {
      childrenIndex: { list: () => children.map((child) => ({ ...child })) },
      createChild: createChild as AutoscalerSupervisor["createChild"],
      cancel: cancelChild as AutoscalerSupervisor["cancel"],
    };

    const autoscaler = new ScriptedAutoscaler(supervisor);

    const compileContext = createPlanToolContext({
      // The helper surfaces a fully typed plan context so the compilation step stays faithful to
      // production wiring without reaching for structural casts in the test fixture.
      stigmergy: new StigmergyField(),
      blackboard: new BlackboardStore(),
    });

    const hierGraph: HierGraph = {
      id: "stigmergy-autoscale",
      nodes: [
        {
          id: "ingest",
          kind: "task",
          attributes: { bt_tool: "noop", bt_input_key: "payload" },
        },
      ],
      edges: [],
    };

    const compiled = handlePlanCompileBT(
      compileContext,
      PlanCompileBTInputSchema.parse({ graph: hierGraph }),
    );

    const interpreter = new BehaviorTreeInterpreter(buildBehaviorTree(compiled.root));

    // First run with stigmergic pressure to trigger scale-up.
    const stigField = new StigmergyField();
    const scheduler = buildScheduler(interpreter, autoscaler);
    const unsubscribe = stigField.onChange((change) => {
      scheduler.emit("stigmergyChanged", {
        nodeId: change.nodeId,
        intensity: change.totalIntensity,
        type: change.type,
      });
    });

    stigField.mark("ingest", "backlog", 2);
    stigField.mark("ingest", "backlog", 1);
    stigField.mark("ingest", "backlog", 1);
    stigField.mark("ingest", "backlog", 1);

    const rootId = (compiled.root as { node_id?: string; id?: string }).node_id ?? compiled.root.id;
    const firstResult: BehaviorTickResult = await scheduler.runUntilSettled({
      type: "taskReady",
      payload: { nodeId: rootId, criticality: 1 },
    });
    unsubscribe();
    await autoscaler.reconcile();

    expect(firstResult.status).to.equal("success");
    expect(createChild.calledOnce, "autoscaler should scale up").to.equal(true);
    expect(autoscaler.backlogHistory.some((value) => value >= 3)).to.equal(true);
    expect(children.length).to.equal(1);

    // Second run without additional stigmergy to trigger scale-down.
    const secondScheduler = buildScheduler(interpreter, autoscaler);
    const secondResult = await secondScheduler.runUntilSettled({
      type: "taskReady",
      payload: { nodeId: rootId, criticality: 1 },
    });
    await autoscaler.reconcile();

    expect(secondResult.status).to.equal("success");
    expect(cancelChild.calledOnce, "autoscaler should scale down when idle").to.equal(true);
    expect(children.length).to.equal(0);
  });
});
