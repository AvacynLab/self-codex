import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeInterpreter } from "../src/executor/bt/interpreter.js";
import { ReactiveScheduler } from "../src/executor/reactiveScheduler.js";
import {
  BusyNode,
  ManualClock,
  ScriptedNode,
} from "./helpers/reactiveSchedulerTestUtils.js";

/**
 * Prioritisation and cooperative budgeting safeguards must keep aged events
 * moving forward while allowing sustained bursts to yield back to the loop.
 */
describe("reactive scheduler fairness", () => {
  it("promotes aged low-priority events even under a steady urgent flood", async () => {
    const clock = new ManualClock();
    const node = new ScriptedNode("script", [
      { status: "running" },
      { status: "running" },
      { status: "running" },
      { status: "running" },
      { status: "running" },
      { status: "running" },
      { status: "success" },
    ]);
    const interpreter = new BehaviorTreeInterpreter(node);

    const processed: string[] = [];
    let sawStigmergy = false;

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      ageWeight: 0,
      agingHalfLifeMs: 250,
      agingFairnessBoost: 80,
      batchQuantumMs: 48,
      maxBatchTicks: 32,
      onTick: ({ event }) => {
        processed.push(event);
        if (event === "stigmergyChanged") {
          sawStigmergy = true;
          return;
        }
        if (event === "taskReady" && !sawStigmergy) {
          clock.advance(400);
          scheduler.emit("taskReady", { nodeId: "dominant", criticality: 12, pheromone: 8 });
        }
      },
    });

    scheduler.emit("stigmergyChanged", { nodeId: "stale", intensity: 1 });
    clock.advance(500);
    scheduler.emit("taskReady", { nodeId: "dominant", criticality: 12, pheromone: 8 });

    const result = await scheduler.runUntilSettled();

    expect(result.status).to.equal("success");
    const firstStigIndex = processed.indexOf("stigmergyChanged");
    expect(firstStigIndex).to.be.greaterThan(-1);
    expect(firstStigIndex).to.be.lessThan(processed.length - 1);
    expect(processed.slice(0, firstStigIndex)).to.satisfy((events: string[]) => events.every((event) => event === "taskReady"));

    scheduler.stop();
  });

  it("yields once the batch quantum is exhausted so the event loop can breathe", async () => {
    const clock = new ManualClock();
    const node = new BusyNode("busy", [12, 12, 12], clock);
    const interpreter = new BehaviorTreeInterpreter(node);

    const batches: number[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      batchQuantumMs: 20,
      maxBatchTicks: 2,
      onTick: ({ batchIndex }) => {
        batches.push(batchIndex);
      },
    });

    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });
    scheduler.emit("taskReady", { nodeId: "busy", criticality: 1 });

    const result = await scheduler.runUntilSettled();

    expect(result.status).to.equal("success");
    expect(batches).to.deep.equal([0, 0, 1]);
    scheduler.stop();
  });
});
