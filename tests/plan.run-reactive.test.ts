import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import type { PlanToolContext } from "../src/tools/planTools.js";
import {
  PlanRunReactiveInputSchema,
  handlePlanRunReactive,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";

class StubAutoscaler {
  public backlogUpdates: number[] = [];
  public samples: Array<{ durationMs: number; success: boolean }> = [];
  public reconcileCalls = 0;

  updateBacklog(value: number): void {
    this.backlogUpdates.push(value);
  }

  recordTaskResult(sample: { durationMs: number; success: boolean }): void {
    this.samples.push(sample);
  }

  async reconcile(): Promise<void> {
    this.reconcileCalls += 1;
  }
}

class StubSupervisorAgent {
  public snapshots: Array<{ backlog: number }> = [];
  public reconcileCalls = 0;

  recordSchedulerSnapshot(snapshot: { backlog: number }): void {
    this.snapshots.push({ backlog: snapshot.backlog });
  }

  async reconcile(): Promise<void> {
    this.reconcileCalls += 1;
  }
}

describe("plan_run_reactive tool", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  function buildContext(options: {
    autoscaler?: StubAutoscaler;
    supervisorAgent?: StubSupervisorAgent;
  } = {}): PlanToolContext {
    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
      debug: sinon.spy(),
    } as unknown as PlanToolContext["logger"];

    const events: Array<{ kind: string }> = [];
    return {
      supervisor: {} as PlanToolContext["supervisor"],
      graphState: {} as PlanToolContext["graphState"],
      logger,
      childrenRoot: "/tmp",
      defaultChildRuntime: "codex",
      emitEvent: (event) => {
        events.push({ kind: event.kind });
      },
      stigmergy: new StigmergyField(),
      autoscaler: options.autoscaler as unknown as PlanToolContext["autoscaler"],
      supervisorAgent: options.supervisorAgent as unknown as PlanToolContext["supervisorAgent"],
    } satisfies PlanToolContext;
  }

  it("runs the reactive loop and surfaces scheduler telemetry", async () => {
    const autoscaler = new StubAutoscaler();
    const supervisorAgent = new StubSupervisorAgent();
    const context = buildContext({ autoscaler, supervisorAgent });

    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "demo",
        root: {
          type: "task",
          id: "root",
          node_id: "root",
          tool: "noop",
          input_key: "payload",
        },
      },
      variables: { payload: { message: "ping" } },
      tick_ms: 25,
    });

    const execution = handlePlanRunReactive(context, input);
    await clock.tickAsync(25);
    const result = await execution;

    expect(result.status).to.equal("success");
    expect(result.loop_ticks).to.equal(1);
    expect(result.scheduler_ticks).to.be.greaterThanOrEqual(1);
    expect(result.invocations).to.have.length(1);
    expect(result.invocations[0]).to.include({ tool: "noop", executed: true });
    expect(result.last_output).to.deep.equal({ message: "ping" });

    expect(autoscaler.backlogUpdates.length).to.be.greaterThan(0);
    expect(autoscaler.samples.length).to.be.greaterThan(0);
    expect(autoscaler.reconcileCalls).to.be.greaterThan(0);

    expect(supervisorAgent.snapshots.length).to.be.greaterThan(0);
    expect(supervisorAgent.reconcileCalls).to.be.greaterThan(0);
  });

  it("supports dry-run execution without invoking behaviour tools", async () => {
    const context = buildContext();
    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "dry-demo",
        root: {
          type: "task",
          id: "noop-node",
          node_id: "noop-node",
          tool: "noop",
          input_key: "payload",
        },
      },
      variables: { payload: { count: 1 } },
      tick_ms: 20,
      dry_run: true,
    });

    const execution = handlePlanRunReactive(context, input);
    await clock.tickAsync(20);
    const result = await execution;

    expect(result.status).to.equal("success");
    expect(result.invocations).to.have.length(1);
    expect(result.invocations[0]).to.include({ executed: false, output: null });
    expect(result.last_output).to.equal(null);
  });
});
