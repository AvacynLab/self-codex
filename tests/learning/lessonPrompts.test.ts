import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { LessonsStore } from "../../src/learning/lessons.js";
import {
  recallLessons,
  resolveLessonRecallLimit,
  seedLessons,
} from "../../src/learning/lessonPrompts.js";

describe("lesson prompt configuration", () => {
  const originalLessonsMax = process.env.LESSONS_MAX;

  afterEach(() => {
    if (originalLessonsMax === undefined) {
      delete process.env.LESSONS_MAX;
    } else {
      process.env.LESSONS_MAX = originalLessonsMax;
    }
  });

  it("defaults to three recalled lessons when the environment is unset", () => {
    delete process.env.LESSONS_MAX;
    expect(resolveLessonRecallLimit()).to.equal(3);
  });

  it("limits the recalled lessons according to LESSONS_MAX", () => {
    process.env.LESSONS_MAX = "2";
    const store = new LessonsStore();
    seedLessons(
      store,
      Array.from({ length: 4 }, (_, index) => ({
        topic: `limit.${index}`,
        summary: `Lesson ${index}`,
        tags: ["prompt-safety"],
        importance: 0.8,
        confidence: 0.9,
      })),
    );

    const recall = recallLessons(store, { additionalTags: ["prompt-safety"] });

    expect(recall.matches).to.have.lengthOf(2);
    expect(recall.tags).to.deep.equal(["prompt-safety"]);
  });

  it("ignores invalid LESSONS_MAX values and falls back to the default", () => {
    process.env.LESSONS_MAX = "-4";
    expect(resolveLessonRecallLimit()).to.equal(3);
  });
});
