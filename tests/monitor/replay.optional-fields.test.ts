/**
 * Optional-field regressions for the replay endpoint helpers. The tests ensure
 * timeline events mapped for clients never expose `undefined` placeholders so
 * the payload stays compatible with strict optional property typing.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { EventStore } from "../../src/eventStore.js";
import { buildReplayPage } from "../../src/monitor/replay.js";

describe("monitor/replay optional fields", () => {
  it("omits undefined metadata when events lack optional payload", () => {
    const store = new EventStore({ maxHistory: 32 });

    store.emit({ kind: "PROMPT", jobId: "job-001" });

    const page = buildReplayPage(store, "job-001", { limit: 5 });
    expect(page.events).to.have.length(1);
    expect(page.events[0]!.jobId).to.equal("job-001");
    expect(page.events[0]!.childId).to.equal(null);
    expect(page.events[0]!.payload).to.equal(null);
    expect(page.events[0]!.provenance).to.deep.equal([]);
    expect(page.events[0]!.lessonsPrompt).to.equal(null);
  });

  it("extracts lessons prompt descriptors while omitting unused fields", () => {
    const store = new EventStore({ maxHistory: 32 });
    const lessonsPayload = {
      operation: "child_create",
      lessons_prompt: {
        source: "child_create",
        topics: [],
        tags: [],
        total_lessons: 0,
        before: [],
        after: [],
        diff: { added: [], removed: [] },
      },
    } as const;

    store.emit({ kind: "PROMPT", jobId: "job-lesson", payload: lessonsPayload });

    const page = buildReplayPage(store, "job-lesson", { limit: 5 });
    expect(page.events).to.have.length(1);
    expect(page.events[0]!.lessonsPrompt).to.deep.equal({
      operation: "child_create",
      payload: lessonsPayload.lessons_prompt,
    });
    expect(page.events[0]!.payload).to.deep.equal(lessonsPayload);
  });
});
