import { strict as assert } from "node:assert";

import { eventBus, eventStore, __eventRuntimeInternals } from "../../src/orchestrator/runtime.js";
import { EventStore } from "../../src/eventStore.js";

/**
 * Regression tests guarding the behaviour of the `pushEvent` helper when
 * optional identifiers are null or omitted. The assertions guarantee the
 * internal event store never records `undefined` payloads while the public
 * event bus continues to surface explicit `null` hints.
 */
describe("orchestrator pushEvent optional identifiers", () => {
  it("omits null identifiers from the event store while publishing null hints", () => {
    const snapshot = eventStore.getSnapshot();
    const previousSeq = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.seq : 0;
    const previousBusSeq = eventBus.list({ limit: 1 })[0]?.seq ?? 0;

    const payload = { run_id: "run-null-case", message: "optional-fields-null" } as const;
    const emitted = __eventRuntimeInternals.pushEvent({
      kind: "INFO",
      jobId: null,
      childId: null,
      payload,
    });

    assert.ok(emitted.seq > previousSeq, "a fresh event should be emitted");
    assert.strictEqual(emitted.jobId, undefined);
    assert.strictEqual(emitted.childId, undefined);

    const latest = eventStore.getSnapshot().at(-1);
    assert.ok(latest, "event store should retain the emitted event");
    assert.strictEqual(latest!.seq, emitted.seq);
    assert.strictEqual(latest!.jobId, undefined);
    assert.strictEqual(latest!.childId, undefined);

    const busLatest = eventBus.list({ limit: 1 })[0];
    assert.ok(busLatest, "event bus should expose the emitted event");
    assert.ok(busLatest!.seq > previousBusSeq, "bus event must be newer than the baseline");
    assert.strictEqual(busLatest!.jobId, null);
    assert.strictEqual(busLatest!.childId, null);
    assert.strictEqual(busLatest!.runId, "run-null-case");
    assert.strictEqual(busLatest!.data, payload);
  });

  it("omits absent job identifiers entirely", () => {
    const snapshot = eventStore.getSnapshot();
    const previousSeq = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.seq : 0;

    const payload = { message: "optional-fields-omitted" } as const;
    const emitted = __eventRuntimeInternals.pushEvent({
      kind: "INFO",
      payload,
    });

    assert.ok(emitted.seq > previousSeq, "a fresh event should be emitted");
    assert.strictEqual(emitted.jobId, undefined);

    const latest = eventStore.getSnapshot().at(-1);
    assert.ok(latest, "event store should retain the emitted event");
    assert.strictEqual(latest!.jobId, undefined);

    const busLatest = eventBus.list({ limit: 1 })[0];
    assert.ok(busLatest, "event bus should expose the emitted event");
    assert.strictEqual(busLatest!.data, payload);
    assert.strictEqual(busLatest!.jobId, null);
  });

  it("derives default component and stage tags without leaking undefined values", () => {
    const payload = { run_id: "run-component-default" } as const;
    const emitted = __eventRuntimeInternals.pushEvent({
      kind: "INFO",
      payload,
      component: undefined,
      stage: undefined,
    });

    assert.ok(emitted.seq > 0, "event store should emit a new sequence");

    const busLatest = eventBus.list({ limit: 1 })[0];
    assert.ok(busLatest, "event bus should expose the emitted event");
    assert.strictEqual(busLatest!.component, "graph");
    assert.strictEqual(busLatest!.stage, "info");
    assert.strictEqual(busLatest!.elapsedMs, null);
    assert.strictEqual(busLatest!.data, payload);
  });

  it("coerces null identifiers to undefined when emitting events directly", () => {
    const localStore = new EventStore({ maxHistory: 5 });
    const direct = localStore.emit({
      kind: "INFO",
      // The EventStore API historically accepted `null` placeholders when callers
      // bypassed the higher-level `pushEvent` helper. The sanitisation guarantees
      // the resulting snapshot omits those optional identifiers entirely.
      jobId: null as unknown as string,
      childId: null as unknown as string,
    });

    assert.strictEqual(direct.jobId, undefined, "job identifiers should not surface as null");
    assert.strictEqual(direct.childId, undefined, "child identifiers should not surface as null");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(direct, "jobId"),
      false,
      "jobId key should be omitted from the snapshot",
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(direct, "childId"),
      false,
      "childId key should be omitted from the snapshot",
    );

    const stored = localStore.getSnapshot().at(-1);
    assert.ok(stored, "event store should retain the emitted event");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored!, "jobId"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored!, "childId"), false);
  });
});
