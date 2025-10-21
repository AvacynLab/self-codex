import { strict as assert } from "node:assert";

import { eventBus, eventStore, __eventRuntimeInternals } from "../../src/orchestrator/runtime.js";

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
});
