import { describe, it } from "mocha";
import { expect } from "chai";

import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";
import { BehaviorTreeInterpreter } from "../src/executor/bt/interpreter.js";
import { ReactiveScheduler } from "../src/executor/reactiveScheduler.js";

/** Deterministic manual clock mirroring {@link setTimeout} semantics for tests. */
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

/** Behaviour node producing scripted results to emulate long-running plans. */
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
    // Preserve execution history so the interpreter keeps advancing through the script.
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
 * Priority policy tests ensure that aged events outrank newer but less urgent
 * ones, which keeps deferred actions progressing even under continuous load.
 */
describe("reactive scheduler priority", () => {
  it("prefers older events when their aging outweighs base priority", async () => {
    const clock = new ManualClock();
    const node = new ScriptedNode("script", [
      { status: "running" },
      { status: "success" },
    ]);
    const interpreter = new BehaviorTreeInterpreter(node);
    const processed: string[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      ageWeight: 0.02,
      onTick: ({ event }) => {
        processed.push(event);
      },
    });

    scheduler.emit("stigmergyChanged", { nodeId: "alpha", intensity: 5 });
    clock.advance(5000);
    scheduler.emit("taskDone", { nodeId: "alpha", success: true });

    const result = await scheduler.runUntilSettled();

    expect(processed).to.deep.equal(["stigmergyChanged", "taskDone"]);
    expect(result.status).to.equal("success");
    expect(scheduler.tickCount).to.equal(2);

    scheduler.stop();
  });
});
