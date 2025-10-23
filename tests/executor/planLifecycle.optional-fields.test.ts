import { describe, it } from "mocha";
import { expect } from "chai";

import { PlanLifecycleError, PlanLifecycleRegistry } from "../../src/executor/planLifecycle.js";

/**
 * Regression coverage guaranteeing lifecycle snapshots omit undefined payload
 * properties once lifecycle events are recorded. The sanitisation keeps nested
 * metadata intact while ensuring strict optional typing can be enabled.
 */
describe("PlanLifecycleRegistry optional fields", () => {
  it("removes undefined keys from recorded lifecycle payloads", () => {
    let now = 1;
    const registry = new PlanLifecycleRegistry({ clock: () => now });
    registry.registerRun({ runId: "run", opId: "op", mode: "bt" });

    const payload: Record<string, unknown> = {
      phase: "node",
      status: "running",
      optional_status: undefined,
      nested: { keep: "value", drop: undefined },
      history: [
        { seq: 1, status: "running", optional: undefined },
        undefined,
        { seq: 2, status: "success" },
      ],
    };

    now = 5;
    const snapshot = registry.recordEvent("run", { phase: "node", payload });

    expect(snapshot.last_event?.payload).to.deep.equal({
      phase: "node",
      status: "running",
      nested: { keep: "value" },
      history: [
        { seq: 1, status: "running" },
        undefined,
        { seq: 2, status: "success" },
      ],
    });

    // Original payload remains untouched so upstream publishers can reuse it.
    expect(Object.prototype.hasOwnProperty.call(payload, "optional_status")).to.equal(true);
    expect((payload.nested as { drop?: unknown }).drop).to.equal(undefined);
    expect((payload.history as Array<Record<string, unknown> | undefined>)[0]?.optional).to.equal(undefined);
  });

  it("retains lifecycle error metadata without forcing undefined placeholders", () => {
    const withoutHint = new PlanLifecycleError("boom", "E-PLAN", undefined, { context: "failure" });
    expect(Object.prototype.hasOwnProperty.call(withoutHint, "hint"), "error should expose the optional hint field").to.equal(true);
    expect(withoutHint.hint, "hint remains undefined when callers skip it").to.equal(undefined);
    expect(withoutHint.details, "structured details remain attached").to.deep.equal({ context: "failure" });

    const withHint = new PlanLifecycleError("boom", "E-PLAN", "plan_status");
    expect(withHint.hint, "provided hints surface unchanged").to.equal("plan_status");
  });
});
