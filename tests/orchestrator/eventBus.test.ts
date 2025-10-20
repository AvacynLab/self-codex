import { strict as assert } from "node:assert";

import { StructuredLogger, type LogEntry } from "../../src/logger.js";
import { BlackboardStore, type BlackboardWatchOptions } from "../../src/coord/blackboard.js";
import { StigmergyField, type StigmergyChangeListener } from "../../src/coord/stigmergy.js";
import { ContractNetCoordinator } from "../../src/coord/contractNet.js";
import { ValueGraph } from "../../src/values/valueGraph.js";
import { ContractNetWatcherTelemetryRecorder } from "../../src/coord/contractNetWatchers.js";
import { createOrchestratorEventBus } from "../../src/orchestrator/eventBus.js";

/**
 * Blackboard store that counts detach invocations so the test can verify that
 * the disposer unwinds every registered bridge even when other listeners fail.
 */
class InstrumentedBlackboard extends BlackboardStore {
  public detachInvocations = 0;

  override watch(options: BlackboardWatchOptions): () => void {
    const detach = super.watch(options);
    return () => {
      this.detachInvocations += 1;
      detach();
    };
  }
}

/**
 * Stigmergy field whose disposer raises an error to assert that
 * `createOrchestratorEventBus` still continues unwinding the remaining
 * listeners and logs the failure.
 */
class ThrowingStigmergyField extends StigmergyField {
  override onChange(listener: StigmergyChangeListener): () => void {
    const detach = super.onChange(listener);
    return () => {
      detach();
      throw new Error("synthetic watcher failure");
    };
  }
}

describe("orchestrator event bus", () => {
  it("publishes coordination events and detaches observers when disposed", () => {
    // The synthetic stores capture that events emitted prior to disposal are
    // persisted while later emissions are ignored once the teardown is run.
    const logger = new StructuredLogger({ onEntry: () => undefined });
    const blackboard = new BlackboardStore({ now: () => 1 });
    const stigmergy = new StigmergyField({ now: () => 1 });
    const contractNet = new ContractNetCoordinator({ now: () => 1 });
    const valueGraph = new ValueGraph({ now: () => 1 });
    const telemetry = new ContractNetWatcherTelemetryRecorder(() => 1);

    const { bus, dispose } = createOrchestratorEventBus({
      logger,
      blackboard,
      stigmergy,
      contractNet,
      valueGraph,
      contractNetWatcherTelemetry: telemetry,
    });

    blackboard.set("alpha", { value: 1 });
    const before = bus.list({ cats: ["bb"] });
    assert.equal(before.length, 1);

    dispose();
    dispose();

    blackboard.set("beta", { value: 2 });
    const after = bus.list({ cats: ["bb"] });
    assert.equal(after.length, 1);
  });

  it("logs disposal failures and continues unwinding every bridge", () => {
    // The throwing stigmergy field simulates a teardown failure to ensure the
    // disposer still flushes the other bridges and records a warning.
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const blackboard = new InstrumentedBlackboard({ now: () => 1 });
    const stigmergy = new ThrowingStigmergyField({ now: () => 1 });
    const contractNet = new ContractNetCoordinator({ now: () => 1 });
    const valueGraph = new ValueGraph({ now: () => 1 });
    const telemetry = new ContractNetWatcherTelemetryRecorder(() => 1);

    const { dispose } = createOrchestratorEventBus({
      logger,
      blackboard,
      stigmergy,
      contractNet,
      valueGraph,
      contractNetWatcherTelemetry: telemetry,
    });

    dispose();

    const warning = entries.find((entry) => entry.message === "event_bus_dispose_error");
    assert.ok(warning, "expected disposal warning to be logged");
    assert.equal(blackboard.detachInvocations, 1);
  });
});
