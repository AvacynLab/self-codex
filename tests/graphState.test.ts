import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphState } from "../src/graphState.js";
import { ChildRecordSnapshot } from "../src/state/childrenIndex.js";

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

  it("synchronise les métadonnées issues de l'index enfants", () => {
    const state = new GraphState();
    const baseTs = 3_000_000;
    state.createJob("job_sync", { createdAt: baseTs, state: "running" });
    state.createChild("job_sync", "child_sync", { name: "Sync" }, { createdAt: baseTs, ttlAt: null });

    const snapshot: ChildRecordSnapshot = {
      childId: "child_sync",
      pid: 4242,
      workdir: "/tmp/child_sync",
      state: "running",
      startedAt: baseTs + 10,
      lastHeartbeatAt: baseTs + 20,
      retries: 2,
      metadata: {},
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      forcedTermination: false,
      stopReason: null,
      role: "navigator",
      limits: { cpu_ms: 1_500, tokens: 5_000 },
      attachedAt: baseTs + 50,
    };

    state.syncChildIndexSnapshot(snapshot);

    const synced = state.getChild("child_sync");
    expect(synced?.pid).to.equal(4242);
    expect(synced?.workdir).to.equal("/tmp/child_sync");
    expect(synced?.retries).to.equal(2);
    expect(synced?.startedAt).to.equal(baseTs + 10);
    expect(synced?.lastHeartbeatAt).to.equal(baseTs + 20);
    expect(synced?.endedAt).to.be.null;
    expect(synced?.exitCode).to.be.null;
    expect(synced?.exitSignal).to.be.null;
    expect(synced?.forcedTermination).to.equal(false);
    expect(synced?.role).to.equal("navigator");
    expect(synced?.limits).to.deep.equal({ cpu_ms: 1_500, tokens: 5_000 });
    expect(synced?.attachedAt).to.equal(baseTs + 50);

    const terminatedSnapshot: ChildRecordSnapshot = {
      ...snapshot,
      state: "terminated",
      endedAt: baseTs + 120,
      exitCode: 0,
      exitSignal: "SIGTERM",
      forcedTermination: true,
      stopReason: "timeout",
    };

    state.syncChildIndexSnapshot(terminatedSnapshot);
    const terminated = state.getChild("child_sync");
    expect(terminated?.endedAt).to.equal(baseTs + 120);
    expect(terminated?.exitCode).to.equal(0);
    expect(terminated?.exitSignal).to.equal("SIGTERM");
    expect(terminated?.forcedTermination).to.equal(true);
    expect(terminated?.stopReason).to.equal("timeout");
    expect(terminated?.role).to.equal("navigator");
    expect(terminated?.limits).to.deep.equal({ cpu_ms: 1_500, tokens: 5_000 });
    expect(terminated?.attachedAt).to.equal(baseTs + 50);
  });

  it("ignore les instantanés inconnus sans lever d'erreur", () => {
    const state = new GraphState();
    const orphanSnapshot: ChildRecordSnapshot = {
      childId: "child_missing",
      pid: 1337,
      workdir: "/tmp/ghost",
      state: "starting",
      startedAt: Date.now(),
      lastHeartbeatAt: null,
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
    };

    expect(() => state.syncChildIndexSnapshot(orphanSnapshot)).to.not.throw();
  });
});
