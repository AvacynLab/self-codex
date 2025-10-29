import { strict as assert } from "node:assert";

import { EventStore } from "../../src/eventStore.js";

describe("eventStore search payload normalisation", () => {
  it("annotates search payloads with a version tag", () => {
    const store = new EventStore({ maxHistory: 10 });

    const event = store.emit({
      kind: "search:doc_ingested",
      payload: { url: "https://example.com/article" },
    });

    const payload = event.payload as Record<string, unknown> | undefined;
    assert(payload, "payload should be present");
    assert.equal(payload?.version, 1);
    assert.equal(payload?.url, "https://example.com/article");
  });

  it("truncates long search error messages", () => {
    const store = new EventStore({ maxHistory: 5 });
    const veryLong = "x".repeat(1_500);

    const event = store.emit({
      kind: "search:error",
      payload: { stage: "fetch", message: veryLong },
    });

    const payload = event.payload as Record<string, unknown> | undefined;
    assert(payload, "payload should be present");
    const message = payload?.message;
    assert.equal(typeof message, "string");
    assert(message && (message as string).endsWith("…"));
    assert.equal((message as string).length, 1_000);
    assert.equal(payload?.version, 1);
  });
});
