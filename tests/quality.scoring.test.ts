import { describe, it } from "mocha";
import { expect } from "chai";

import { scoreCode, scorePlan, scoreText } from "../src/quality/scoring.js";

describe("quality/scoring", () => {
  it("rewards well tested, low complexity code", () => {
    const result = scoreCode({ testsPassed: 5, lintErrors: 0, complexity: 6 });

    expect(result.score).to.equal(100);
    expect(result.rubric.tests).to.equal(100);
    expect(result.rubric.lint).to.equal(100);
  });

  it("penalises code with lint errors and high complexity", () => {
    const result = scoreCode({ testsPassed: 0, lintErrors: 8, complexity: 75 });

    expect(result.score).to.equal(0);
    expect(result.rubric.lint).to.be.lessThan(50);
  });

  it("rates textual outputs using factual accuracy and readability", () => {
    const result = scoreText({ factsOK: 0.9, readability: 85, structure: 0.6 });

    expect(result.score).to.be.greaterThan(70);
    expect(result.rubric.facts).to.equal(100);
  });

  it("handles missing fields by applying defaults", () => {
    const result = scoreText({});

    expect(result.score).to.be.greaterThan(0);
    expect(result.rubric.readability).to.be.greaterThan(0);
  });

  it("rejects invalid numeric ranges", () => {
    expect(() => scoreCode({ testsPassed: -1 } as unknown as any)).to.throw();
    expect(() => scorePlan({ coherence: 2 } as unknown as any)).to.throw();
  });

  it("scores plans by balancing coverage and risk", () => {
    const result = scorePlan({ coherence: 0.8, coverage: 0.9, risk: 0.2 });

    expect(result.score).to.be.greaterThan(80);
    expect(result.rubric.mitigation).to.be.greaterThan(60);
  });

  it("drops plan score when risk remains high", () => {
    const result = scorePlan({ coherence: 0.4, coverage: 0.5, risk: 0.95 });

    expect(result.score).to.be.lessThan(40);
    expect(result.rubric.mitigation).to.be.lessThan(10);
  });
});
