import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";
import {
  ContractNetCoordinator,
  computePheromonePressure,
  type ContractNetEvent,
} from "../src/coord/contractNet.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { StructuredLogger } from "../src/logger.js";
import {
  CnpAnnounceInputSchema,
  CnpRefreshBoundsInputSchema,
  CnpWatcherTelemetryInputSchema,
  handleCnpAnnounce,
  handleCnpRefreshBounds,
  handleCnpWatcherTelemetry,
  type CoordinationToolContext,
} from "../src/tools/coordTools.js";
import {
  ContractNetWatcherTelemetryRecorder,
  watchContractNetPheromoneBounds,
  type ContractNetWatcherTelemetrySnapshot,
} from "../src/coord/contractNetWatchers.js";

class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

describe("coordination contract-net pheromone bounds", () => {
  it("captures evolving pheromone bounds for announcements", () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });
    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy,
      contractNet,
      logger: new StructuredLogger(),
    };

    contractNet.registerAgent("agent-alpha", { baseCost: 4, reliability: 0.9 });
    contractNet.registerAgent("agent-beta", { baseCost: 6, reliability: 0.95 });

    // Seed the stigmergic field so the initial bounds reflect an observed ceiling.
    stigmergy.mark("triage", "load", 2);
    clock.advance(5);

    const first = handleCnpAnnounce(
      context,
      CnpAnnounceInputSchema.parse({ task_id: "survey-1", auto_bid: true }),
    );

    expect(first.pheromone_bounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 2,
    });
    const storedFirst = contractNet.getCall(first.call_id);
    expect(storedFirst?.pheromoneBounds).to.deep.equal(first.pheromone_bounds);

    // Increase the highest observed intensity so the normalisation ceiling changes.
    stigmergy.mark("analysis", "load", 6);
    clock.advance(5);

    const second = handleCnpAnnounce(
      context,
      CnpAnnounceInputSchema.parse({ task_id: "survey-2", auto_bid: true }),
    );

    expect(second.pheromone_bounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 6,
    });
    expect(second.pheromone_bounds).to.not.deep.equal(first.pheromone_bounds);

    const storedSecond = contractNet.getCall(second.call_id);
    expect(storedSecond?.pheromoneBounds).to.deep.equal(second.pheromone_bounds);
  });

  it("honours configured maxima when resolving pheromone bounds", () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now(), maxIntensity: 5 });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });
    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy,
      contractNet,
      logger: new StructuredLogger(),
    };

    contractNet.registerAgent("agent", { baseCost: 5, reliability: 1 });
    stigmergy.mark("review", "latency", 12);

    const announcement = handleCnpAnnounce(
      context,
      CnpAnnounceInputSchema.parse({ task_id: "bounded", auto_bid: true }),
    );

    expect(announcement.pheromone_bounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: 5,
      normalisation_ceiling: 5,
    });
  });

  it("scales busy penalties with pheromone pressure to favour idle agents under heavy load", () => {
    const clock = new ManualClock();
    const coordinator = new ContractNetCoordinator({ now: () => clock.now() });

    coordinator.registerAgent("alpha", { baseCost: 10, reliability: 1 });
    coordinator.registerAgent("beta", { baseCost: 10, reliability: 0.95 });

    // Pretend the beta agent is already working on another assignment so the
    // busy penalty applies during the auction. Casting keeps the tests aligned
    // with the coordinator internals while documenting the expected shape.
    const internals = coordinator as unknown as { activeAssignments: Map<string, number> };
    internals.activeAssignments.set("beta", 1);

    const heuristics = {
      preferAgents: ["beta"],
      agentBias: {},
      busyPenalty: 4,
      preferenceBonus: 3,
    };

    const lowLoad = coordinator.announce({
      taskId: "low-load",
      autoBid: false,
      heuristics,
      pheromoneBounds: { min_intensity: 0, max_intensity: 10, normalisation_ceiling: 1 },
    });

    coordinator.bid(lowLoad.callId, "alpha", 11.5);
    coordinator.bid(lowLoad.callId, "beta", 10);

    const lowDecision = coordinator.award(lowLoad.callId);
    expect(lowDecision.agentId).to.equal("beta");

    const lowSnapshot = coordinator.getCall(lowLoad.callId);
    expect(lowSnapshot?.pheromoneBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: 10,
      normalisation_ceiling: 1,
    });
    const lowPressure = computePheromonePressure(lowSnapshot?.pheromoneBounds ?? null);
    expect(lowPressure).to.be.closeTo(1.1, 1e-6);
    const lowBusyAfterAward = internals.activeAssignments.get("beta") ?? 0;
    expect(lowBusyAfterAward).to.be.greaterThan(0);
    expect(lowDecision.effectiveCost).to.be.closeTo(10 + 4 * lowBusyAfterAward * lowPressure - 3, 1e-6);

    // Reset the busy counter for beta so the next auction starts with a single
    // ongoing assignment once again.
    internals.activeAssignments.set("beta", 1);

    const highLoad = coordinator.announce({
      taskId: "high-load",
      autoBid: false,
      heuristics,
      pheromoneBounds: { min_intensity: 0, max_intensity: 10, normalisation_ceiling: 9 },
    });

    coordinator.bid(highLoad.callId, "alpha", 11.5);
    coordinator.bid(highLoad.callId, "beta", 10);

    const betaBusyBeforeHigh = internals.activeAssignments.get("beta") ?? 0;
    const alphaBusyBeforeHigh = internals.activeAssignments.get("alpha") ?? 0;
    const highDecision = coordinator.award(highLoad.callId);
    expect(highDecision.agentId).to.equal("alpha");

    const highSnapshot = coordinator.getCall(highLoad.callId);
    const highPressure = computePheromonePressure(highSnapshot?.pheromoneBounds ?? null);
    expect(highPressure).to.be.closeTo(1.9, 1e-6);
    const betaEffective = 10 + 4 * betaBusyBeforeHigh * highPressure - 3;
    const alphaEffective = 11.5 + 4 * alphaBusyBeforeHigh * highPressure;
    expect(betaEffective).to.be.greaterThan(alphaEffective);
  });

  it("refreshes heuristic bids when pheromone bounds are updated under load", () => {
    const clock = new ManualClock();
    const coordinator = new ContractNetCoordinator({ now: () => clock.now() });

    coordinator.registerAgent("alpha", { baseCost: 8, reliability: 0.9 });
    coordinator.registerAgent("beta", { baseCost: 6, reliability: 1 });

    const announced = coordinator.announce({
      taskId: "refresh-load",
      heuristics: { busyPenalty: 3 },
      pheromoneBounds: { min_intensity: 0, max_intensity: 20, normalisation_ceiling: 2 },
    });
    expect(announced.autoBidEnabled).to.equal(true);

    const initialAlpha = announced.bids.find((bid) => bid.agentId === "alpha");
    expect(initialAlpha).to.not.equal(undefined);
    expect(initialAlpha?.kind).to.equal("heuristic");
    const initialAlphaMetadata = initialAlpha?.metadata as Record<string, unknown>;
    expect(initialAlphaMetadata).to.deep.include({ reason: "auto" });
    expect(initialAlphaMetadata).to.have.property("pheromone_pressure");
    expect(initialAlphaMetadata.pheromone_pressure).to.be.closeTo(1.1, 1e-6);

    coordinator.bid(announced.callId, "beta", 5, { metadata: { reason: "manual" } });
    const manualBeforeRefresh = coordinator.getCall(announced.callId);
    const manualBid = manualBeforeRefresh?.bids.find((bid) => bid.agentId === "beta");
    expect(manualBid?.kind).to.equal("manual");
    const manualMetadata = manualBid?.metadata as Record<string, unknown> | undefined;
    expect(manualMetadata).to.deep.equal({ reason: "manual" });

    clock.advance(10);

    coordinator.registerAgent("gamma", { baseCost: 7, reliability: 0.95 });

    const refreshed = coordinator.updateCallPheromoneBounds(announced.callId, {
      min_intensity: 0,
      max_intensity: 20,
      normalisation_ceiling: 9,
    });

    expect(refreshed.pheromoneBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: 20,
      normalisation_ceiling: 9,
    });
    expect(refreshed.autoBidRefreshed).to.equal(true);
    expect(refreshed.refreshedAgents).to.have.members(["alpha", "gamma"]);
    const refreshedAlpha = refreshed.bids.find((bid) => bid.agentId === "alpha");
    expect(refreshedAlpha?.kind).to.equal("heuristic");
    const refreshedAlphaMetadata = refreshedAlpha?.metadata as Record<string, unknown>;
    expect(refreshedAlphaMetadata).to.deep.include({ reason: "auto_refresh" });
    const expectedPressure = computePheromonePressure(refreshed.pheromoneBounds);
    expect(refreshedAlphaMetadata).to.have.property("pheromone_pressure", expectedPressure);
    expect(refreshedAlpha?.submittedAt).to.be.greaterThan(initialAlpha?.submittedAt ?? 0);

    const refreshedGamma = refreshed.bids.find((bid) => bid.agentId === "gamma");
    expect(refreshedGamma?.kind).to.equal("heuristic");
    const refreshedGammaMetadata = refreshedGamma?.metadata as Record<string, unknown>;
    expect(refreshedGammaMetadata).to.deep.include({ reason: "auto_refresh" });
    expect(refreshedGammaMetadata).to.have.property("pheromone_pressure", expectedPressure);

    const postManualBid = refreshed.bids.find((bid) => bid.agentId === "beta");
    expect(postManualBid?.kind).to.equal("manual");
    const postManualMetadata = postManualBid?.metadata as Record<string, unknown> | undefined;
    expect(postManualMetadata).to.deep.equal({ reason: "manual" });
    expect(postManualBid?.submittedAt).to.equal(manualBid?.submittedAt);
  });

  it("allows callers to update bounds without refreshing heuristic bids", () => {
    const clock = new ManualClock();
    const coordinator = new ContractNetCoordinator({ now: () => clock.now() });

    coordinator.registerAgent("alpha", { baseCost: 5, reliability: 1 });

    const call = coordinator.announce({
      taskId: "no-refresh",
      pheromoneBounds: { min_intensity: 0, max_intensity: null, normalisation_ceiling: 3 },
    });

    const initialBid = call.bids.find((bid) => bid.agentId === "alpha");
    const initialMetadata = initialBid?.metadata as Record<string, unknown> | undefined;
    expect(initialMetadata).to.deep.include({ reason: "auto" });
    const initialSubmittedAt = initialBid?.submittedAt ?? 0;

    clock.advance(5);
    coordinator.registerAgent("beta", { baseCost: 9, reliability: 0.9 });

    const snapshot = coordinator.updateCallPheromoneBounds(
      call.callId,
      { min_intensity: 0, max_intensity: null, normalisation_ceiling: 7 },
      { refreshAutoBids: false },
    );

    expect(snapshot.pheromoneBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });
    expect(snapshot.autoBidRefreshed).to.equal(false);
    expect(snapshot.refreshedAgents).to.deep.equal([]);
    const unchangedBid = snapshot.bids.find((bid) => bid.agentId === "alpha");
    expect(unchangedBid?.submittedAt).to.equal(initialSubmittedAt);
    const unchangedMetadata = unchangedBid?.metadata as Record<string, unknown> | undefined;
    expect(unchangedMetadata).to.deep.include({ reason: "auto" });

    const missingBeta = snapshot.bids.find((bid) => bid.agentId === "beta");
    expect(missingBeta).to.equal(undefined);
  });

  it("emits structured events when pheromone bounds are refreshed", () => {
    const clock = new ManualClock();
    const coordinator = new ContractNetCoordinator({ now: () => clock.now() });

    coordinator.registerAgent("alpha", { baseCost: 5, reliability: 1 });
    coordinator.registerAgent("beta", { baseCost: 6, reliability: 0.9 });

    const events: ContractNetEvent[] = [];
    const dispose = coordinator.observe((event) => {
      events.push(event);
    });

    const call = coordinator.announce({ taskId: "event" });
    clock.advance(1);
    coordinator.updateCallPheromoneBounds(
      call.callId,
      { min_intensity: 0, max_intensity: 10, normalisation_ceiling: 4 },
      { includeNewAgents: true },
    );

    const boundsEvents = events.filter((event) => event.kind === "call_bounds_updated");
    expect(boundsEvents).to.have.lengthOf(1);
    const [updated] = boundsEvents as Array<Extract<ContractNetEvent, { kind: "call_bounds_updated" }>>;
    expect(updated.refresh.requested).to.equal(true);
    expect(updated.refresh.includeNewAgents).to.equal(true);
    expect(updated.refresh.refreshedAgents).to.include("alpha");
    expect(updated.bounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: 10,
      normalisation_ceiling: 4,
    });

    dispose();
  });

  it("refreshes pheromone bounds via the coordination tool when none are provided", () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });
    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy,
      contractNet,
      logger: new StructuredLogger(),
    };

    contractNet.registerAgent("alpha", { baseCost: 4, reliability: 0.95 });
    const call = contractNet.announce({ taskId: "tool-refresh", autoBid: true });

    // Increase the field pressure so the tool picks up a different ceiling.
    stigmergy.mark("tool", "load", 7);
    clock.advance(2);

    const result = handleCnpRefreshBounds(
      context,
      CnpRefreshBoundsInputSchema.parse({ call_id: call.callId }),
    );

    expect(result.auto_bid_refreshed).to.equal(true);
    expect(result.refresh.requested).to.equal(true);
    expect(result.refreshed_agents).to.deep.equal(["alpha"]);
    expect(result.pheromone_bounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });

    const stored = contractNet.getCall(call.callId);
    expect(stored?.pheromoneBounds).to.deep.equal(result.pheromone_bounds);
  });

  it("automatically refreshes open calls when stigmergy bounds evolve", async () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });

    contractNet.registerAgent("alpha", { baseCost: 3, reliability: 1 });
    const call = contractNet.announce({ taskId: "auto", autoBid: true });

    const events: ContractNetEvent[] = [];
    const disposeEvents = contractNet.observe((event) => events.push(event));

    const disposeWatcher = watchContractNetPheromoneBounds({
      field: stigmergy,
      contractNet,
      logger: new StructuredLogger(),
    });

    // Initial synchronisation triggers an update even without prior pressure.
    const initialBoundsEvents = events.filter((event) => event.kind === "call_bounds_updated");
    expect(initialBoundsEvents).to.have.lengthOf(1);
    expect(initialBoundsEvents[0]?.refresh.refreshedAgents).to.include("alpha");

    // Raise the normalisation ceiling by marking a stronger pheromone trail.
    stigmergy.mark("auto", "load", 12);
    clock.advance(1);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const subsequentEvents = events.filter((event) => event.kind === "call_bounds_updated");
    expect(subsequentEvents).to.have.lengthOf.at.least(2);
    const latest = subsequentEvents[subsequentEvents.length - 1] as Extract<
      ContractNetEvent,
      { kind: "call_bounds_updated" }
    >;
    expect(latest.bounds?.normalisation_ceiling).to.equal(12);
    expect(latest.refresh.refreshedAgents).to.include("alpha");

    const snapshot = contractNet.getCall(call.callId);
    expect(snapshot?.pheromoneBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 12,
    });

    disposeWatcher();
    disposeEvents();
  });

  it("coalesces rapid stigmergy updates before refreshing open calls", async () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });

    contractNet.registerAgent("alpha", { baseCost: 4, reliability: 1 });
    const call = contractNet.announce({ taskId: "coalesce", autoBid: true });

    const events: Extract<ContractNetEvent, { kind: "call_bounds_updated" }>[] = [];
    const disposeEvents = contractNet.observe((event) => {
      if (event.kind === "call_bounds_updated") {
        events.push(event);
      }
    });

    const telemetry: ContractNetWatcherTelemetrySnapshot[] = [];
    const disposeWatcher = watchContractNetPheromoneBounds({
      field: stigmergy,
      contractNet,
      logger: new StructuredLogger(),
      coalesceWindowMs: 25,
      onTelemetry: (snapshot) => telemetry.push(snapshot),
    });

    expect(events).to.have.lengthOf(1);
    expect(telemetry).to.have.lengthOf(1);
    expect(telemetry[0]).to.include({
      reason: "initial",
      receivedUpdates: 0,
      coalescedUpdates: 0,
      skippedRefreshes: 0,
      appliedRefreshes: 1,
      flushes: 0,
    });
    expect(telemetry[0].lastBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 1,
    });

    stigmergy.mark("coalesce-a", "load", 3);
    stigmergy.mark("coalesce-b", "load", 5);
    stigmergy.mark("coalesce-c", "load", 7);
    clock.advance(1);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events).to.have.lengthOf(2);
    const latest = events[events.length - 1];
    expect(latest.bounds?.normalisation_ceiling).to.equal(7);
    expect(latest.refresh.refreshedAgents).to.include("alpha");

    expect(telemetry).to.have.lengthOf(2);
    expect(telemetry[1]).to.include({
      reason: "flush",
      receivedUpdates: 3,
      coalescedUpdates: 2,
      skippedRefreshes: 0,
      appliedRefreshes: 2,
      flushes: 1,
    });
    expect(telemetry[1].lastBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });

    const snapshot = contractNet.getCall(call.callId);
    expect(snapshot?.pheromoneBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });

    disposeWatcher();
    expect(telemetry).to.have.lengthOf(3);
    expect(telemetry[2]).to.include({
      reason: "detach",
      receivedUpdates: 3,
      coalescedUpdates: 2,
      skippedRefreshes: 0,
      appliedRefreshes: 2,
      flushes: 1,
    });
    expect(telemetry[2].lastBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });
    disposeEvents();
  });

  it("reports telemetry when pheromone updates reuse the existing bounds", () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });

    contractNet.registerAgent("alpha", { baseCost: 3, reliability: 1 });
    const call = contractNet.announce({ taskId: "stable", autoBid: true });

    const events: Extract<ContractNetEvent, { kind: "call_bounds_updated" }>[] = [];
    const disposeEvents = contractNet.observe((event) => {
      if (event.kind === "call_bounds_updated") {
        events.push(event);
      }
    });

    const telemetry: ContractNetWatcherTelemetrySnapshot[] = [];
    const disposeWatcher = watchContractNetPheromoneBounds({
      field: stigmergy,
      contractNet,
      logger: new StructuredLogger(),
      coalesceWindowMs: 0,
      onTelemetry: (snapshot) => telemetry.push(snapshot),
    });

    expect(events).to.have.lengthOf(1);
    expect(telemetry).to.have.lengthOf(1);

    stigmergy.mark("stable", "load", 7);

    expect(events).to.have.lengthOf(2);
    expect(telemetry).to.have.lengthOf(2);
    expect(telemetry[1]).to.include({
      reason: "flush",
      receivedUpdates: 1,
      coalescedUpdates: 0,
      skippedRefreshes: 0,
      appliedRefreshes: 2,
      flushes: 1,
    });
    expect(telemetry[1].lastBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });

    stigmergy.mark("stable-secondary", "load", 2);

    expect(events).to.have.lengthOf(2);
    expect(telemetry).to.have.lengthOf(3);
    expect(telemetry[2]).to.include({
      reason: "flush",
      receivedUpdates: 2,
      coalescedUpdates: 0,
      skippedRefreshes: 1,
      appliedRefreshes: 2,
      flushes: 1,
    });
    expect(telemetry[2].lastBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });

    disposeWatcher();
    expect(telemetry).to.have.lengthOf(4);
    expect(telemetry[3]).to.include({
      reason: "detach",
      receivedUpdates: 2,
      coalescedUpdates: 0,
      skippedRefreshes: 1,
      appliedRefreshes: 2,
      flushes: 1,
    });
    expect(telemetry[3].lastBounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 7,
    });
    disposeEvents();
  });
});

describe("contract-net watcher telemetry tool", () => {
  it("reports telemetry as disabled when the recorder is unavailable", () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });
    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy,
      contractNet,
      logger: new StructuredLogger(),
    };

    const result = handleCnpWatcherTelemetry(
      context,
      CnpWatcherTelemetryInputSchema.parse({}),
    );

    expect(result.telemetry_enabled).to.equal(false);
    expect(result.emissions).to.equal(0);
    expect(result.last_snapshot).to.equal(null);
  });

  it("surfaces the latest watcher snapshot with emission metadata", () => {
    const clock = new ManualClock();
    const stigmergy = new StigmergyField({ now: () => clock.now() });
    const contractNet = new ContractNetCoordinator({ now: () => clock.now() });
    const logger = new StructuredLogger();
    const recorder = new ContractNetWatcherTelemetryRecorder(() => clock.now());
    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy,
      contractNet,
      logger,
      contractNetWatcherTelemetry: recorder,
    };

    contractNet.registerAgent("alpha", { baseCost: 3, reliability: 1 });
    contractNet.announce({
      taskId: "inspect", 
      autoBid: true,
      heuristics: { busyPenalty: 1 },
      pheromoneBounds: { min_intensity: 0, max_intensity: null, normalisation_ceiling: 0 },
    });

    const disposeWatcher = watchContractNetPheromoneBounds({
      field: stigmergy,
      contractNet,
      logger,
      coalesceWindowMs: 0,
      onTelemetry: (snapshot) => recorder.record(snapshot),
    });

    clock.advance(5);
    stigmergy.mark("node-1", "load", 2);

    clock.advance(10);
    disposeWatcher();

    const result = handleCnpWatcherTelemetry(
      context,
      CnpWatcherTelemetryInputSchema.parse({}),
    );

    expect(result.telemetry_enabled).to.equal(true);
    expect(result.emissions).to.equal(3);
    expect(result.last_emitted_at_ms).to.equal(15);
    expect(result.last_emitted_at_iso).to.equal(new Date(15).toISOString());
    expect(result.last_snapshot).to.deep.include({
      reason: "detach",
      received_updates: 1,
      coalesced_updates: 0,
      skipped_refreshes: 0,
      applied_refreshes: 2,
      flushes: 1,
    });
    expect(result.last_snapshot?.last_bounds).to.deep.equal({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 2,
    });
  });
});

describe("contract-net pheromone pressure helper", () => {
  it("uses logarithmic growth when the stigmergic field is unbounded", () => {
    const pressure = computePheromonePressure({
      min_intensity: 0,
      max_intensity: null,
      normalisation_ceiling: 15,
    });
    expect(pressure).to.be.closeTo(1 + Math.log1p(15), 1e-6);
  });

  it("returns neutral pressure when bounds are missing or inactive", () => {
    expect(computePheromonePressure(null)).to.equal(1);
    expect(
      computePheromonePressure({
        min_intensity: 5,
        max_intensity: 10,
        normalisation_ceiling: 4,
      }),
    ).to.equal(1);
  });
});
