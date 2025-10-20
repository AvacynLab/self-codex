import { strict as assert } from "node:assert";

import {
  deriveEventCategory,
  deriveEventMessage,
  extractChildId,
  extractElapsedMilliseconds,
  extractGraphId,
  extractJobId,
  extractNodeId,
  extractOpId,
  extractRunId,
  normaliseTag,
  parseEventCategories,
  resolveEventComponent,
  resolveEventElapsedMs,
  resolveEventStage,
} from "../../src/orchestrator/logging.js";

describe("orchestrator logging helpers", () => {
  it("extracts correlation identifiers from payloads", () => {
    const payload = {
      run_id: "run-123",
      op_id: "op-456",
      graph_id: "graph-789",
      node_id: "node-abc",
      child_id: "child-def",
      job_id: "job-ghi",
    };

    assert.equal(extractRunId(payload), "run-123");
    assert.equal(extractOpId(payload), "op-456");
    assert.equal(extractGraphId(payload), "graph-789");
    assert.equal(extractNodeId(payload), "node-abc");
    assert.equal(extractChildId(payload), "child-def");
    assert.equal(extractJobId(payload), "job-ghi");
  });

  it("normalises optional tags and elapsed metrics", () => {
    assert.equal(normaliseTag("  stage-one  "), "stage-one");
    assert.equal(normaliseTag(""), null);

    assert.equal(resolveEventComponent("graph", undefined, " child " ), "child");
    assert.equal(resolveEventStage("INFO", "", undefined, "  queued  "), "queued");
    assert.equal(resolveEventElapsedMs(undefined, 42), 42);
    assert.equal(resolveEventElapsedMs(null, undefined), null);

    const elapsedPayload = { elapsed_ms: "85" };
    assert.equal(extractElapsedMilliseconds(elapsedPayload), 85);
  });

  it("derives event categories and messages", () => {
    assert.equal(deriveEventCategory("PROMPT"), "child");
    assert.equal(deriveEventCategory("UNKNOWN_KIND"), "graph");

    // The helper only accepts catalogue-backed messages: forward one from the
    // event-store family to prove it bypasses the fallback semantics.
    const withMessage = deriveEventMessage("PROMPT", { msg: "prompt" });
    assert.equal(withMessage, "prompt");

    const fallback = deriveEventMessage("ERROR", {});
    assert.equal(fallback, "error");
  });

  it("filters event categories from textual inputs", () => {
    const parsed = parseEventCategories(["graph", "invalid", " CHILD ", "child"]);
    assert.deepEqual(parsed, ["graph", "child"]);
    assert.equal(parseEventCategories([]), undefined);
  });
});

