import { describe, it } from "mocha";
import { expect } from "chai";

import {
  OrchestratorSupervisor,
  type SupervisorChildManager,
  type SupervisorIncident,
} from "../src/agents/supervisor.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";
import type { LoopAlert } from "../src/guard/loopDetector.js";

class StubChildManager implements SupervisorChildManager {
  public readonly children: ChildRecordSnapshot[] = [];
  public readonly cancelled: string[] = [];
  public readonly killed: string[] = [];

  public readonly childrenIndex = {
    list: (): ChildRecordSnapshot[] => this.children.map((child) => ({ ...child })),
  };

  async cancel(childId: string): Promise<void> {
    this.cancelled.push(childId);
  }

  async kill(childId: string): Promise<void> {
    this.killed.push(childId);
  }
}

function childSnapshot(childId: string): ChildRecordSnapshot {
  return {
    childId,
    pid: 42,
    workdir: `/tmp/${childId}`,
    state: "running",
    startedAt: 0,
    lastHeartbeatAt: 0,
    retries: 0,
    metadata: {},
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    forcedTermination: false,
    stopReason: null,
  };
}

function createAlert(overrides: Partial<LoopAlert>): LoopAlert {
  return {
    type: "loop_detected",
    participants: overrides.participants ?? ["orchestrator", "child:alpha"],
    childIds: overrides.childIds ?? ["child-alpha"],
    taskIds: overrides.taskIds ?? ["job"],
    taskTypes: overrides.taskTypes ?? ["analysis"],
    signature: overrides.signature ?? "sig-1",
    occurrences: overrides.occurrences ?? 5,
    windowMs: overrides.windowMs ?? 1_000,
    firstTimestamp: overrides.firstTimestamp ?? 0,
    lastTimestamp: overrides.lastTimestamp ?? 1_000,
    recommendation: overrides.recommendation ?? "kill",
    reason: overrides.reason ?? "loop detected",
  };
}

describe("orchestrator supervisor loop mitigation", () => {
  it("cancels critical loops and ignores duplicates", async () => {
    const manager = new StubChildManager();
    manager.children.push(childSnapshot("child-alpha"));
    const incidents: SupervisorIncident[] = [];

    const supervisor = new OrchestratorSupervisor({
      childManager: manager,
      actions: {
        emitAlert: async (incident) => {
          incidents.push(incident);
        },
        requestRewrite: async () => {},
        requestRedispatch: async () => {},
      },
    });

    const alert = createAlert({ recommendation: "kill" });
    await supervisor.recordLoopAlert(alert);
    await supervisor.recordLoopAlert(alert);

    expect(manager.cancelled).to.deep.equal(["child-alpha"]);
    expect(incidents).to.have.lengthOf(1);
    expect(incidents[0].severity).to.equal("critical");
  });

  it("requests rewrites for warning alerts", async () => {
    const manager = new StubChildManager();
    manager.children.push(childSnapshot("child-beta"));
    const rewrites: SupervisorIncident[] = [];

    const supervisor = new OrchestratorSupervisor({
      childManager: manager,
      actions: {
        emitAlert: async () => {},
        requestRewrite: async (incident) => {
          rewrites.push(incident);
        },
        requestRedispatch: async () => {},
      },
    });

    const alert = createAlert({
      recommendation: "warn",
      signature: "sig-warn",
      childIds: ["child-beta"],
    });
    await supervisor.recordLoopAlert(alert);

    expect(manager.cancelled).to.deep.equal([]);
    expect(rewrites).to.have.lengthOf(1);
    expect(rewrites[0].type).to.equal("loop");
  });
});
