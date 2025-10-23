import { describe, it } from "mocha";
import { expect } from "chai";

import { ResourceRegistry } from "../../src/resources/registry.js";

/** Utility asserting that no enumerable property in the snapshot equals undefined. */
function expectNoUndefined(entry: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(entry)) {
    expect(value, `${prefix}.${key} should not be undefined`).to.not.equal(undefined);
  }
}

describe("resource registry optional fields", () => {
  it("normalises run events without leaking undefined fields", () => {
    const registry = new ResourceRegistry();
    registry.recordRunEvent("run-1", {
      seq: 1,
      ts: 100,
      kind: "STATUS",
      level: "info",
      payload: { ok: true },
    });

    const read = registry.read("sc://runs/run-1/events");
    const event = read.kind === "run_events" ? read.payload.events[0] : undefined;
    expect(event).to.exist;
    expect(event?.component).to.equal("run");
    expect(event?.runId).to.equal("run-1");
    expect(event?.jobId).to.equal(null);
    expect(event?.opId).to.equal(null);
    expect(event?.graphId).to.equal(null);
    expect(event?.payload).to.deep.equal({ ok: true });
    if (event) {
      expectNoUndefined(event as Record<string, unknown>, "runEvent");
    }
  });

  it("stores child logs with explicit nulls instead of undefined placeholders", () => {
    const registry = new ResourceRegistry();
    registry.recordChildLogEntry("child-1", {
      ts: 200,
      stream: "stdout",
      message: "booting",
    });

    const read = registry.read("sc://children/child-1/logs");
    const entry = read.kind === "child_logs" ? read.payload.logs[0] : undefined;
    expect(entry).to.exist;
    expect(entry?.childId).to.equal("child-1");
    expect(entry?.jobId).to.equal(null);
    expect(entry?.raw).to.equal(null);
    expect(entry?.parsed).to.equal(null);
    if (entry) {
      expectNoUndefined(entry as Record<string, unknown>, "childLog");
    }
  });

  it("omits validation metadata when callers do not provide optional fields", () => {
    const registry = new ResourceRegistry();
    const uri = registry.registerValidationArtifact({
      sessionId: "session",
      artifactType: "inputs",
      name: "payload",
      data: { ok: true },
    });

    const read = registry.read(uri);
    expect(read.kind).to.equal("validation_input");
    expect(read.payload.metadata).to.equal(undefined);
  });
});
