import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeInterpreter } from "../src/executor/bt/interpreter.js";
import { ReactiveScheduler } from "../src/executor/reactiveScheduler.js";
import { BusyNode, ManualClock, ScriptedNode } from "./helpers/reactiveSchedulerTestUtils.js";

/**
 * Cooperative budgeting should cap the number of ticks executed per microtask
 * while still allowing operators to disable the guardrails when a benchmark
 * needs to run as fast as possible. These tests focus on the batch accounting
 * surfaced through {@link ReactiveScheduler}'s `onTick` hook.
 */
describe("reactive scheduler budgets", () => {
  it("resets batch telemetry after yielding because maxBatchTicks was hit", async () => {
    const clock = new ManualClock();
    const node = new BusyNode("busy", [4, 4, 4, 4], clock);
    const interpreter = new BehaviorTreeInterpreter(node);

    const batches: number[] = [];
    const ticksPerBatch: number[] = [];
    const elapsedPerTick: number[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      batchQuantumMs: 1000,
      maxBatchTicks: 2,
      onTick: ({ batchIndex, ticksInBatch, batchElapsedMs }) => {
        batches.push(batchIndex);
        ticksPerBatch.push(ticksInBatch);
        elapsedPerTick.push(batchElapsedMs);
      },
    });

    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });

    const result = await scheduler.runUntilSettled();

    expect(result.status).to.equal("success");
    expect(batches).to.deep.equal([0, 0, 1, 1]);
    expect(ticksPerBatch).to.deep.equal([1, 2, 1, 2]);
    expect(elapsedPerTick).to.deep.equal([4, 8, 4, 8]);
    scheduler.stop();
  });

  it("keeps draining a batch when cooperative budgets are disabled", async () => {
    const clock = new ManualClock();
    const node = new BusyNode("busy", [3, 3, 3], clock);
    const interpreter = new BehaviorTreeInterpreter(node);

    const batches: number[] = [];
    const ticksPerBatch: number[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      batchQuantumMs: 0,
      maxBatchTicks: Number.POSITIVE_INFINITY,
      onTick: ({ batchIndex, ticksInBatch }) => {
        batches.push(batchIndex);
        ticksPerBatch.push(ticksInBatch);
      },
    });

    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });

    const result = await scheduler.runUntilSettled();

    expect(result.status).to.equal("success");
    expect(batches).to.deep.equal([0, 0, 0]);
    expect(ticksPerBatch).to.deep.equal([1, 2, 3]);
    scheduler.stop();
  });

  it("yields and resumes cleanly when new work arrives mid-batch", async () => {
    const clock = new ManualClock();
    const node = new ScriptedNode("script", [
      { status: "running" },
      { status: "running" },
      { status: "running" },
      { status: "success" },
    ]);
    const interpreter = new BehaviorTreeInterpreter(node);

    const batches: number[] = [];
    const pendingCounts: number[] = [];
    let injectedExtra = false; // Guarantees we only enqueue the extra work once.

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      batchQuantumMs: 10,
      maxBatchTicks: 2,
      onTick: ({ batchIndex, pendingAfter }) => {
        batches.push(batchIndex);
        pendingCounts.push(pendingAfter);
        if (!injectedExtra && pendingAfter === 0 && batchIndex === 0) {
          injectedExtra = true;
          // Enqueue fresh work so the next batch resumes cleanly with new events.
          scheduler.emit("taskReady", { nodeId: "script", criticality: 1 });
          scheduler.emit("taskReady", { nodeId: "script", criticality: 1 });
        }
      },
    });

    // Seed the queue with two ticks so the first batch drains before extra events arrive.
    scheduler.emit("taskReady", { nodeId: "script", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "script", criticality: 1 });

    const result = await scheduler.runUntilSettled();

    expect(result.status).to.equal("success");
    expect(batches).to.deep.equal([0, 0, 1, 1]);
    expect(pendingCounts).to.deep.equal([1, 0, 1, 0]);
    scheduler.stop();
  });
});
