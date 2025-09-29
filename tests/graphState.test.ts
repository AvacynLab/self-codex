import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphState } from "../src/graphState.js";

describe("GraphState", () => {
  it("identifie un enfant inactif au-delà du seuil fourni", () => {
    const state = new GraphState();
    const baseTs = 1_000_000;
    state.createJob("job_idle", { createdAt: baseTs, state: "running" });
    state.createChild("job_idle", "child_idle", { name: "Idle" }, { createdAt: baseTs, ttlAt: null });

    const reports = state.findInactiveChildren({ idleThresholdMs: 5_000, now: baseTs + 7_500 });
    expect(reports).to.have.length(1);
    const report = reports[0];
    expect(report.childId).to.equal("child_idle");
    const idleFlag = report.flags.find((flag) => flag.type === "idle");
    expect(idleFlag).to.not.be.undefined;
    expect(idleFlag?.thresholdMs).to.equal(5_000);
    expect(report.idleMs).to.equal(7_500);
  });

  it("signale un pending prolongé", () => {
    const state = new GraphState();
    const baseTs = 2_000_000;
    state.createJob("job_pending", { createdAt: baseTs, state: "running" });
    state.createChild("job_pending", "child_pending", { name: "Pending" }, { createdAt: baseTs, ttlAt: null });
    state.setPending("child_pending", "pending_1", baseTs + 1_000);

    const reports = state.findInactiveChildren({
      idleThresholdMs: 10_000,
      pendingThresholdMs: 3_000,
      now: baseTs + 6_500
    });
    const report = reports.find((entry) => entry.childId === "child_pending");
    expect(report).to.not.be.undefined;
    expect(report?.pendingMs).to.equal(5_500);
    const pendingFlag = report?.flags.find((flag) => flag.type === "pending");
    expect(pendingFlag?.thresholdMs).to.equal(3_000);
  });

  it("retourne des métriques synthétiques", () => {
    const state = new GraphState();
    const nowTs = Date.now();
    state.createJob("job_metrics", { createdAt: nowTs, state: "running" });
    state.createChild("job_metrics", "child_metrics", { name: "Metrics" }, { createdAt: nowTs, ttlAt: null });
    state.appendMessage("child_metrics", {
      role: "assistant",
      content: "Hello",
      ts: nowTs,
      actor: "orchestrator"
    });

    const metrics = state.collectMetrics();
    expect(metrics.totalJobs).to.equal(1);
    expect(metrics.activeJobs).to.equal(1);
    expect(metrics.totalChildren).to.equal(1);
    expect(metrics.totalMessages).to.equal(1);
    expect(metrics.subscriptions).to.equal(0);
  });
});
