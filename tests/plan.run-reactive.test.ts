import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import type { PlanToolContext } from "../src/tools/planTools.js";
import {
  PlanRunReactiveInputSchema,
  handlePlanRunReactive,
} from "../src/tools/planTools.js";
import {
  PlanLifecycleRegistry,
  type PlanLifecycleEvent,
} from "../src/executor/planLifecycle.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import {
  cancelRun,
  resetCancellationRegistry,
  OperationCancelledError,
} from "../src/executor/cancel.js";
import type { AutoscalerContract, AutoscalerConfig } from "../src/agents/autoscaler.js";
import type {
  OrchestratorSupervisorContract,
  SupervisorSchedulerSnapshot,
} from "../src/agents/supervisor.js";
import { createPlanToolContext, createSpyPlanLogger } from "./helpers/planContext.js";

class StubAutoscaler implements AutoscalerContract {
  public readonly id = "autoscaler";
  public backlogUpdates: number[] = [];
  public samples: Array<{ durationMs: number; success: boolean }> = [];
  public reconcileCalls = 0;
  private config: AutoscalerConfig = { minChildren: 0, maxChildren: 10, cooldownMs: 0 };

  updateBacklog(value: number): void {
    this.backlogUpdates.push(value);
  }

  recordTaskResult(sample: { durationMs: number; success: boolean }): void {
    this.samples.push(sample);
  }

  async reconcile(): Promise<void> {
    this.reconcileCalls += 1;
  }

  getConfiguration(): AutoscalerConfig {
    return { ...this.config };
  }

  configure(patch: Partial<AutoscalerConfig>): AutoscalerConfig {
    this.config = { ...this.config, ...patch };
    return this.getConfiguration();
  }
}

class StubSupervisorAgent implements OrchestratorSupervisorContract {
  public readonly id = "supervisor";
  public snapshots: Array<SupervisorSchedulerSnapshot & { updatedAt: number }> = [];
  public reconcileCalls = 0;

  recordSchedulerSnapshot(snapshot: SupervisorSchedulerSnapshot): void {
    this.snapshots.push({ ...snapshot, updatedAt: Date.now() });
  }

  getLastSchedulerSnapshot(): (SupervisorSchedulerSnapshot & { updatedAt: number }) | null {
    const last = this.snapshots.at(-1);
    if (!last) {
      return null;
    }
    return { ...last };
  }

  async recordLoopAlert(): Promise<void> {}

  async reconcile(): Promise<void> {
    this.reconcileCalls += 1;
  }
}

class RecordingLifecycle extends PlanLifecycleRegistry {
  public readonly events: PlanLifecycleEvent[] = [];

  override recordEvent(runId: string, event: PlanLifecycleEvent) {
    this.events.push({
      phase: event.phase,
      payload: structuredClone(event.payload) as Record<string, unknown>,
      timestamp: event.timestamp,
    });
    return super.recordEvent(runId, event);
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
    lifecycle?: PlanLifecycleRegistry;
    lifecycleEnabled?: boolean;
    events?: Array<{ kind: string; level?: string; payload?: unknown }>;
  } = {}): PlanToolContext {
    const events = options.events ?? [];
    const { logger } = createSpyPlanLogger();

    return createPlanToolContext({
      logger,
      stigmergy: new StigmergyField(),
      emitEvent: (event) => {
        events.push({ kind: event.kind, level: event.level, payload: event.payload });
      },
      autoscaler: options.autoscaler,
      supervisorAgent: options.supervisorAgent,
      planLifecycle: options.lifecycle,
      planLifecycleFeatureEnabled: options.lifecycleEnabled ?? (options.lifecycle ? true : undefined),
    });
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

  it("normalises Behaviour Tree cancellations raised by behaviour tools", async () => {
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = buildContext({ events });

    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "reactive-abort-demo",
        root: {
          type: "task",
          id: "abort-node",
          node_id: "abort-node",
          tool: "abort",
          input_key: "payload",
        },
      },
      variables: { payload: { attempt: 1 } },
      tick_ms: 25,
    });

    const executionPromise = handlePlanRunReactive(context, input);
    await clock.tickAsync(25);

    let caught: unknown;
    try {
      await executionPromise;
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(OperationCancelledError);
    const cancellationError = caught as OperationCancelledError;
    expect(cancellationError.details.reason).to.equal("behaviour tool aborted by test");

    const errorEvent = events.find((event) => {
      if (event.kind !== "BT_RUN" || !event.payload || typeof event.payload !== "object") {
        return false;
      }
      const phase = (event.payload as { phase?: unknown }).phase;
      return phase === "error";
    });
    expect(errorEvent, "expected lifecycle error event").to.exist;
    const payload = (errorEvent?.payload ?? null) as { status?: unknown; reason?: unknown } | null;
    expect(payload?.status).to.equal("cancelled");
    expect(payload?.reason).to.equal("behaviour tool aborted by test");
  });

  it("records loop reconcilers and scheduler events in lifecycle telemetry", async () => {
    const autoscaler = new StubAutoscaler();
    const supervisorAgent = new StubSupervisorAgent();
    const lifecycle = new RecordingLifecycle({ clock: () => clock.now });
    const context = buildContext({
      autoscaler,
      supervisorAgent,
      lifecycle,
      lifecycleEnabled: false,
    });

    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "telemetry",
        root: {
          type: "task",
          id: "root",
          node_id: "root",
          tool: "noop",
          input_key: "payload",
        },
      },
      variables: { payload: { value: 42 } },
      tick_ms: 25,
    });

    const execution = handlePlanRunReactive(context, input);
    await clock.tickAsync(25);
    const result = await execution;

    expect(result.status).to.equal("success");
    const phases = lifecycle.events.map((event) => event.phase);
    expect(phases).to.include("tick");
    expect(phases).to.include("loop");
    expect(phases).to.include("complete");

    const tickEvent = lifecycle.events.find((event) => event.phase === "tick");
    expect(tickEvent).to.not.equal(undefined);
    const tickPayload = tickEvent!.payload as Record<string, unknown>;
    expect(tickPayload.event_payload).to.be.an("object");
    const schedulerSummary = tickPayload.event_payload as Record<string, unknown>;
    expect(schedulerSummary.node_id).to.equal("root");
    expect(tickPayload.tick_duration_ms).to.be.a("number");
    const bounds = schedulerSummary.pheromone_bounds as
      | { min_intensity?: number; max_intensity?: number | null; normalisation_ceiling?: number }
      | null
      | undefined;
    expect(bounds).to.not.equal(undefined);
    expect(bounds?.min_intensity).to.equal(0);
    expect(bounds?.max_intensity).to.equal(null);
    expect(bounds?.normalisation_ceiling ?? 0).to.be.greaterThan(0);

    const loopEvent = lifecycle.events.find((event) => event.phase === "loop");
    expect(loopEvent).to.not.equal(undefined);
    const loopPayload = loopEvent!.payload as Record<string, unknown>;
    expect(loopPayload.reconcilers).to.be.an("array");
    const reconcilers = loopPayload.reconcilers as Array<Record<string, unknown>>;
    const reconcilerIds = reconcilers.map((item) => item.id);
    expect(reconcilerIds).to.include("autoscaler");
    expect(reconcilerIds).to.include("supervisor");
    expect(reconcilers.every((item) => typeof item.duration_ms === "number")).to.equal(true);
    expect(reconcilers.every((item) => item.status === "ok")).to.equal(true);
  });
});
