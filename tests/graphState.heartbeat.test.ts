import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphState, type EventSnapshot } from "../src/graph/state.js";

/**
 * Unit tests covering the heartbeat integration inside the graph state. The
 * orchestrator relies on these timestamps when autosaving snapshots and when
 * looking for inactive children.
 */
describe("graph state heartbeats", () => {
  it("stores heartbeat timestamps on child snapshots and in the serialized graph", () => {
    const state = new GraphState();
    const createdAt = Date.now() - 1_000;

    state.createJob("job-alpha", { createdAt, goal: "demo", state: "running" });
    state.createChild(
      "job-alpha",
      "child-alpha",
      { name: "alpha", runtime: "codex" },
      { createdAt }
    );

    const heartbeatTs = createdAt + 500;
    state.recordChildHeartbeat("child-alpha", heartbeatTs);

    const child = state.getChild("child-alpha");
    expect(child?.lastHeartbeatAt).to.equal(heartbeatTs);

    const snapshot = state.serialize();
    const node = snapshot.nodes.find((candidate) => candidate.id === "child:child-alpha");
    expect(node?.attributes.last_heartbeat_at).to.equal(heartbeatTs);
  });

  it("prefers the heartbeat timestamp over transcript activity when evaluating inactivity", () => {
    const state = new GraphState();
    const createdAt = Date.now() - 60_000;
    state.createJob("job-beta", { createdAt, state: "running" });
    state.createChild(
      "job-beta",
      "child-beta",
      { name: "beta", runtime: "codex" },
      { createdAt }
    );

    const idleThresholdMs = 30_000;
    const evaluationTs = createdAt + idleThresholdMs + 1_000;

    const initialReports = state.findInactiveChildren({
      idleThresholdMs,
      now: evaluationTs,
      includeChildrenWithoutMessages: true,
    });
    const idleReport = initialReports.find((report) => report.childId === "child-beta");
    expect(idleReport).to.not.equal(undefined);
    expect(idleReport?.suggestedActions).to.deep.equal(["ping"]);

    state.recordChildHeartbeat("child-beta", evaluationTs - 5_000);
    const afterHeartbeatReports = state.findInactiveChildren({
      idleThresholdMs,
      now: evaluationTs,
      includeChildrenWithoutMessages: true,
    });
    expect(afterHeartbeatReports.some((report) => report.childId === "child-beta")).to.equal(false);
  });

  it("updates the heartbeat when recording MCP events", () => {
    const state = new GraphState();
    const createdAt = Date.now();
    state.createJob("job-gamma", { createdAt, goal: "events", state: "running" });
    state.createChild(
      "job-gamma",
      "child-gamma",
      { name: "gamma", runtime: "codex" },
      { createdAt }
    );

    const eventTs = createdAt + 1_234;
    const event: EventSnapshot = {
      seq: 1,
      ts: eventTs,
      kind: "HEARTBEAT",
      level: "info",
      jobId: "job-gamma",
      childId: "child-gamma",
    };

    state.recordEvent(event);
    const child = state.getChild("child-gamma");
    expect(child?.lastHeartbeatAt).to.equal(eventTs);
  });

  it("recommends cancel or retry actions based on pending state", () => {
    const state = new GraphState();
    const createdAt = Date.now() - 60_000;
    state.createJob("job-delta", { createdAt, goal: "pending", state: "running" });
    state.createChild(
      "job-delta",
      "child-delta",
      { name: "delta", runtime: "codex" },
      { createdAt }
    );

    const pendingCreatedAt = createdAt + 1_000;
    state.setPending("child-delta", "pending-delta", pendingCreatedAt);
    state.patchChild("child-delta", { state: "running" });

    const cancelReports = state.findInactiveChildren({
      idleThresholdMs: 1_000,
      pendingThresholdMs: 5_000,
      now: pendingCreatedAt + 10_000,
      includeChildrenWithoutMessages: true,
    });
    const cancelReport = cancelReports.find((report) => report.childId === "child-delta");
    expect(cancelReport?.suggestedActions).to.have.members(["ping", "cancel"]);
    expect(cancelReport?.suggestedActions).to.have.length(2);

    state.patchChild("child-delta", { state: "error:timeout" });
    const retryReports = state.findInactiveChildren({
      idleThresholdMs: 1_000,
      pendingThresholdMs: 5_000,
      now: pendingCreatedAt + 20_000,
      includeChildrenWithoutMessages: true,
    });
    const retryReport = retryReports.find((report) => report.childId === "child-delta");
    expect(retryReport?.suggestedActions).to.include("retry");
    expect(retryReport?.suggestedActions).to.not.include("cancel");
  });
});
