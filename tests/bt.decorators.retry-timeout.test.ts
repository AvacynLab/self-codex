import { describe, it } from "mocha";
import { expect } from "chai";

import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";
import { RetryNode, TaskLeaf, TimeoutNode } from "../src/executor/bt/nodes.js";

/** Minimal fake clock driving deterministic wait promises in tests. */
class TestClock {
  private current = 0;
  private readonly scheduled: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.current;
  }

  async wait(ms: number): Promise<void> {
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

/** Behaviour node that fails a configurable number of times before succeeding. */
class FlakyNode implements BehaviorNode {
  private attempts = 0;
  private ticks = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(
    public readonly id: string,
    private readonly failBeforeSuccess: number,
  ) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    this.ticks += 1;
    if (this.attempts < this.failBeforeSuccess) {
      this.attempts += 1;
      this.status = "failure";
      return { status: "failure" };
    }
    this.status = "success";
    return { status: "success" };
  }

  reset(): void {
    // Preserve the attempt counter so retry decorators observe cumulative failures.
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "flaky-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { attempts: this.attempts, ticks: this.ticks },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "flaky-node") {
      throw new Error(`expected flaky-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { attempts?: number; ticks?: number } | undefined;
    this.attempts = typeof state?.attempts === "number" ? state.attempts : 0;
    this.ticks = typeof state?.ticks === "number" ? state.ticks : 0;
    this.status = snapshot.status;
  }

  getProgress(): number {
    const totalAttempts = this.failBeforeSuccess + 1;
    if (totalAttempts <= 0) {
      return 1;
    }
    const executed = Math.min(this.ticks, totalAttempts);
    return executed / totalAttempts;
  }
}

/** Behaviour node staying in RUNNING until externally resolved. */
class DeferredNode implements BehaviorNode {
  private resolver: ((result: BehaviorTickResult) => void) | null = null;
  private pending: Promise<BehaviorTickResult> | null = null;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(public readonly id: string, private readonly result: BehaviorTickResult) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    if (!this.pending) {
      this.pending = new Promise((resolve) => {
        this.resolver = resolve;
      });
    }
    this.status = "running";
    return this.pending;
  }

  resolve(): void {
    this.resolver?.(this.result);
    this.resolver = null;
    this.pending = null;
    this.status = this.result.status === "running" ? "running" : this.result.status;
  }

  reset(): void {
    this.pending = null;
    this.resolver = null;
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "deferred-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { pending: this.pending !== null },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "deferred-node") {
      throw new Error(`expected deferred-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    this.status = snapshot.status;
    // Pending promises cannot be resumed deterministically, so reset to idle when restoring.
    this.pending = null;
    this.resolver = null;
  }

  getProgress(): number {
    if (this.status === "idle") {
      return 0;
    }
    if (this.status === "running") {
      return 0.5;
    }
    return 1;
  }
}

const noopRuntime: TickRuntime = {
  invokeTool: async () => undefined,
  now: () => 0,
  wait: async () => {},
  variables: {},
};

/**
 * Unit tests covering retry and timeout decorators. The clock abstraction keeps
 * the scenarios deterministic and free from real timers so the CI remains stable.
 */
describe("behaviour tree decorators", () => {
  it("retries failing children until success", async () => {
    const flaky = new FlakyNode("flaky", 2);
    const runtime: TickRuntime = {
      ...noopRuntime,
      wait: async () => {},
    };
    const retry = new RetryNode("retry", 5, flaky, 0);

    let result = await retry.tick(runtime);
    expect(result.status).to.equal("running");

    result = await retry.tick(runtime);
    expect(result.status).to.equal("running");

    result = await retry.tick(runtime);
    expect(result.status).to.equal("success");
  });

  it("fails when retries exceed the configured budget", async () => {
    const flaky = new FlakyNode("flaky", 5);
    const runtime: TickRuntime = {
      ...noopRuntime,
      wait: async () => {},
    };
    const retry = new RetryNode("retry", 2, flaky, 0);

    const first = await retry.tick(runtime);
    expect(first.status).to.equal("running");

    const result = await retry.tick(runtime);
    expect(result.status).to.equal("failure");
  });

  it("returns failure when a timeout elapses before the child completes", async () => {
    const deferred = new DeferredNode("deferred", { status: "success" });
    const clock = new TestClock();
    const runtime: TickRuntime = {
      ...noopRuntime,
      now: () => clock.now(),
      wait: (ms) => clock.wait(ms),
    };
    const timeout = new TimeoutNode("timeout", 100, deferred);

    const pending = timeout.tick(runtime);
    await Promise.resolve();
    clock.advanceTo(clock.now() + 100);
    const result = await pending;
    expect(result.status).to.equal("failure");
  });

  it("propagates the child result when it resolves before the timeout", async () => {
    const deferred = new DeferredNode("deferred", { status: "success" });
    const clock = new TestClock();
    const runtime: TickRuntime = {
      ...noopRuntime,
      now: () => clock.now(),
      wait: (ms) => clock.wait(ms),
    };
    const timeout = new TimeoutNode("timeout", 100, deferred);

    const pending = timeout.tick(runtime);
    await Promise.resolve();
    deferred.resolve();
    const result = await pending;
    expect(result.status).to.equal("success");
  });

  it("requests categorised timeout budgets and records successful outcomes", async () => {
    const deferred = new DeferredNode("deferred", { status: "success" });
    const clock = new TestClock();
    const waits: number[] = [];
    const recorded: Array<{ category: string; outcome: { durationMs: number; success: boolean; budgetMs: number } }> = [];
    const runtime: TickRuntime = {
      ...noopRuntime,
      now: () => clock.now(),
      wait: (ms) => {
        waits.push(ms);
        return clock.wait(ms);
      },
      recommendTimeout: (category, complexity, fallback) => {
        expect(category).to.equal("analysis");
        expect(complexity).to.equal(2);
        expect(fallback).to.equal(120);
        return 80;
      },
      recordTimeoutOutcome: (category, outcome) => {
        recorded.push({ category, outcome });
      },
    };
    const timeout = new TimeoutNode("timeout", 120, deferred, { category: "analysis", complexityScore: 2 });

    const pending = timeout.tick(runtime);
    await Promise.resolve();
    expect(waits).to.deep.equal([80]);

    clock.advance(30);
    deferred.resolve();

    const result = await pending;
    expect(result.status).to.equal("success");
    expect(recorded).to.have.length(1);
    expect(recorded[0].category).to.equal("analysis");
    expect(recorded[0].outcome.success).to.equal(true);
    expect(recorded[0].outcome.budgetMs).to.equal(80);
    expect(recorded[0].outcome.durationMs).to.equal(30);
  });

  it("falls back to runtime failure when the timeout elapses", async () => {
    const deferred = new DeferredNode("deferred", { status: "success" });
    const clock = new TestClock();
    const waits: number[] = [];
    const recorded: Array<{ category: string; outcome: { durationMs: number; success: boolean; budgetMs: number } }> = [];
    const runtime: TickRuntime = {
      ...noopRuntime,
      now: () => clock.now(),
      wait: (ms) => {
        waits.push(ms);
        return clock.wait(ms);
      },
      recommendTimeout: () => 50,
      recordTimeoutOutcome: (category, outcome) => {
        recorded.push({ category, outcome });
      },
    };
    const timeout = new TimeoutNode("timeout", 200, deferred, { category: "analysis" });

    const pending = timeout.tick(runtime);
    await Promise.resolve();
    expect(waits).to.deep.equal([50]);

    clock.advanceTo(50);
    const result = await pending;
    expect(result.status).to.equal("failure");
    expect(recorded).to.have.length(1);
    expect(recorded[0].category).to.equal("analysis");
    expect(recorded[0].outcome.success).to.equal(false);
    expect(recorded[0].outcome.budgetMs).to.equal(50);
    expect(recorded[0].outcome.durationMs).to.equal(50);
  });

  it("invokes the runtime tool through task leaves", async () => {
    let calledWith: unknown = null;
    const runtime: TickRuntime = {
      ...noopRuntime,
      invokeTool: async (_tool, input) => {
        calledWith = input;
        return { echoed: input };
      },
      variables: { payload: { message: "hello" } },
    };
    const leaf = new TaskLeaf("task", "noop", { inputKey: "payload" });

    const result = await leaf.tick(runtime);
    expect(result.status).to.equal("success");
    expect(result.output).to.deep.equal({ echoed: { message: "hello" } });
    expect(calledWith).to.deep.equal({ message: "hello" });
  });
});
