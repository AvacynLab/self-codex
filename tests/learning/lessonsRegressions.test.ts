import { describe, it } from "mocha";
import { expect } from "chai";

import {
  LessonsStore,
  type LessonSignal,
  type LessonRegressionSignal,
} from "../../src/learning/lessons.js";

/**
 * Helper creating a deterministic lesson signal used across the regression
 * tests. Keeping the builder centralised makes it easy to tweak the default
 * importance/confidence when the scoring heuristics evolve.
 */
function buildSignal(overrides: Partial<LessonSignal> = {}): LessonSignal {
  return {
    topic: "testing.coverage",
    summary: "Add regression tests for uncovered branches",
    tags: ["testing", "coverage"],
    importance: 0.8,
    confidence: 0.9,
    ...overrides,
  };
}

describe("LessonsStore regression handling", () => {
  it("penalises harmful lessons while tracking regression metadata", () => {
    const store = new LessonsStore({ retentionScoreThreshold: 0.1 });
    const { record } = store.record(buildSignal());

    const feedback: LessonRegressionSignal = {
      lessonId: record.id,
      severity: 0.6,
      confidence: 0.8,
      reason: "Validation harness observed slower convergence",
    };

    const result = store.applyRegression(feedback, record.createdAt + 1_000);

    expect(result.status).to.equal("penalised");
    expect(result.record).to.not.be.null;
    expect(result.record?.regressions).to.equal(1);
    expect(result.record?.lastRegressionReason).to.contain("slower convergence");
    expect(result.record?.score).to.be.lessThan(record.score);
    expect(result.appliedSeverity).to.be.closeTo(0.6, 1e-9);
    expect(result.appliedPenalty).to.be.greaterThan(0.14);
    expect(result.appliedPenalty).to.be.lessThan(1);
  });

  it("removes lessons when repeated regressions push the score below retention", () => {
    const store = new LessonsStore({ retentionScoreThreshold: 0.2 });
    const { record } = store.record(buildSignal({ importance: 0.7, confidence: 0.75 }));

    let latest = record;
    for (let index = 0; index < 3; index += 1) {
      const outcome = store.applyRegression(
        {
          lessonId: latest.id,
          severity: 0.9,
          confidence: 0.9,
          reason: `Run ${index + 1} failed quality gate`,
        },
        latest.updatedAt + 2_000 * (index + 1),
      );

      if (outcome.status === "removed") {
        expect(outcome.record).to.not.be.null;
        expect(outcome.record?.score ?? 0).to.be.below(0.2);
        expect(store.snapshot()).to.have.lengthOf(0);
        return;
      }

      latest = outcome.record!;
    }

    throw new Error("expected the regression feedback to evict the lesson");
  });
});
