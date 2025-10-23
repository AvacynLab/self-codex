import { expect } from "chai";

import { EventBus } from "../../src/events/bus.js";
import {
  EVENT_MESSAGES,
  assertValidEventMessage,
  isEventMessage,
  type EventMessage,
} from "../../src/events/types.js";
import type {
  ChildSupervisorEventPayload,
  ChildSupervisorLimitsUpdatedPayload,
  HeartbeatEventPayload,
  IntrospectionProbePayload,
  JsonRpcRequestPayload,
  ChildMetaReviewEventPayload,
  ChildReflectionEventPayload,
  PlanAggregateEventPayload,
  PlanEventPayload,
  PlanLifecycleEventPayload,
  PlanStatusEventPayload,
  PromptEventPayload,
  SchedulerTelemetryPayload,
  AutoscalerTelemetryPayload,
} from "../../src/events/types.js";
import type { SupervisorEvent } from "../../src/children/supervisionStrategy.js";
import { buildLessonsPromptPayload } from "../../src/learning/lessonPromptDiff.js";

/**
 * Minimal child stdout payload leveraged to drive the event bus without
 * re-specifying the discriminated union in every assertion.
 */
function createChildPayload() {
  return {
    childId: "child-bus",
    stream: "stdout" as const,
    raw: "payload",
    parsed: null,
    receivedAt: 0,
    sequence: 0,
  };
}

/**
 * Converts arbitrary strings into {@link EventMessage} instances so the tests
 * can emulate dynamic JavaScript callers. The returned value intentionally
 * bypasses the compile-time catalogue to ensure the runtime guard is exercised
 * without resorting to double casts.
 */
function coerceToEventMessage(token: string): EventMessage {
  return token as EventMessage;
}

/**
 * Regression tests covering the typed event bus contract. The suite exercises the
 * runtime guards that prevent publishers from emitting ad-hoc message tokens so
 * downstream dashboards only observe the curated catalogue declared in
 * {@link EVENT_MESSAGES}.
 */
describe("events/bus type safety", () => {
  it("exposes a non-empty catalogue of allowed event messages", () => {
    expect(EVENT_MESSAGES.length, "known event message count").to.be.greaterThan(0);
  });

  it("recognises every canonical event message token", () => {
    for (const token of EVENT_MESSAGES) {
      expect(isEventMessage(token), `isEventMessage(${token})`).to.equal(true);
      expect(() => assertValidEventMessage(token), `assertValidEventMessage(${token})`).not.to.throw();
    }
  });

  it("rejects unknown message tokens", () => {
    const invalidToken = "made_up_event";

    expect(isEventMessage(invalidToken)).to.equal(false);
    expect(() => assertValidEventMessage(invalidToken)).to.throw(TypeError, /unknown event message/);
  });

  it("prevents publishing events with unknown message identifiers", () => {
    const bus = new EventBus({ now: () => 42 });

    expect(() =>
      bus.publish({
        cat: "child",
        // Use the helper to mimic unchecked JavaScript callers. The runtime guard must still throw.
        msg: coerceToEventMessage("totally_unknown_message"),
      }),
    ).to.throw(TypeError, /unknown event message/);
  });

  it("normalises valid message tokens before storing envelopes", () => {
    const bus = new EventBus({ now: () => 42 });

    const envelope = bus.publish({
      cat: "child",
      msg: coerceToEventMessage("  child_stdout  "),
      data: createChildPayload(),
    });

    expect(envelope.msg).to.equal("child_stdout");
    expect(bus.list()).to.have.lengthOf(1);
    expect(bus.list()[0].msg).to.equal("child_stdout");
  });

  it("omits optional kind and data fields when publishers provide minimal payloads", () => {
    const bus = new EventBus({ now: () => 51 });

    const envelope = bus.publish({
      cat: "child",
      msg: "child_stdout",
    });

    expect(Object.hasOwn(envelope, "kind"), "kind is materialised only when provided").to.equal(false);
    expect(Object.hasOwn(envelope, "data"), "data property stays absent when omitted").to.equal(false);
    expect(envelope.component).to.equal("child");
    expect(envelope.stage).to.equal("child_stdout");
    expect(envelope.elapsedMs).to.equal(null);
  });

  it("persists published envelopes by reference without cloning the payload", () => {
    const bus = new EventBus({ now: () => 21 });
    const payload = createChildPayload();

    const envelope = bus.publish({
      cat: "child",
      msg: "child_stdout",
      data: payload,
    });

    const [stored] = bus.list();
    expect(stored).to.equal(envelope);
    expect(stored.data).to.deep.equal(payload);
  });

  it("accepts structured child cognitive payloads", () => {
    const bus = new EventBus({ now: () => 303 });

    const reviewPayload: ChildMetaReviewEventPayload = {
      msg: "child_meta_review",
      child_id: "child-cognitive",
      job_id: "job-cognitive",
      run_id: "run-cognitive",
      op_id: "op-cognitive",
      graph_id: "graph-cognitive",
      node_id: "node-cognitive",
      summary: {
        kind: "plan",
        text: "Synthèse structurée",
        tags: ["plan", "cognitive"],
      },
      review: {
        overall: 0.9,
        verdict: "pass",
        feedback: ["Livrable exploitable"],
        suggestions: ["Poursuivre les itérations"],
        breakdown: [
          { criterion: "clarity", score: 0.9, reasoning: "Structure lisible" },
        ],
      },
      metrics: {
        artifacts: 2,
        messages: 4,
      },
      quality_assessment: {
        kind: "plan",
        score: 0.82,
        rubric: { coverage: 0.75 },
        metrics: { coverage: 0.75, coherence: 0.8 },
        gate: { enabled: true, threshold: 0.8, needs_revision: false },
      },
    };

    const reviewEnvelope = bus.publish({
      cat: "child",
      msg: reviewPayload.msg,
      data: reviewPayload,
      childId: reviewPayload.child_id,
      jobId: reviewPayload.job_id,
    });

    expect(reviewEnvelope.msg).to.equal("child_meta_review");
    expect(reviewEnvelope.data).to.deep.equal(reviewPayload);

    const reflectionPayload: ChildReflectionEventPayload = {
      msg: "child_reflection",
      child_id: "child-cognitive",
      job_id: "job-cognitive",
      run_id: "run-cognitive",
      op_id: "op-cognitive",
      graph_id: "graph-cognitive",
      node_id: "node-cognitive",
      summary: {
        kind: "plan",
        text: "Synthèse structurée",
        tags: ["plan", "cognitive"],
      },
      reflection: {
        insights: ["Sortie exploitable"],
        next_steps: ["Préparer la restitution"],
        risks: ["Surveiller la couverture"],
      },
    };

    const reflectionEnvelope = bus.publish({
      cat: "child",
      msg: reflectionPayload.msg,
      data: reflectionPayload,
      childId: reflectionPayload.child_id,
      jobId: reflectionPayload.job_id,
    });

    expect(reflectionEnvelope.msg).to.equal("child_reflection");
    expect(reflectionEnvelope.data).to.deep.equal(reflectionPayload);
  });

  it("accepts structured JSON-RPC observability payloads", () => {
    const bus = new EventBus({ now: () => 99 });
    const payload: JsonRpcRequestPayload = {
      msg: "jsonrpc_request",
      method: "tools/call",
      metric_method: "tools/call",
      tool: "plan_pause",
      request_id: "req-jsonrpc-types",
      transport: "http",
      status: "pending",
      elapsed_ms: null,
      trace_id: null,
      span_id: null,
      duration_ms: null,
      bytes_in: null,
      bytes_out: null,
      run_id: null,
      op_id: null,
      child_id: null,
      job_id: null,
      idempotency_key: null,
      error_message: null,
      error_code: null,
      timeout_ms: null,
    };

    const envelope = bus.publish({
      cat: "scheduler",
      msg: payload.msg,
      data: payload,
      component: "jsonrpc",
      stage: payload.msg,
    });

    expect(envelope.msg).to.equal("jsonrpc_request");
    expect(envelope.data).to.deep.equal(payload);
  });

  it("allows JSON-RPC publishers to omit optional telemetry metrics entirely", () => {
    const bus = new EventBus({ now: () => 100 });
    const payload: JsonRpcRequestPayload = {
      msg: "jsonrpc_request",
      method: "tools/call",
      metric_method: "tools/call",
      tool: null,
      request_id: "req-jsonrpc-minimal",
      status: "pending",
      run_id: null,
      op_id: null,
      child_id: null,
      job_id: null,
      error_message: null,
      error_code: null,
    };

    const envelope = bus.publish({
      cat: "scheduler",
      msg: payload.msg,
      data: payload,
      component: "jsonrpc",
      stage: payload.msg,
    });

    expect(envelope.msg).to.equal("jsonrpc_request");
    // Convert the payload to a loose record so assertions can focus on
    // property presence without upsetting TypeScript's discriminated union.
    const raw = envelope.data as Record<string, unknown> | undefined;
    expect(raw).to.not.equal(undefined);
    expect(Object.prototype.hasOwnProperty.call(raw, "transport")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "elapsed_ms")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "trace_id")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "span_id")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "duration_ms")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "bytes_in")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "bytes_out")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "idempotency_key")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(raw, "timeout_ms")).to.equal(false);
  });

  it("accepts structured introspection probe payloads", () => {
    const bus = new EventBus({ now: () => 101 });
    const payload: IntrospectionProbePayload = {
      msg: "introspection_probe",
      stage: "introspection",
      emitted_at: new Date(1_725_000_000_000).toISOString(),
    };

    // Ensure the bus stores the payload verbatim so validation stages can rely on the structured data.
    const envelope = bus.publish({
      cat: "graph",
      msg: payload.msg,
      data: payload,
      component: "validation",
      stage: payload.stage,
    });

    expect(envelope.msg).to.equal("introspection_probe");
    expect(envelope.data).to.deep.equal(payload);
  });

  it("accepts orchestrator heartbeat payloads", () => {
    const bus = new EventBus({ now: () => 202 });
    const payload: HeartbeatEventPayload = {
      msg: "alive",
    };

    // Heartbeats only carry the discriminant; correlation identifiers live on the envelope itself.
    const envelope = bus.publish({
      cat: "scheduler",
      msg: payload.msg,
      data: payload,
      jobId: "job-heartbeat",
      runId: "run-heartbeat",
    });

    expect(envelope.msg).to.equal("alive");
    expect(envelope.data).to.deep.equal(payload);
  });

  it("accepts structured plan payloads", () => {
    const bus = new EventBus({ now: () => 303 });
    const fanoutPayload: PlanEventPayload = {
      run_id: "run-fanout",
      op_id: "op-fanout",
      job_id: "job-fanout",
      graph_id: "graph-fanout",
      node_id: "node-fanout",
      child_id: "child-parent",
      children: [
        { name: "child-alpha", runtime: "codex" },
        { name: "child-beta", runtime: "python" },
      ],
      rejected: ["child-risk"],
    };
    const compiledPayload: PlanEventPayload = {
      event: "plan_compiled",
      plan_id: "plan-compiled",
      plan_version: "1.0.0",
      run_id: "run-compiled",
      op_id: "op-compiled",
      total_tasks: 6,
      phases: 3,
      critical_path_length: 2,
      estimated_duration_ms: 1_200,
    };

    const fanoutEnvelope = bus.publish({ cat: "graph", msg: "plan", data: fanoutPayload });
    const compiledEnvelope = bus.publish({ cat: "graph", msg: "plan", data: compiledPayload });

    expect(fanoutEnvelope.data).to.deep.equal(fanoutPayload);
    expect(compiledEnvelope.data).to.deep.equal(compiledPayload);
  });

  it("accepts prompt lessons payloads", () => {
    const bus = new EventBus({ now: () => 404 });
    const lessonsPayload = buildLessonsPromptPayload({
      source: "plan_fanout",
      before: [{ role: "system", content: "original" }],
      after: [{ role: "system", content: "with lessons" }],
      topics: ["memory"],
      tags: ["tagged"],
      totalLessons: 1,
    });
    const promptPayload: PromptEventPayload = {
      operation: "plan_fanout",
      lessons_prompt: lessonsPayload,
    };

    const envelope = bus.publish({ cat: "child", msg: "prompt", data: promptPayload });

    expect(envelope.msg).to.equal("prompt");
    expect(envelope.data).to.deep.equal(promptPayload);
  });

  it("accepts aggregate and status payloads", () => {
    const bus = new EventBus({ now: () => 505 });
    const aggregateReducer: PlanAggregateEventPayload = {
      run_id: "run-aggregate",
      op_id: "op-aggregate",
      job_id: "job-aggregate",
      graph_id: "graph-aggregate",
      node_id: null,
      child_id: null,
      reducer: "concat",
      children: ["child-a", "child-b"],
    };
    const aggregateTool: PlanAggregateEventPayload = {
      strategy: "concat",
      requested: "json_merge",
    };
    const joinStatus: PlanStatusEventPayload = {
      run_id: "run-status",
      op_id: "op-status",
      job_id: "job-status",
      graph_id: "graph-status",
      node_id: null,
      child_id: null,
      policy: "all",
      satisfied: true,
      successes: 2,
      failures: 0,
      consensus: {
        mode: "quorum",
        outcome: "success",
        satisfied: true,
        tie: false,
        threshold: 2,
        total_weight: 3,
        tally: { success: 3 },
      },
    };
    const jobStatus: PlanStatusEventPayload = {
      job_id: "job-observed",
      state: "running",
      children: [
        {
          id: "child-observed",
          name: "observer",
          state: "ready",
          runtime: "codex",
          waiting_for: null,
          last_update: 42,
          pending_id: null,
          transcript_size: 3,
        },
      ],
    };

    const aggregateReducerEnvelope = bus.publish({ cat: "graph", msg: "aggregate", data: aggregateReducer });
    const aggregateToolEnvelope = bus.publish({ cat: "graph", msg: "aggregate", data: aggregateTool });
    const joinStatusEnvelope = bus.publish({ cat: "graph", msg: "status", data: joinStatus });
    const jobStatusEnvelope = bus.publish({ cat: "graph", msg: "status", data: jobStatus });

    expect(aggregateReducerEnvelope.data).to.deep.equal(aggregateReducer);
    expect(aggregateToolEnvelope.data).to.deep.equal(aggregateTool);
    expect(joinStatusEnvelope.data).to.deep.equal(joinStatus);
    expect(jobStatusEnvelope.data).to.deep.equal(jobStatus);
  });

  it("accepts lifecycle breadcrumbs and scheduler telemetry payloads", () => {
    const bus = new EventBus({ now: () => 606 });
    const lifecyclePayload: PlanLifecycleEventPayload = {
      phase: "start",
      tree_id: "tree-lifecycle",
      dry_run: false,
      mode: "bt",
      run_id: "run-lifecycle",
      op_id: "op-lifecycle",
      job_id: "job-lifecycle",
      graph_id: "graph-lifecycle",
      node_id: "node-lifecycle",
      child_id: "child-lifecycle",
      tick_ms: 50,
      budget_ms: 200,
    };
    const schedulerPayload: SchedulerTelemetryPayload = {
      msg: "scheduler_event_enqueued",
      event_type: "taskReady",
      pending: 2,
      pending_before: 1,
      pending_after: 2,
      base_priority: 5,
      enqueued_at_ms: 10,
      sequence: 1,
      event_payload: { nodeId: "node-lifecycle" },
      duration_ms: null,
      batch_index: null,
      ticks_in_batch: null,
      run_id: "run-scheduler",
      op_id: "op-scheduler",
      job_id: "job-scheduler",
      graph_id: null,
      node_id: "node-lifecycle",
      child_id: "child-lifecycle",
    };

    const lifecycleEnvelope = bus.publish({ cat: "bt", msg: "bt_run", data: lifecyclePayload });
    const schedulerEnvelope = bus.publish({ cat: "scheduler", msg: "scheduler", data: schedulerPayload });

    expect(lifecycleEnvelope.data).to.deep.equal(lifecyclePayload);
    expect(schedulerEnvelope.data).to.deep.equal(schedulerPayload);
  });

  it("accepts autoscaler telemetry payloads", () => {
    const bus = new EventBus({ now: () => 707 });
    const payload: AutoscalerTelemetryPayload = {
      msg: "scale_up",
      reason: "pressure",
      backlog: 3,
      samples: 5,
      child_id: "child-autoscaler",
    };

    const envelope = bus.publish({ cat: "scheduler", msg: "autoscaler", data: payload });

    expect(envelope.msg).to.equal("autoscaler");
    expect(envelope.data).to.deep.equal(payload);
  });

  it("accepts structured child supervisor payloads", () => {
    const bus = new EventBus({ now: () => 123 });
    const limitsPayload: ChildSupervisorLimitsUpdatedPayload = {
      childId: "child-supervisor-payload",
      limits: { wallclock_ms: 900, cpu_ms: 250 },
    };

    const restartEvent: Extract<SupervisorEvent, { type: "child_restart" }> = {
      type: "child_restart",
      key: "node::restart",
      attempt: 2,
      breakerState: "closed",
      at: 456,
      delayMs: 1200,
      backoffWaitMs: 700,
      quotaWaitMs: 500,
    };
    const restartPayload: ChildSupervisorEventPayload & { event: typeof restartEvent } = {
      event: restartEvent,
      relatedChildren: ["child-supervisor-payload"],
      maxRestartsPerMinute: 10,
    };

    const breakerEvent: Extract<SupervisorEvent, { type: "breaker_open" }> = {
      type: "breaker_open",
      key: "node::restart",
      retryAt: 789,
    };
    const breakerPayload: ChildSupervisorEventPayload & { event: typeof breakerEvent } = {
      event: breakerEvent,
      relatedChildren: ["child-supervisor-payload"],
      maxRestartsPerMinute: 10,
    };

    // Publish the declarative limit update to ensure the bus stores the payload verbatim.
    const limitsEnvelope = bus.publish({
      cat: "child",
      msg: "child.limits.updated",
      data: limitsPayload,
      component: "child_supervisor",
      stage: "limits",
    });
    expect(limitsEnvelope.data).to.deep.equal(limitsPayload);

    // Publish restart and breaker events to verify the structured supervision payload contracts.
    const restartEnvelope = bus.publish({
      cat: "child",
      msg: "child.restart.scheduled",
      data: restartPayload,
      component: "child_supervisor",
      stage: "supervision",
    });
    expect(restartEnvelope.data).to.deep.equal(restartPayload);

    const breakerEnvelope = bus.publish({
      cat: "child",
      msg: "child.breaker.open",
      data: breakerPayload,
      component: "child_supervisor",
      stage: "supervision",
    });
    expect(breakerEnvelope.data).to.deep.equal(breakerPayload);
  });
});
