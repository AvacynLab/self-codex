import { describe, it } from "mocha";
import { expect } from "chai";

import {
  OrchestratorSupervisor,
  type SupervisorChildManager,
  type SupervisorIncident,
} from "../src/agents/supervisor.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";
import type { LoopTickContext } from "../src/executor/loop.js";

/** Deterministic manual clock used to advance time explicitly in tests. */
class ManualClock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

/** Lightweight child manager double exposing the bare minimum for the tests. */
class StubChildManager implements SupervisorChildManager {
  public readonly children: ChildRecordSnapshot[] = [];

  public readonly childrenIndex = {
    list: (): ChildRecordSnapshot[] => this.children.map((child) => ({ ...child })),
  };

  async cancel(): Promise<void> {
    /* The stagnation tests never cancel children. */
  }
}

function createChild(overrides: Partial<ChildRecordSnapshot>): ChildRecordSnapshot {
  return {
    childId: overrides.childId ?? "child-a",
    pid: overrides.pid ?? 1234,
    workdir: overrides.workdir ?? "/tmp/child-a",
    state: overrides.state ?? "idle",
    startedAt: overrides.startedAt ?? 0,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? 0,
    retries: overrides.retries ?? 0,
    metadata: { ...(overrides.metadata ?? {}) },
    endedAt: overrides.endedAt ?? null,
    exitCode: overrides.exitCode ?? null,
    exitSignal: overrides.exitSignal ?? null,
    forcedTermination: overrides.forcedTermination ?? false,
    stopReason: overrides.stopReason ?? null,
    role: overrides.role ?? null,
    limits: overrides.limits ?? null,
    attachedAt: overrides.attachedAt ?? null,
  };
}

function buildContext(clock: ManualClock, tickIndex: number): LoopTickContext {
  const controller = new AbortController();
  return {
    startedAt: clock.now(),
    now: () => clock.now(),
    tickIndex,
    signal: controller.signal,
  };
}

describe("orchestrator supervisor stagnation", () => {
  it("requests rewrite and redispatch when backlog stalls", async () => {
    const clock = new ManualClock();
    const manager = new StubChildManager();
    manager.children.push(
      createChild({
        childId: "child-primary",
        state: "idle",
        startedAt: 0,
        lastHeartbeatAt: 0,
      }),
    );

    const incidents: SupervisorIncident[] = [];
    const rewrites: SupervisorIncident[] = [];
    const redispatches: SupervisorIncident[] = [];

    const supervisor = new OrchestratorSupervisor({
      childManager: manager,
      now: () => clock.now(),
      stagnationTickThreshold: 3,
      stagnationBacklogThreshold: 2,
      starvationIdleMs: 200,
      starvationRepeatMs: 500,
      actions: {
        emitAlert: async (incident) => {
          incidents.push(incident);
        },
        requestRewrite: async (incident) => {
          rewrites.push(incident);
        },
        requestRedispatch: async (incident) => {
          redispatches.push(incident);
        },
      },
    });

    for (let tick = 0; tick < 4; tick += 1) {
      supervisor.recordSchedulerSnapshot({
        schedulerTick: tick,
        backlog: 4,
        completed: 0,
        failed: 0,
      });
      await supervisor.reconcile(buildContext(clock, tick));
      clock.advance(100);
    }

    expect(rewrites).to.have.lengthOf(1);
    expect(redispatches).to.have.lengthOf(1);
    expect(incidents).to.have.length.greaterThan(0);
    expect(rewrites[0].type).to.equal("stagnation");
    expect(redispatches[0].type).to.equal("stagnation");

    supervisor.recordSchedulerSnapshot({
      schedulerTick: 5,
      backlog: 1,
      completed: 1,
      failed: 0,
    });
    await supervisor.reconcile(buildContext(clock, 5));

    supervisor.recordSchedulerSnapshot({
      schedulerTick: 6,
      backlog: 3,
      completed: 0,
      failed: 0,
    });
    await supervisor.reconcile(buildContext(clock, 6));

    expect(rewrites).to.have.lengthOf(1);
    expect(redispatches).to.have.lengthOf(1);
  });
});
