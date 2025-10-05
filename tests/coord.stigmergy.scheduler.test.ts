import { describe, it } from "mocha";
import { expect } from "chai";

import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";
import { BehaviorTreeInterpreter } from "../src/executor/bt/interpreter.js";
import {
  ReactiveScheduler,
  type StigmergyChangedEvent,
  type TaskReadyEvent,
} from "../src/executor/reactiveScheduler.js";
import { StigmergyField } from "../src/coord/stigmergy.js";

/** Manual clock exposing {@link wait} so scheduler timings stay reproducible. */
class ManualClock {
  private current = 0;
  private readonly scheduled: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.current;
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduled.push({ at: this.current + ms, resolve });
    });
  }

  advance(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  advanceTo(target: number): void {
    if (target < this.current) {
      this.current = target;
      return;
    }
    this.current = target;
    const remaining: Array<{ at: number; resolve: () => void }> = [];
    for (const entry of this.scheduled) {
      if (entry.at <= this.current) {
        entry.resolve();
      } else {
        remaining.push(entry);
      }
    }
    this.scheduled.length = 0;
    this.scheduled.push(...remaining);
  }
}

/** Behaviour node returning scripted results to control interpreter progression. */
class ScriptedNode implements BehaviorNode {
  private index = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(
    public readonly id: string,
    private readonly results: BehaviorTickResult[],
  ) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    this.status = result.status === "running" ? "running" : result.status;
    return result;
  }

  reset(): void {
    // Preserve execution history to keep consuming the scripted results.
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "scripted-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { index: this.index, status: this.status },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "scripted-node") {
      throw new Error(`expected scripted-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { index?: number; status?: BehaviorNodeSnapshot["status"] } | undefined;
    this.index = typeof state?.index === "number" ? state.index : 0;
    this.status = state?.status ?? "idle";
  }

  getProgress(): number {
    if (this.results.length === 0) {
      return 1;
    }
    const consumed = Math.min(this.index, this.results.length);
    return consumed / this.results.length;
  }
}

/**
 * Ensures stigmergy-driven pheromones alter the scheduler priorities so hot nodes
 * are executed before older but less urgent tasks.
 */
describe("coordination stigmergy scheduler integration", () => {
  it("prioritises taskReady events using the stigmergic field", async () => {
    const clock = new ManualClock();
    const field = new StigmergyField({ now: () => clock.now() });
    const node = new ScriptedNode("root", [
      { status: "running" },
      { status: "running" },
      { status: "success" },
    ]);
    const interpreter = new BehaviorTreeInterpreter(node);
    const processed: Array<{ event: string; nodeId: string }> = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      getPheromoneIntensity: (nodeId) => field.getNodeIntensity(nodeId)?.intensity ?? 0,
      onTick: ({ event, payload }) => {
        if (event === "taskReady") {
          const { nodeId } = payload as TaskReadyEvent;
          processed.push({ event, nodeId });
        }
        if (event === "stigmergyChanged") {
          const { nodeId } = payload as StigmergyChangedEvent;
          processed.push({ event, nodeId });
        }
      },
    });

    const unsubscribe = field.onChange((change) => {
      scheduler.emit("stigmergyChanged", {
        nodeId: change.nodeId,
        intensity: change.totalIntensity,
        type: change.type,
      });
    });

    try {
      const resultPromise = scheduler.runUntilSettled({
        type: "taskReady",
        payload: { nodeId: "alpha", criticality: 1 },
      });

      clock.advance(5);
      scheduler.emit("taskReady", { nodeId: "beta", criticality: 1 });

      field.mark("beta", "explore", 20);

      const result = await resultPromise;
      expect(result.status).to.equal("success");

      const taskReadyOrder = processed
        .filter((entry) => entry.event === "taskReady")
        .map((entry) => entry.nodeId);
      expect(taskReadyOrder).to.deep.equal(["beta", "alpha"]);
      expect(field.getNodeIntensity("beta")?.intensity).to.equal(20);
    } finally {
      unsubscribe();
      scheduler.stop();
    }
  });
});
