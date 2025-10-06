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
  type SchedulerEnqueueTelemetry,
  type SchedulerTickTrace,
} from "../src/executor/reactiveScheduler.js";

/**
 * Minimal deterministic clock used to drive scheduler tests without relying on
 * real timers. The helpers mimic the behaviour of {@link setTimeout} while
 * giving the test control over the current time.
 */
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

/** Behaviour node incrementing a counter every time the interpreter ticks. */
class CountingNode implements BehaviorNode {
  public readonly id = "counter";
  public readonly ticks: number[] = [];
  private status: BehaviorNodeSnapshot["status"] = "idle";

  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    this.ticks.push(runtime.now());
    this.status = "running";
    return { status: "running" };
  }

  reset(): void {
    // No internal state to reset beyond progress bookkeeping.
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "counting-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { tickCount: this.ticks.length },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "counting-node") {
      throw new Error(`expected counting-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    this.status = snapshot.status;
    // Restore the recorded tick count so getProgress remains consistent with the snapshot.
    const state = snapshot.state as { tickCount?: number } | undefined;
    const restoredCount = typeof state?.tickCount === "number" ? state.tickCount : 0;
    this.ticks.length = restoredCount;
  }

  getProgress(): number {
    return this.status === "running" ? 0.5 : this.status === "idle" ? 0 : 1;
  }
}

/**
 * Scheduler unit tests ensure events trigger interpreter ticks immediately and
 * that the scheduler keeps counting ticks for diagnostics.
 */
describe("reactive scheduler", () => {
  it("ticks the interpreter whenever events are emitted", async () => {
    const clock = new ManualClock();
    const node = new CountingNode();
    const interpreter = new BehaviorTreeInterpreter(node);

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
    });

    await scheduler.runUntilSettled({
      type: "taskReady",
      payload: { nodeId: "root", criticality: 1 },
    });

    expect(node.ticks).to.have.length(1);
    expect(node.ticks[0]).to.equal(0);

    clock.advance(25);

    await scheduler.runUntilSettled({
      type: "blackboardChanged",
      payload: { key: "status", importance: 2 },
    });

    expect(node.ticks).to.have.length(2);
    expect(node.ticks[1]).to.equal(25);
    expect(scheduler.tickCount).to.equal(2);

    scheduler.stop();
  });

  it("reports queue depth snapshots through enqueue and tick telemetry", async () => {
    const clock = new ManualClock();
    const node = new CountingNode();
    const interpreter = new BehaviorTreeInterpreter(node);

    const enqueues: SchedulerEnqueueTelemetry[] = [];
    const ticks: SchedulerTickTrace[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      onEvent: (telemetry) => {
        // Capture the raw queue depth before/after each enqueue so the test can
        // assert the scheduler surfaces the exact snapshots instead of letting
        // downstream consumers derive the values post-hoc.
        enqueues.push(telemetry);
      },
      onTick: (trace) => {
        // Persist the per-tick diagnostics to validate that the queue depth
        // observed right before executing the tick matches the expected
        // cardinality (`pending_before`) and that the scheduler records the
        // post-tick depth in `pending_after`.
        ticks.push(trace);
      },
    });

    scheduler.emit("taskReady", { nodeId: "root", criticality: 1 });
    scheduler.emit("blackboardChanged", { key: "status", importance: 1 });

    expect(enqueues).to.have.length(2);
    const [firstEnqueue, secondEnqueue] = enqueues;

    const expectedTaskReadyPriority = 100 + 1 * 10;
    const expectedBlackboardPriority = 55 + 1 * 5;

    // The first telemetry frame observes an empty queue before enqueueing the
    // `taskReady` event and a single entry afterwards.
    expect(firstEnqueue.event).to.equal("taskReady");
    expect(firstEnqueue.pendingBefore).to.equal(0);
    expect(firstEnqueue.pendingAfter).to.equal(1);
    expect(firstEnqueue.pending).to.equal(firstEnqueue.pendingAfter);
    expect(firstEnqueue.basePriority).to.equal(expectedTaskReadyPriority);

    // The second telemetry frame runs while one item is already queued, so the
    // scheduler reports a `pendingBefore` depth of one and `pendingAfter` of
    // two once the new event joins the queue.
    expect(secondEnqueue.event).to.equal("blackboardChanged");
    expect(secondEnqueue.pendingBefore).to.equal(1);
    expect(secondEnqueue.pendingAfter).to.equal(2);
    expect(secondEnqueue.pending).to.equal(secondEnqueue.pendingAfter);
    expect(secondEnqueue.basePriority).to.equal(expectedBlackboardPriority);
    expect(secondEnqueue.sequence).to.equal(firstEnqueue.sequence + 1);

    await scheduler.runUntilSettled();

    expect(ticks).to.have.length(2);
    const [firstTick, secondTick] = ticks;

    // When the first tick starts there are still two entries pending (the one
    // currently executing plus the second event waiting in the queue).
    expect(firstTick.pendingBefore).to.equal(2);
    expect(firstTick.pendingAfter).to.equal(1);
    expect(firstTick.basePriority).to.equal(expectedTaskReadyPriority);

    // The second tick processes the last queued event, so the queue depth drops
    // to zero right after the tick completes.
    expect(secondTick.pendingBefore).to.equal(1);
    expect(secondTick.pendingAfter).to.equal(0);
    expect(secondTick.basePriority).to.equal(expectedBlackboardPriority);
    expect(secondTick.sequence).to.equal(firstTick.sequence + 1);

    scheduler.stop();
  });
});
