import { describe, it } from "mocha";
import { expect } from "chai";

import {
  Autoscaler,
  type AutoscalerEventInput,
  type AutoscalerSupervisor,
} from "../src/agents/autoscaler.js";
import { ChildrenIndex } from "../src/state/childrenIndex.js";
import type { LoopTickContext } from "../src/executor/loop.js";
import type { CreateChildOptions } from "../src/childSupervisor.js";

/** Deterministic clock mirroring the `Date.now` contract. */
class ManualClock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

/** Builds a minimal loop context compatible with the autoscaler reconciler. */
function buildContext(clock: ManualClock, tickIndex = 0): LoopTickContext {
  const controller = new AbortController();
  return {
    startedAt: clock.now(),
    now: () => clock.now(),
    tickIndex,
    signal: controller.signal,
    budget: undefined,
  };
}

interface SupervisorBehaviour {
  cancelFails?: boolean;
  killFails?: boolean;
}

/**
 * Supervisor double exposing child snapshots and configurable failure modes so tests
 * can exercise the autoscaler correlation paths deterministically.
 */
class CorrelatedSupervisor implements AutoscalerSupervisor {
  public readonly childrenIndex = new ChildrenIndex();

  constructor(private readonly clock: ManualClock, private readonly behaviour: SupervisorBehaviour = {}) {}

  async createChild(options?: CreateChildOptions): Promise<unknown> {
    const childId =
      typeof options?.childId === "string" && options.childId.trim().length > 0
        ? options.childId.trim()
        : `child-${this.childrenIndex.list().length + 1}`;
    this.registerChild(childId, options?.metadata ?? {});
    return { childId };
  }

  async cancel(childId: string): Promise<unknown> {
    if (this.behaviour.cancelFails) {
      throw new Error("cancel_failed");
    }
    const removed = this.childrenIndex.removeChild(childId);
    if (!removed) {
      throw new Error(`unknown child ${childId}`);
    }
    return null;
  }

  async kill(childId: string): Promise<unknown> {
    if (this.behaviour.killFails) {
      throw new Error("kill_failed");
    }
    const removed = this.childrenIndex.removeChild(childId);
    if (!removed) {
      throw new Error(`unknown child ${childId}`);
    }
    return null;
  }

  registerChild(childId: string, metadata: Record<string, unknown>): void {
    this.childrenIndex.registerChild({
      childId,
      pid: 100 + this.childrenIndex.list().length,
      workdir: `/tmp/${childId}`,
      startedAt: this.clock.now(),
      state: "idle",
      metadata,
    });
  }
}

/** Validates correlation hints when the autoscaler retires an idle child gracefully. */
describe("agents autoscaler correlation", () => {
  it("emits correlation hints when scaling down an idle child", async () => {
    const clock = new ManualClock();
    const supervisor = new CorrelatedSupervisor(clock);
    const childId = "child-alpha";
    supervisor.registerChild(childId, {
      job_id: "job-777",
      run_id: "run-123",
      op_id: "op-456",
      graph_id: "graph-graph",
      node_id: "node-node",
    });

    const events: AutoscalerEventInput[] = [];
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 0, maxChildren: 1, cooldownMs: 0 },
      emitEvent: (event) => {
        events.push(event);
      },
    });

    await autoscaler.reconcile(buildContext(clock));

    expect(events).to.have.lengthOf(1);
    const [event] = events;
    expect(event.payload.msg).to.equal("scale_down");
    expect(event.childId).to.equal(childId);
    expect(event.payload.child_id).to.equal(childId);

    const correlation = event.correlation ?? {};
    expect(correlation.childId).to.equal(childId);
    expect(correlation.runId).to.equal("run-123");
    expect(correlation.opId).to.equal("op-456");
    expect(correlation.jobId).to.equal("job-777");
    expect(correlation.graphId).to.equal("graph-graph");
    expect(correlation.nodeId).to.equal("node-node");
  });

  it("keeps explicit null correlation overrides from child metadata", async () => {
    const clock = new ManualClock();
    const supervisor = new CorrelatedSupervisor(clock);
    const childId = "child-null";
    supervisor.registerChild(childId, {
      run_id: null,
      op_id: null,
      job_id: null,
      graph_id: null,
      node_id: null,
    });

    const events: AutoscalerEventInput[] = [];
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 0, maxChildren: 1, cooldownMs: 0 },
      emitEvent: (event) => {
        events.push(event);
      },
    });

    await autoscaler.reconcile(buildContext(clock));

    expect(events).to.have.lengthOf(1);
    const [event] = events;
    expect(event.payload.msg).to.equal("scale_down");
    const correlation = event.correlation ?? {};
    expect(correlation.childId).to.equal(childId);
    expect(correlation.runId).to.equal(null);
    expect(correlation.opId).to.equal(null);
    expect(correlation.jobId).to.equal(null);
    expect(correlation.graphId).to.equal(null);
    expect(correlation.nodeId).to.equal(null);
  });

  it("preserves correlation when cancellation fallback terminates the child", async () => {
    const clock = new ManualClock();
    const supervisor = new CorrelatedSupervisor(clock, { cancelFails: true });
    const childId = "child-beta";
    supervisor.registerChild(childId, {
      jobId: "job-camel",
      runId: "run-camel",
      opId: "op-camel",
      graphId: "graph-camel",
      nodeId: "node-camel",
    });

    const events: AutoscalerEventInput[] = [];
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 0, maxChildren: 1, cooldownMs: 0 },
      emitEvent: (event) => {
        events.push(event);
      },
    });

    await autoscaler.reconcile(buildContext(clock, 1));

    expect(events.map((event) => event.payload.msg)).to.deep.equal([
      "scale_down_cancel_failed",
      "scale_down_forced",
    ]);

    for (const event of events) {
      expect(event.childId).to.equal(childId);
      const correlation = event.correlation ?? {};
      expect(correlation.childId).to.equal(childId);
      expect(correlation.runId).to.equal("run-camel");
      expect(correlation.opId).to.equal("op-camel");
      expect(correlation.jobId).to.equal("job-camel");
      expect(correlation.graphId).to.equal("graph-camel");
      expect(correlation.nodeId).to.equal("node-camel");
    }
  });

  it("includes correlation hints when forced termination fails", async () => {
    const clock = new ManualClock();
    const supervisor = new CorrelatedSupervisor(clock, { cancelFails: true, killFails: true });
    const childId = "child-gamma";
    supervisor.registerChild(childId, {
      correlation: {
        runId: "run-nested",
        jobId: "job-nested",
        opId: "op-nested",
        graphId: "graph-nested",
        nodeId: "node-nested",
      },
    });

    const events: AutoscalerEventInput[] = [];
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 0, maxChildren: 1, cooldownMs: 0 },
      emitEvent: (event) => {
        events.push(event);
      },
    });

    await autoscaler.reconcile(buildContext(clock, 2));

    expect(events.map((event) => event.payload.msg)).to.deep.equal([
      "scale_down_cancel_failed",
      "scale_down_failed",
    ]);

    for (const event of events) {
      expect(event.childId).to.equal(childId);
      const correlation = event.correlation ?? {};
      expect(correlation.childId).to.equal(childId);
      expect(correlation.runId).to.equal("run-nested");
      expect(correlation.opId).to.equal("op-nested");
      expect(correlation.jobId).to.equal("job-nested");
      expect(correlation.graphId).to.equal("graph-nested");
      expect(correlation.nodeId).to.equal("node-nested");
    }
  });

  it("derives correlation hints from spawn templates during scale up", async () => {
    const clock = new ManualClock();
    const supervisor = new CorrelatedSupervisor(clock);
    const events: AutoscalerEventInput[] = [];
    const autoscaler = new Autoscaler({
      supervisor,
      now: () => clock.now(),
      config: { minChildren: 0, maxChildren: 2, cooldownMs: 0 },
      spawnTemplate: {
        childId: "template-child",
        metadata: {
          correlation: { run_id: "run-template" },
          job_id: "job-template",
        },
        manifestExtras: {
          op_id: "op-template",
          graph_id: "graph-template",
          node_id: "node-template",
        },
      },
      emitEvent: (event) => {
        events.push(event);
      },
    });

    autoscaler.updateBacklog(10);
    await autoscaler.reconcile(buildContext(clock, 5));

    expect(events).to.have.lengthOf(1);
    const [event] = events;
    expect(event.payload.msg).to.equal("scale_up");
    expect(event.childId).to.equal("template-child");
    const correlation = event.correlation ?? {};
    expect(correlation.childId).to.equal("template-child");
    expect(correlation.runId).to.equal("run-template");
    expect(correlation.jobId).to.equal("job-template");
    expect(correlation.opId).to.equal("op-template");
    expect(correlation.graphId).to.equal("graph-template");
    expect(correlation.nodeId).to.equal("node-template");
  });
});
