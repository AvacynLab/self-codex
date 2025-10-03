import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  PlanRunBTInputSchema,
  PlanRunReactiveInputSchema,
  handlePlanRunBT,
  handlePlanRunReactive,
  type PlanToolContext,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";

interface RecordedEvent {
  kind: string;
  payload?: unknown;
  jobId?: string | null;
  childId?: string | null;
}

describe("plan behaviour tree events", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  function buildContext(): { context: PlanToolContext; events: RecordedEvent[] } {
    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
      debug: sinon.spy(),
    } as unknown as PlanToolContext["logger"];
    const events: RecordedEvent[] = [];
    const context: PlanToolContext = {
      supervisor: {} as PlanToolContext["supervisor"],
      graphState: {} as PlanToolContext["graphState"],
      logger,
      childrenRoot: "/tmp",
      defaultChildRuntime: "codex",
      emitEvent: (event) => {
        events.push({
          kind: event.kind,
          payload: event.payload,
          jobId: event.jobId ?? null,
          childId: event.childId ?? null,
        });
      },
      stigmergy: new StigmergyField(),
    };
    return { context, events };
  }

  it("emits correlated lifecycle events for plan_run_bt", async () => {
    const { context, events } = buildContext();
    const input = PlanRunBTInputSchema.parse({
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
    });

    const result = await handlePlanRunBT(context, input);

    expect(result.run_id).to.be.a("string").and.to.have.length.greaterThan(0);
    expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
    expect(result.job_id).to.equal(null);
    expect(result.graph_id).to.equal(null);
    expect(result.node_id).to.equal(null);
    expect(result.child_id).to.equal(null);
    expect(result.idempotent).to.equal(false);
    expect(result.idempotency_key).to.equal(null);

    const startEvent = events.find((evt) => (evt.payload as { phase?: string })?.phase === "start");
    expect(startEvent, "start event present").to.exist;
    expect((startEvent!.payload as { mode?: string }).mode).to.equal("bt");
    expect((startEvent!.payload as { run_id?: string }).run_id).to.equal(result.run_id);

    const nodeEvents = events.filter((evt) => (evt.payload as { phase?: string })?.phase === "node");
    expect(nodeEvents.length).to.be.greaterThan(0);
    for (const evt of nodeEvents) {
      const payload = evt.payload as { run_id?: string; op_id?: string };
      expect(payload.run_id).to.equal(result.run_id);
      expect(payload.op_id).to.equal(result.op_id);
    }

    const completeEvent = events.find((evt) => (evt.payload as { phase?: string })?.phase === "complete");
    expect(completeEvent, "complete event present").to.exist;
    expect((completeEvent!.payload as { status?: string }).status).to.equal(result.status);
  });

  it("propagates provided correlation hints for plan_run_bt telemetry", async () => {
    const { context, events } = buildContext();
    const input = PlanRunBTInputSchema.parse({
      tree: {
        id: "demo-correlated",
        root: {
          type: "task",
          id: "root",
          node_id: "root",
          tool: "noop",
          input_key: "payload",
        },
      },
      variables: { payload: { message: "ping" } },
      run_id: "bt-run-123",
      op_id: "bt-op-456",
      job_id: "job-789",
      graph_id: "graph-42",
      node_id: "plan-node-1",
      child_id: "child-17",
    });

    const result = await handlePlanRunBT(context, input);

    expect(result.run_id).to.equal("bt-run-123");
    expect(result.op_id).to.equal("bt-op-456");
    expect(result.job_id).to.equal("job-789");
    expect(result.graph_id).to.equal("graph-42");
    expect(result.node_id).to.equal("plan-node-1");
    expect(result.child_id).to.equal("child-17");
    expect(result.idempotent).to.equal(false);
    expect(result.idempotency_key).to.equal(null);

    const startEvent = events.find((evt) => (evt.payload as { phase?: string })?.phase === "start");
    expect(startEvent, "start event present").to.exist;
    const startPayload = startEvent!.payload as {
      run_id?: string | null;
      op_id?: string | null;
      job_id?: string | null;
      graph_id?: string | null;
      node_id?: string | null;
      child_id?: string | null;
    };
    expect(startEvent!.jobId).to.equal("job-789");
    expect(startPayload.run_id).to.equal("bt-run-123");
    expect(startPayload.op_id).to.equal("bt-op-456");
    expect(startPayload.job_id).to.equal("job-789");
    expect(startPayload.graph_id).to.equal("graph-42");
    expect(startPayload.node_id).to.equal("plan-node-1");
    expect(startPayload.child_id).to.equal("child-17");
  });

  it("tracks reactive scheduler phases with consistent identifiers", async () => {
    const { context, events } = buildContext();
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
      variables: { payload: { message: "pong" } },
      tick_ms: 25,
    });

    const execution = handlePlanRunReactive(context, input);
    await clock.tickAsync(25);
    const result = await execution;

    expect(result.run_id).to.be.a("string").and.to.have.length.greaterThan(0);
    expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
    expect(result.job_id).to.equal(null);
    expect(result.graph_id).to.equal(null);
    expect(result.node_id).to.equal(null);
    expect(result.child_id).to.equal(null);

    const phases = events
      .map((evt) => (evt.payload as { phase?: string })?.phase)
      .filter((value): value is string => Boolean(value));
    expect(phases).to.include("start");
    expect(phases).to.include("tick");
    expect(phases).to.include("complete");

    const distinctRunIds = new Set(
      events
        .map((evt) => (evt.payload as { run_id?: string })?.run_id)
        .filter((value): value is string => typeof value === "string"),
    );
    expect(distinctRunIds.size).to.equal(1);
    expect([...distinctRunIds][0]).to.equal(result.run_id);
  });

  it("propagates provided correlation hints for plan_run_reactive telemetry", async () => {
    const { context, events } = buildContext();
    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "demo-reactive",
        root: {
          type: "task",
          id: "root",
          node_id: "root",
          tool: "noop",
          input_key: "payload",
        },
      },
      variables: { payload: { message: "pong" } },
      tick_ms: 15,
      run_id: "reactive-run",
      op_id: "reactive-op",
      job_id: "job-reactive",
      graph_id: "graph-reactive",
      node_id: "node-reactive",
      child_id: "child-reactive",
    });

    const execution = handlePlanRunReactive(context, input);
    await clock.tickAsync(15);
    const result = await execution;

    expect(result.run_id).to.equal("reactive-run");
    expect(result.op_id).to.equal("reactive-op");
    expect(result.job_id).to.equal("job-reactive");
    expect(result.graph_id).to.equal("graph-reactive");
    expect(result.node_id).to.equal("node-reactive");
    expect(result.child_id).to.equal("child-reactive");
    expect(result.idempotent).to.equal(false);
    expect(result.idempotency_key).to.equal(null);

    const startEvent = events.find((evt) => (evt.payload as { phase?: string })?.phase === "start");
    expect(startEvent, "start event present").to.exist;
    const startPayload = startEvent!.payload as {
      run_id?: string | null;
      op_id?: string | null;
      job_id?: string | null;
      graph_id?: string | null;
      node_id?: string | null;
      child_id?: string | null;
    };
    expect(startEvent!.jobId).to.equal("job-reactive");
    expect(startPayload.run_id).to.equal("reactive-run");
    expect(startPayload.op_id).to.equal("reactive-op");
    expect(startPayload.job_id).to.equal("job-reactive");
    expect(startPayload.graph_id).to.equal("graph-reactive");
    expect(startPayload.node_id).to.equal("node-reactive");
    expect(startPayload.child_id).to.equal("child-reactive");
  });
});
