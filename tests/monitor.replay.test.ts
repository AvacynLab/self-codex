import { describe, it } from "mocha";
import { expect } from "chai";

import { EventStore } from "../src/eventStore.js";
import { StructuredLogger } from "../src/logger.js";
import {
  buildLessonsPromptPayload,
  normalisePromptBlueprint,
  normalisePromptMessages,
} from "../src/learning/lessonPromptDiff.js";
import { buildReplayPage } from "../src/monitor/replay.js";

describe("monitor replay helpers", () => {
  it("builds lessons prompt payloads with accurate diffs", () => {
    const before = normalisePromptBlueprint({ system: "Analyse le ticket" });
    const afterBlueprint = {
      system: [
        "Leçons institutionnelles pertinentes:\n- Ajoute toujours un test.",
        "Analyse le ticket",
      ],
      user: ["Prépare le plan d'action"],
    };
    const after = normalisePromptBlueprint(afterBlueprint);
    const payload = buildLessonsPromptPayload({
      source: "child_create",
      before,
      after,
      topics: ["quality", "tests"],
      tags: ["plan", "quality"],
      totalLessons: 1,
    });

    expect(payload.before).to.deep.equal(before);
    expect(payload.after).to.deep.equal(after);
    expect(payload.diff.added).to.have.length(2);
    const addedContents = payload.diff.added.map((entry) => entry.content);
    expect(addedContents.some((content) => content.includes("Leçons institutionnelles"))).to.equal(true);
    expect(addedContents).to.include("Prépare le plan d'action");
    expect(payload.diff.removed).to.be.empty;
    expect(payload.topics).to.deep.equal(["quality", "tests"]);
    expect(payload.tags).to.deep.equal(["plan", "quality"]);
    expect(payload.total_lessons).to.equal(1);
  });

  it("builds replay pages with lessons prompt metadata and pagination", () => {
    const store = new EventStore({ maxHistory: 20, logger: new StructuredLogger() });
    const lessonsBefore = normalisePromptBlueprint({ system: "Audit" });
    const lessonsAfterMessages = normalisePromptMessages([
      { role: "system", content: "Leçons: Suis les checklists." },
      { role: "system", content: "Audit" },
    ]);
    const lessonsPayload = buildLessonsPromptPayload({
      source: "plan_fanout",
      before: lessonsBefore,
      after: lessonsAfterMessages,
      topics: ["audit"],
      tags: ["plan"],
      totalLessons: 1,
    });

    store.emit({
      kind: "INFO",
      source: "orchestrator",
      level: "info",
      jobId: "job-replay",
      payload: { note: "start" },
    });
    store.emit({
      kind: "PROMPT",
      source: "orchestrator",
      level: "info",
      jobId: "job-replay",
      childId: "child-42",
      payload: {
        operation: "plan_fanout",
        lessons_prompt: lessonsPayload,
      },
    });
    store.emit({
      kind: "REPLY",
      source: "child",
      level: "info",
      jobId: "job-replay",
      childId: "child-42",
      payload: { text: "done" },
    });

    const firstPage = buildReplayPage(store, "job-replay", { limit: 2 });
    expect(firstPage.events).to.have.length(2);
    expect(firstPage.nextCursor).to.be.a("number");
    const promptEvent = firstPage.events.find((event) => event.kind === "PROMPT");
    expect(promptEvent?.lessonsPrompt?.operation).to.equal("plan_fanout");
    expect(promptEvent?.lessonsPrompt?.payload.diff.added).to.have.length(1);

    const secondPage = buildReplayPage(store, "job-replay", { cursor: firstPage.nextCursor ?? undefined });
    expect(secondPage.events).to.have.length(1);
    expect(secondPage.events[0]?.kind).to.equal("REPLY");
    expect(secondPage.nextCursor).to.equal(null);

    const emptyPage = buildReplayPage(store, "unknown-job", { limit: 5 });
    expect(emptyPage.events).to.be.empty;
    expect(emptyPage.nextCursor).to.equal(null);
  });
});
