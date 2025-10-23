import { describe, it } from "mocha";
import { expect } from "chai";

import { BehaviorTreeInterpreter } from "../src/executor/bt/interpreter.js";
import { ReactiveScheduler } from "../src/executor/reactiveScheduler.js";
import type { TaskReadyEvent, StigmergyChangedEvent } from "../src/executor/reactiveScheduler.js";
import { ManualClock, ScriptedNode } from "./helpers/reactiveSchedulerTestUtils.js";

/**
 * Optional scheduler metadata must be omitted instead of serialised as
 * `undefined` so `exactOptionalPropertyTypes` can be safely enabled.
 */
describe("reactive scheduler optional field sanitisation", () => {
  it("omits derived pheromone hints when the provider has no reading", () => {
    const clock = new ManualClock();
    const interpreter = new BehaviorTreeInterpreter(
      new ScriptedNode("script", [
        { status: "running" },
        { status: "success" },
      ]),
    );

    const captured: TaskReadyEvent[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      getPheromoneIntensity: () => undefined,
      onEvent: (telemetry) => {
        if (telemetry.event === "taskReady") {
          captured.push({ ...telemetry.payload });
        }
      },
    });

    scheduler.emit("taskReady", { nodeId: "alpha", pheromone: undefined, pheromoneBounds: undefined });

    expect(captured).to.have.lengthOf(1);
    const payload = captured[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "pheromone")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "pheromoneBounds")).to.equal(false);

    scheduler.stop();
  });

  it("drops stigmergy range placeholders when no bounds are available", () => {
    const clock = new ManualClock();
    const interpreter = new BehaviorTreeInterpreter(
      new ScriptedNode("script", [
        { status: "running" },
        { status: "success" },
      ]),
    );

    const captured: StigmergyChangedEvent[] = [];

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      getPheromoneIntensity: () => undefined,
      getPheromoneBounds: () => undefined,
      onEvent: (telemetry) => {
        if (telemetry.event === "stigmergyChanged") {
          captured.push({ ...telemetry.payload });
        }
      },
    });

    const dirtyStigmergyEvent = {
      nodeId: "beta",
      // Tests explicitly coerce an undefined intensity to mimic historical
      // behaviour where callers could provide sparse payloads.
      intensity: undefined as unknown as number,
      bounds: undefined,
    } as unknown as StigmergyChangedEvent;

    scheduler.emit("stigmergyChanged", dirtyStigmergyEvent);

    expect(captured).to.have.lengthOf(1);
    const payload = captured[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "intensity")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(payload, "bounds")).to.equal(false);

    scheduler.stop();
  });

  it("omits causal event identifiers when causal memory is disabled", () => {
    const clock = new ManualClock();
    const interpreter = new BehaviorTreeInterpreter(
      new ScriptedNode("script", [
        { status: "running" },
        { status: "success" },
      ]),
    );

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

    scheduler.emit("taskReady", { nodeId: "causal" });

    const internals = scheduler as unknown as { queue: Array<Record<string, unknown>> };
    expect(internals.queue, "queue contains the scheduled entry").to.have.lengthOf(1);
    const queued = internals.queue[0]!;
    expect(Object.prototype.hasOwnProperty.call(queued, "causalEventId"))
      .to.equal(false, "causal event identifier should not be materialised when memory is absent");

    scheduler.stop();
  });

  it("records causal event identifiers when a memory instance is provided", () => {
    const clock = new ManualClock();
    const interpreter = new BehaviorTreeInterpreter(
      new ScriptedNode("script", [
        { status: "running" },
        { status: "success" },
      ]),
    );

    const fakeMemory = {
      record: () => ({ id: "event-1" }),
    } as { record: (input: unknown, causes: string[]) => { id: string } };

    const scheduler = new ReactiveScheduler({
      interpreter,
      runtime: {
        invokeTool: async () => undefined,
        now: () => clock.now(),
        wait: (ms) => clock.wait(ms),
        variables: {},
      },
      now: () => clock.now(),
      causalMemory: fakeMemory as unknown as import("../src/knowledge/causalMemory.js").CausalMemory,
    });

    scheduler.emit("taskReady", { nodeId: "tracked" });

    const internals = scheduler as unknown as { queue: Array<Record<string, unknown>> };
    expect(internals.queue, "queue contains the scheduled entry").to.have.lengthOf(1);
    const queued = internals.queue[0]!;
    expect(queued.causalEventId).to.equal("event-1");

    scheduler.stop();
  });
});
