import { describe, it } from "mocha";
import { expect } from "chai";

import { LessonsStore } from "../../src/learning/lessons.js";

describe("learning lessons optional fields", () => {
  it("omits undefined evidence when recording and matching lessons", () => {
    const store = new LessonsStore();

    const result = store.record(
      {
        topic: "testing.campaign",
        summary: "Ajouter des tests ciblés",
        tags: ["qa", "coverage"],
        importance: 0.6,
        confidence: 0.4,
      },
      10,
    );

    expect(Object.prototype.hasOwnProperty.call(result.record, "evidence")).to.equal(false);

    const matches = store.match({ tags: ["QA"] }, 15);
    expect(matches).to.have.length(1);
    expect(Object.prototype.hasOwnProperty.call(matches[0], "evidence")).to.equal(false);
  });

  it("preserves evidence when explicitly provided", () => {
    const store = new LessonsStore();

    store.record(
      {
        topic: "review.feedback",
        summary: "Documenter les retours",
        tags: ["process"],
        importance: 0.7,
        confidence: 0.6,
        evidence: "Analyse de la rétro semaine 42",
      },
      20,
    );

    const snapshot = store.snapshot();
    expect(snapshot).to.have.length(1);
    expect(snapshot[0].evidence).to.equal("Analyse de la rétro semaine 42");
  });
});
