import { expect } from "chai";
import { describe, it } from "mocha";

import {
  aggregateCampaignMetrics,
  computeScenarioMetrics,
  computeTranscriptDigest,
  evaluateConstraints,
  evaluateGates,
  type ScenarioEvaluationSummary,
  type ScenarioMetrics,
  type ScenarioStepResult,
} from "../../src/eval/metrics.js";

import type { EvaluationScenario } from "../../src/eval/scenario.js";

/**
 * Metrics helpers drive CI gating decisions, therefore they receive focused
 * tests to guarantee percentile calculations and constraint evaluations remain
 * stable across refactors.
 */
describe("evaluation metrics", () => {
  it("computes latency statistics", () => {
    const steps: ScenarioStepResult[] = [
      createStepResult({ durationMs: 10 }),
      createStepResult({ durationMs: 20 }),
      createStepResult({ durationMs: 30 }),
    ];
    const metrics = computeScenarioMetrics(steps);
    expect(metrics.totalDurationMs).to.equal(60);
    expect(metrics.averageLatencyMs).to.equal(20);
    expect(metrics.p95LatencyMs).to.equal(29);
    expect(metrics.maxLatencyMs).to.equal(30);
  });

  it("validates constraint budgets", () => {
    const scenario: EvaluationScenario = {
      id: "scenario",
      objective: "test",
      tags: [],
      constraints: {
        maxDurationMs: 40,
        maxToolCalls: 1,
        maxTokens: 10,
        requiredTools: ["alpha", "beta"],
      },
      steps: [],
      oracles: [{ type: "regex", pattern: "ok" }],
    };
    const metrics = computeScenarioMetrics([
      createStepResult({ durationMs: 30, tokensConsumed: 6, tool: "alpha" }),
      createStepResult({ durationMs: 15, tokensConsumed: 7, tool: "beta" }),
    ]);
    const violations = evaluateConstraints(scenario, metrics, ["alpha", "beta"]);
    expect(violations).to.deep.equal([
      "durée 45.0ms > budget 40ms",
      "outil x2 > limite 1",
      "tokens 13 > budget 10",
    ]);
  });

  it("aggregates campaign statistics and evaluates gates", () => {
    const summaries: ScenarioEvaluationSummary[] = [
      createSummary({
        scenarioId: "a",
        success: true,
        steps: [createStepResult({ durationMs: 10 })],
        metrics: createMetrics(10),
      }),
      createSummary({
        scenarioId: "b",
        success: false,
        steps: [createStepResult({ durationMs: 50 })],
        metrics: createMetrics(50),
      }),
    ];
    const metrics = aggregateCampaignMetrics(summaries);
    expect(metrics.successRate).to.equal(0.5);
    const gate = evaluateGates(metrics, { minSuccessRate: 0.6, maxLatencyP95Ms: 20 });
    expect(gate.passed).to.equal(false);
    expect(gate.violations).to.have.length(2);
  });

  it("produces transcript digests", () => {
    const digest = computeTranscriptDigest("hello world");
    expect(digest).to.match(/^[a-f0-9]{64}$/);
  });
});

function createStepResult(overrides: {
  durationMs: number;
  tokensConsumed?: number | null;
  tool?: string;
}): ScenarioStepResult {
  return {
    step: { id: overrides.tool ?? "step", tool: overrides.tool ?? "tool" },
    traceId: "trace-1",
    durationMs: overrides.durationMs,
    success: true,
    textOutput: "sample",
    structuredOutput: null,
    tokensConsumed: overrides.tokensConsumed ?? null,
  };
}

function createSummary(options: {
  scenarioId: string;
  success: boolean;
  steps: ScenarioStepResult[];
  metrics: ScenarioMetrics;
}): ScenarioEvaluationSummary {
  return {
    scenarioId: options.scenarioId,
    success: options.success,
    failureReasons: [],
    steps: options.steps,
    oracles: [],
    constraintViolations: [],
    metrics: options.metrics,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    transcript: "",
    transcriptDigest: "0".repeat(64),
  };
}

function createMetrics(duration: number): ScenarioMetrics {
  return {
    totalDurationMs: duration,
    averageLatencyMs: duration,
    p95LatencyMs: duration,
    p99LatencyMs: duration,
    maxLatencyMs: duration,
    totalTokens: null,
    toolCalls: 1,
  };
}
