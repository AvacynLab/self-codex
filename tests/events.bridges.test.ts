import { EventEmitter } from "node:events";

import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";
import {
  bridgeBlackboardEvents,
  bridgeChildRuntimeEvents,
  bridgeCancellationEvents,
  bridgeConsensusEvents,
  bridgeContractNetEvents,
  bridgeValueEvents,
  bridgeStigmergyEvents,
} from "../src/events/bridges.js";
import { BlackboardStore } from "../src/coord/blackboard.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import {
  registerCancellation,
  requestCancellation,
  resetCancellationRegistry,
} from "../src/executor/cancel.js";
import {
  publishConsensusEvent,
  resetConsensusEventClock,
  setConsensusEventClock,
} from "../src/coord/consensus.js";
import type {
  ChildRuntime,
  ChildRuntimeLifecycleEvent,
  ChildRuntimeMessage,
} from "../src/childRuntime.js";
import { ValueGraph } from "../src/values/valueGraph.js";

describe("event bridges", () => {
  beforeEach(() => {
    resetCancellationRegistry();
    resetConsensusEventClock();
  });

  it("mirrors blackboard mutations on the unified event bus", () => {
    // Manual monotonic clock keeps timestamps predictable for assertions.
    let now = 0;
    const nowFn = () => now;
    const bus = new EventBus({ historyLimit: 10, now: nowFn });
    const store = new BlackboardStore({ historyLimit: 10, now: nowFn });

    bridgeBlackboardEvents({
      blackboard: store,
      bus,
      resolveCorrelation: (event) => {
        if (event.key === "task") {
          return { runId: "run-77", opId: `op-${event.version}` };
        }
        return {};
      },
    });

    now = 1;
    store.set("task", { state: "queued" }, { tags: ["plan"], ttlMs: 4 });
    now = 2;
    store.set("log", { state: "transient" }, { ttlMs: 3 });
    now = 3;
    const deleted = store.delete("task");
    expect(deleted).to.equal(true);
    now = 6;
    const expired = store.evictExpired();
    expect(expired).to.have.lengthOf(1);

    const events = bus.list({ cats: ["blackboard"] });
    expect(events.map((event) => event.msg)).to.deep.equal([
      "bb_set",
      "bb_set",
      "bb_delete",
      "bb_expire",
    ]);
    const [taskSet, logSet, taskDelete, logExpire] = events;
    expect(taskSet.runId).to.equal("run-77");
    expect(taskSet.opId).to.equal("op-1");
    expect(taskSet.data).to.deep.include({ key: "task", kind: "set" });
    expect(logSet.runId).to.equal(null);
    expect(taskDelete.msg).to.equal("bb_delete");
    expect(taskDelete.runId).to.equal("run-77");
    expect(taskDelete.opId).to.equal("op-3");
    expect(logExpire.level).to.equal("warn");
    expect(logExpire.data).to.deep.include({ kind: "expire", key: "log", reason: "ttl" });
  });

  it("publishes stigmergy changes with node metadata", () => {
    // Deterministic clock shared between the field and event bus.
    let now = 0;
    const nowFn = () => now;
    const bus = new EventBus({ historyLimit: 10, now: nowFn });
    const field = new StigmergyField({ now: nowFn });

    bridgeStigmergyEvents({
      field,
      bus,
      resolveCorrelation: () => ({ graphId: "graph-42" }),
    });

    now = 1;
    field.mark("node-1", "routing", 1.5);
    now = 5;
    const changes = field.evaporate(2);
    expect(changes).to.have.length.greaterThan(0);

    const events = bus.list({ cats: ["stigmergy"] });
    expect(events).to.have.lengthOf(2);
    const [markEvent, evaporateEvent] = events;
    expect(markEvent.nodeId).to.equal("node-1");
    expect(markEvent.graphId).to.equal("graph-42");
    expect(markEvent.data).to.deep.include({ type: "routing", intensity: 1.5 });
    expect(evaporateEvent.msg).to.equal("stigmergy_change");
    expect(evaporateEvent.data).to.deep.include({ nodeId: "node-1" });
    expect(evaporateEvent.data.totalIntensity).to.be.lessThan(1.5);
  });

  it("routes cancellation lifecycle events with correlation metadata", () => {
    let tick = 0;
    const now = () => ++tick;
    const bus = new EventBus({ historyLimit: 5, now });

    const dispose = bridgeCancellationEvents({ bus });

    const handle = registerCancellation("op-cancel", {
      runId: "run-99",
      jobId: "job-77",
      graphId: "graph-5",
      nodeId: "node-2",
      childId: "child-9",
      createdAt: 0,
    });
    const firstOutcome = requestCancellation(handle.opId, { reason: "timeout", at: 50 });
    const secondOutcome = requestCancellation(handle.opId, { at: 60 });

    expect(firstOutcome).to.equal("requested");
    expect(secondOutcome).to.equal("already_cancelled");

    const events = bus.list({ cats: ["cancel"] });
    expect(events).to.have.lengthOf(2);

    const [requested, repeated] = events;
    expect(requested.msg).to.equal("cancel_requested");
    expect(requested.level).to.equal("info");
    expect(requested.runId).to.equal("run-99");
    expect(requested.opId).to.equal("op-cancel");
    expect(requested.jobId).to.equal("job-77");
    expect(requested.graphId).to.equal("graph-5");
    expect(requested.nodeId).to.equal("node-2");
    expect(requested.childId).to.equal("child-9");
    expect(requested.data).to.deep.include({
      outcome: "requested",
      reason: "timeout",
      jobId: "job-77",
      graphId: "graph-5",
      nodeId: "node-2",
      childId: "child-9",
    });

    expect(repeated.msg).to.equal("cancel_repeat");
    expect(repeated.level).to.equal("warn");
    expect(repeated.runId).to.equal("run-99");
    expect(repeated.jobId).to.equal("job-77");
    expect(repeated.graphId).to.equal("graph-5");
    expect(repeated.data).to.deep.include({ outcome: "already_cancelled", jobId: "job-77" });

    dispose();
  });

  it("bridges contract-net auctions and bids to the event bus", () => {
    let tick = 0;
    const now = () => ++tick;
    const bus = new EventBus({ historyLimit: 20, now });
    const coordinator = new ContractNetCoordinator({ now });

    const dispose = bridgeContractNetEvents({
      coordinator,
      bus,
      resolveCorrelation: (event) => {
        if (event.kind === "call_announced") {
          return { runId: "run-auction", opId: `op-${event.call.callId}` };
        }
        if (event.kind === "bid_recorded") {
          return { opId: `op-${event.callId}` };
        }
        if (event.kind === "call_awarded" || event.kind === "call_completed") {
          return { runId: "run-auction", opId: `op-${event.call.callId}` };
        }
        return {};
      },
    });

    const agent = coordinator.registerAgent("agent-77", { baseCost: 25, reliability: 0.8 });
    const call = coordinator.announce({ taskId: "task-42" });
    coordinator.bid(call.callId, agent.agentId, 10, { metadata: { note: "manual" } });
    const decision = coordinator.award(call.callId);
    expect(decision.agentId).to.equal(agent.agentId);
    const completion = coordinator.complete(call.callId);
    expect(completion.status).to.equal("completed");
    const removed = coordinator.unregisterAgent(agent.agentId);
    expect(removed).to.equal(true);

    const events = bus.list({ cats: ["contract_net"] });
    expect(events.map((event) => event.msg)).to.deep.equal([
      "cnp_agent_registered",
      "cnp_bid_recorded",
      "cnp_call_announced",
      "cnp_bid_updated",
      "cnp_call_awarded",
      "cnp_call_completed",
      "cnp_agent_unregistered",
    ]);

    const [registered, autoBid, announced, manualBid, awarded, completed, unregistered] = events;

    expect(registered.runId).to.equal(null);
    expect(registered.data).to.deep.include({ updated: false });

    expect(autoBid.opId).to.equal(`op-${call.callId}`);
    expect(autoBid.data).to.deep.include({ callId: call.callId, previousKind: null });
    expect(autoBid.data).to.have.nested.property("bid.kind", "heuristic");

    expect(announced.runId).to.equal("run-auction");
    expect(announced.opId).to.equal(`op-${call.callId}`);
    expect(announced.data).to.have.nested.property("call.status", "open");
    expect(announced.data).to.have.nested.property("call.bids").that.is.an("array");

    expect(manualBid.msg).to.equal("cnp_bid_updated");
    expect(manualBid.data).to.deep.include({ previousKind: "heuristic" });
    expect(manualBid.data).to.have.nested.property("bid.kind", "manual");

    expect(awarded.runId).to.equal("run-auction");
    expect(awarded.data).to.have.nested.property("decision.agentId", agent.agentId);
    expect(awarded.data).to.have.nested.property("call.status", "awarded");

    expect(completed.runId).to.equal("run-auction");
    expect(completed.data).to.have.nested.property("call.status", "completed");

    expect(unregistered.data).to.deep.include({ agentId: agent.agentId });
    expect(unregistered.data).to.have.property("remainingAssignments", 0);

    dispose();

    coordinator.announce({ taskId: "task-ignored", autoBid: false });
    const afterDisposeEvents = bus.list({ cats: ["contract_net"] });
    expect(afterDisposeEvents).to.have.lengthOf(7);
  });

  it("bridges consensus decisions onto the unified bus", () => {
    let tick = 0;
    const now = () => ++tick;
    setConsensusEventClock(now);
    const bus = new EventBus({ historyLimit: 10, now });

    const dispose = bridgeConsensusEvents({ bus });

    publishConsensusEvent({
      kind: "decision",
      source: "plan_join",
      mode: "quorum",
      outcome: "success",
      satisfied: true,
      tie: false,
      threshold: 2,
      totalWeight: 3,
      tally: { success: 2, error: 1 },
      votes: 3,
      runId: "run-501",
      opId: "op-join-1",
      metadata: { policy: "quorum", winning_child_id: "child-9" },
    });

    publishConsensusEvent({
      kind: "decision",
      source: "consensus_vote",
      mode: "weighted",
      outcome: null,
      satisfied: false,
      tie: true,
      threshold: 4,
      totalWeight: 4,
      tally: { approve: 2, reject: 2 },
      votes: 4,
      jobId: "job-300",
      metadata: { requested_quorum: 4 },
    });

    const events = bus.list({ cats: ["consensus"] });
    expect(events).to.have.lengthOf(2);

    const [satisfied, tie] = events;
    expect(satisfied.msg).to.equal("consensus_decision");
    expect(satisfied.level).to.equal("info");
    expect(satisfied.runId).to.equal("run-501");
    expect(satisfied.opId).to.equal("op-join-1");
    expect(satisfied.data).to.deep.include({
      mode: "quorum",
      outcome: "success",
      satisfied: true,
      threshold: 2,
      votes: 3,
    });
    expect(satisfied.data).to.have.nested.property("metadata.policy", "quorum");
    expect(satisfied.data).to.have.nested.property("metadata.winning_child_id", "child-9");

    expect(tie.msg).to.equal("consensus_tie_unresolved");
    expect(tie.level).to.equal("warn");
    expect(tie.jobId).to.equal("job-300");
    expect(tie.data).to.deep.include({
      mode: "weighted",
      outcome: null,
      tie: true,
      votes: 4,
    });
    expect(tie.data).to.have.nested.property("metadata.requested_quorum", 4);

    dispose();
    resetConsensusEventClock();
  });

  it("bridges child runtime lifecycle and output streams to the event bus", () => {
    let tick = 0;
    const now = () => ++tick;
    const bus = new EventBus({ historyLimit: 10, now });

    class FakeChildRuntime extends EventEmitter {
      // Minimal stub mirroring the ChildRuntime shape for subscription tests.
      childId = "child-007";
    }

    const runtime = new FakeChildRuntime() as unknown as ChildRuntime;

    const dispose = bridgeChildRuntimeEvents({
      runtime,
      bus,
      resolveCorrelation: (context) => {
        if (context.kind === "lifecycle" && context.lifecycle.phase === "exit") {
          return { jobId: "job-child-007" };
        }
        return {};
      },
    });

    const spawned: ChildRuntimeLifecycleEvent = {
      phase: "spawned",
      at: 1,
      pid: 321,
      forced: false,
      reason: null,
    };
    runtime.emit("lifecycle", spawned);

    const stdoutMessage: ChildRuntimeMessage = {
      raw: JSON.stringify({ type: "response", runId: "run-501", opId: "op-22" }),
      parsed: { type: "response", runId: "run-501", opId: "op-22" },
      stream: "stdout",
      receivedAt: 2,
      sequence: 0,
    };
    runtime.emit("message", stdoutMessage);

    const stderrMessage: ChildRuntimeMessage = {
      raw: "fatal: disk full",
      parsed: null,
      stream: "stderr",
      receivedAt: 3,
      sequence: 1,
    };
    runtime.emit("message", stderrMessage);

    const errored: ChildRuntimeLifecycleEvent = {
      phase: "error",
      at: 4,
      pid: 321,
      forced: false,
      reason: "runtime-crashed",
    };
    runtime.emit("lifecycle", errored);

    const exited: ChildRuntimeLifecycleEvent = {
      phase: "exit",
      at: 5,
      pid: 321,
      forced: true,
      code: 1,
      signal: "SIGTERM",
      reason: null,
    };
    runtime.emit("lifecycle", exited);

    const events = bus.list({ cats: ["child"] });
    expect(events).to.have.lengthOf(5);
    expect(events.map((event) => event.msg)).to.deep.equal([
      "child_spawned",
      "child_stdout",
      "child_stderr",
      "child_error",
      "child_exit",
    ]);

    const [, stdoutEvent, stderrEvent, errorEvent, exitEvent] = events;
    expect(stdoutEvent.runId).to.equal("run-501");
    expect(stdoutEvent.opId).to.equal("op-22");
    expect(stdoutEvent.level).to.equal("info");
    expect(stdoutEvent.data).to.deep.include({ raw: stdoutMessage.raw, sequence: 0 });

    expect(stderrEvent.level).to.equal("warn");
    expect(stderrEvent.data).to.deep.include({ raw: stderrMessage.raw, stream: "stderr" });

    expect(errorEvent.level).to.equal("error");
    expect(errorEvent.data).to.deep.include({ reason: "runtime-crashed" });

    expect(exitEvent.level).to.equal("warn");
    expect(exitEvent.jobId).to.equal("job-child-007");
    expect(exitEvent.data).to.deep.include({ code: 1, signal: "SIGTERM", forced: true });

    dispose();

    runtime.emit("message", {
      raw: "ignored",
      parsed: null,
      stream: "stdout",
      receivedAt: 6,
      sequence: 2,
    } satisfies ChildRuntimeMessage);

    const postDisposeEvents = bus.list({ cats: ["child"] });
    expect(postDisposeEvents).to.have.lengthOf(5);
  });

  it("bridges value guard evaluations to the event bus", () => {
    let tick = 0;
    const now = () => ++tick;
    const bus = new EventBus({ historyLimit: 10, now });
    const graph = new ValueGraph({ now });

    const dispose = bridgeValueEvents({
      graph,
      bus,
    });

    const summary = graph.set({
      values: [{ id: "safety", weight: 1, tolerance: 0.25 }],
    });
    expect(summary.version).to.equal(1);

    const impacts = [
      { value: "safety", impact: "risk" as const, severity: 0.8, rationale: "missing tests", nodeId: "node-1" },
    ];

    const correlation = { runId: "run-guard", opId: "op-plan-risk" } as const;

    const score = graph.score({ id: "plan-risk", label: "Risky plan", impacts }, { correlation });
    expect(score.violations).to.have.length.greaterThan(0);

    const decision = graph.filter({ id: "plan-risk", label: "Risky plan", impacts }, { correlation });
    expect(decision.allowed).to.equal(false);

    const explanation = graph.explain({ id: "plan-risk", label: "Risky plan", impacts }, { correlation });
    expect(explanation.decision.allowed).to.equal(false);

    const events = bus.list({ cats: ["values"] });
    expect(events.map((event) => event.msg)).to.deep.equal([
      "values_config_updated",
      "values_scored",
      "values_filter_blocked",
      "values_explain_blocked",
    ]);

    const [configUpdated, scored, filtered, explained] = events;

    expect(configUpdated.level).to.equal("info");
    expect(configUpdated.data).to.have.nested.property("summary.version", 1);

    expect(scored.level).to.equal("warn");
    expect(scored.runId).to.equal("run-guard");
    expect(scored.opId).to.equal("op-plan-risk");
    expect(scored.data).to.include({
      plan_id: "plan-risk",
      plan_label: "Risky plan",
      impacts_count: impacts.length,
      violations_count: 1,
    });
    expect(scored.data)
      .to.have.nested.property("result.violations")
      .that.is.an("array")
      .with.length.greaterThan(0);

    expect(filtered.msg).to.equal("values_filter_blocked");
    expect(filtered.level).to.equal("warn");
    expect(filtered.data).to.have.nested.property("decision.allowed", false);

    expect(explained.msg).to.equal("values_explain_blocked");
    expect(explained.data)
      .to.have.nested.property("result.decision.allowed", false);
    expect(explained.data)
      .to.have.nested.property("result.violations")
      .that.is.an("array")
      .with.length.greaterThan(0);

    dispose();

    graph.score({ id: "plan-risk", label: "Risky plan", impacts });
    const afterDispose = bus.list({ cats: ["values"] });
    expect(afterDispose).to.have.lengthOf(4);
  });
});
