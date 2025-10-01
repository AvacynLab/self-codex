import { expect } from "chai";

import { LoopDetector } from "../src/guard/loopDetector.js";

describe("LoopDetector", () => {
  it("detects alternating loops and escalates to kill after repeated flips", () => {
    const detector = new LoopDetector({
      loopWindowMs: 2_000,
      maxAlternations: 3,
      warnAtAlternations: 2,
    });
    const base = Date.now();

    const record = (from: string, to: string, offset: number) =>
      detector.recordInteraction({
        from,
        to,
        signature: "analysis::ping",
        childId: "child-42",
        taskId: "task-alpha",
        taskType: "analysis",
        timestamp: base + offset,
      });

    expect(record("child-42", "orchestrator", 0)).to.equal(null);
    expect(record("orchestrator", "child-42", 200)).to.equal(null);

    const warning = record("child-42", "orchestrator", 400);
    expect(warning).to.not.equal(null);
    expect(warning!.recommendation).to.equal("warn");
    expect(warning!.occurrences).to.equal(2);
    expect(warning!.participants).to.include.members(["child-42", "orchestrator"]);

    const kill = record("orchestrator", "child-42", 600);
    expect(kill).to.not.equal(null);
    expect(kill!.recommendation).to.equal("kill");
    expect(kill!.occurrences).to.equal(3);
    expect(kill!.childIds).to.deep.equal(["child-42"]);
  });

  it("resets loop counters when exchanges fall outside the detection window", () => {
    const detector = new LoopDetector({
      loopWindowMs: 100,
      maxAlternations: 3,
      warnAtAlternations: 5,
    });
    const base = Date.now();

    const record = (from: string, to: string, offset: number) =>
      detector.recordInteraction({
        from,
        to,
        signature: "noop",
        timestamp: base + offset,
      });

    expect(record("child", "orchestrator", 0)).to.equal(null);
    expect(record("orchestrator", "child", 50)).to.equal(null);
    expect(record("child", "orchestrator", 500)).to.equal(null);
    expect(record("orchestrator", "child", 650)).to.equal(null);
  });

  it("combines telemetry with task profiles to compute bounded timeouts", () => {
    const detector = new LoopDetector({
      defaultTimeoutMs: 90_000,
      taskTimeouts: {
        analysis: { baseMs: 60_000, minMs: 45_000, maxMs: 110_000, complexityMultiplier: 2 },
      },
    });

    const durations = [20_000, 60_000, 80_000, 90_000, 100_000];
    for (const duration of durations) {
      detector.recordTaskObservation({ taskType: "analysis", durationMs: duration, success: true });
    }

    const timeout = detector.recommendTimeout("analysis", 1.5);
    expect(timeout).to.equal(110_000);
  });

  it("caps timeout growth when recent failures dominate", () => {
    const detector = new LoopDetector({
      defaultTimeoutMs: 70_000,
      taskTimeouts: {
        planning: { baseMs: 80_000, minMs: 40_000, maxMs: 200_000, complexityMultiplier: 2 },
      },
    });

    detector.recordTaskObservation({ taskType: "planning", durationMs: 120_000, success: true });
    for (let index = 0; index < 4; index += 1) {
      detector.recordTaskObservation({ taskType: "planning", durationMs: 120_000, success: false });
    }

    const timeout = detector.recommendTimeout("planning", 1);
    expect(timeout).to.be.at.most(Math.round(80_000 * 1.2));
    expect(timeout).to.be.at.least(40_000);
  });
});
