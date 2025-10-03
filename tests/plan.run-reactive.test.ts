import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import type { PlanToolContext } from "../src/tools/planTools.js";
import {
  PlanRunReactiveInputSchema,
  handlePlanRunReactive,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import {
  cancelRun,
  resetCancellationRegistry,
  OperationCancelledError,
} from "../src/executor/cancel.js";

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
    resetCancellationRegistry();
  });

  afterEach(() => {
    clock.restore();
  });

  function buildContext(options: {
    autoscaler?: StubAutoscaler;
    supervisorAgent?: StubSupervisorAgent;
    events?: Array<{ kind: string; level?: string; payload?: unknown }>;
  } = {}): PlanToolContext {
    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
      debug: sinon.spy(),
    } as unknown as PlanToolContext["logger"];

    const events = options.events ?? [];
    return {
      supervisor: {} as PlanToolContext["supervisor"],
      graphState: {} as PlanToolContext["graphState"],
      logger,
      childrenRoot: "/tmp",
      defaultChildRuntime: "codex",
      emitEvent: (event) => {
        events.push({ kind: event.kind, level: event.level, payload: event.payload });
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
    expect(result.idempotent).to.equal(false);
    expect(result.idempotency_key).to.equal(null);
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
    expect(result.idempotent).to.equal(false);
    expect(result.idempotency_key).to.equal(null);
    expect(result.invocations).to.have.length(1);
    expect(result.invocations[0]).to.include({ executed: false, output: null });
    expect(result.last_output).to.equal(null);
  });

  it("aborts the reactive run when cancellation is requested", async () => {
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = buildContext({ events });

    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "cancel-demo",
        root: {
          type: "retry",
          id: "retry-node",
          max_attempts: 5,
          backoff_ms: 1_000,
          child: {
            type: "guard",
            condition_key: "allow",
            expected: true,
            child: {
              type: "task",
              id: "noop-node",
              node_id: "noop-node",
              tool: "noop",
              input_key: "payload",
            },
          },
        },
      },
      variables: { allow: false, payload: { count: 0 } },
      tick_ms: 25,
    });

    const executionPromise = handlePlanRunReactive(context, input);

    const startEvent = events.find((event) => {
      if (event.kind !== "BT_RUN" || !event.payload || typeof event.payload !== "object") {
        return false;
      }
      return (event.payload as Record<string, unknown>).phase === "start";
    });
    expect(startEvent, "expected BT_RUN start event").to.exist;
    const startPayload = startEvent?.payload as Record<string, unknown> | undefined;
    const runId = String((startPayload?.run_id ?? "") as string);
    expect(runId).to.have.length.greaterThan(0);

    await clock.tickAsync(25);

    const cancelOutcomes = cancelRun(runId, { reason: "test" });
    expect(cancelOutcomes).to.have.length(1);
    expect(cancelOutcomes[0]?.outcome).to.equal("requested");

    let caught: unknown;
    try {
      await executionPromise;
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(OperationCancelledError);

    const cancelEvent = events.find((event) => {
      if (event.kind !== "BT_RUN" || !event.payload || typeof event.payload !== "object") {
        return false;
      }
      return (event.payload as Record<string, unknown>).phase === "cancel";
    });
    expect(cancelEvent, "expected cancellation lifecycle event").to.exist;
    const cancelPayload = cancelEvent?.payload as Record<string, unknown> | undefined;
    expect(cancelPayload?.reason).to.equal("test");
  });
});
