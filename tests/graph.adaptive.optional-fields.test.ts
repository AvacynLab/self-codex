import { strict as assert } from "node:assert";

import {
  applyAdaptiveRewrites,
  createAdaptiveGraphState,
  evaluateAdaptiveGraph,
  recordPathOutcome,
  type AdaptiveEvaluationResult,
} from "../src/graph/adaptive.js";
import type { NormalisedGraph } from "../src/graph/types.js";

/**
 * Regressions covering the adaptive graph helpers to ensure undefined optional
 * fields never leak into runtime structures once `exactOptionalPropertyTypes`
 * is enforced. These tests specifically mimic sparse option objects produced
 * by JSON payloads that surface keys with explicit `undefined` values.
 */
describe("adaptive graph optional fields", () => {
  function buildLinearGraph(): NormalisedGraph {
    return {
      name: "adaptive-linear",
      graphId: "adaptive-linear", // Stable identifier for deterministic comparisons.
      graphVersion: 1,
      nodes: [
        { id: "start", attributes: {} },
        { id: "middle", attributes: {} },
        { id: "end", attributes: {} },
      ],
      edges: [
        { from: "start", to: "middle", attributes: {} },
        { from: "middle", to: "end", attributes: {} },
      ],
      metadata: {},
    } satisfies NormalisedGraph;
  }

  it("retains default evaluation weights when overrides contain undefined", () => {
    const graph = buildLinearGraph();
    const state = createAdaptiveGraphState();

    // Inject telemetry for a successful run so the evaluation produces a
    // reinforcement score strictly above zero when defaults remain intact.
    recordPathOutcome(state, {
      path: ["start", "middle", "end"],
      success: true,
      durationMs: 1_500,
      timestamp: 5_000,
    });

    const evaluation = evaluateAdaptiveGraph(graph, state, {
      // Explicit undefined mirrors JSON payloads that include sparse keys.
      targetDurationMs: undefined,
      successWeight: undefined,
      durationWeight: undefined,
      rewardWeight: undefined,
      minSamplesForConfidence: undefined,
      decayMs: undefined,
      boostThreshold: undefined,
      pruneThreshold: undefined,
      now: 10_000,
    });

    const insight = evaluation.insights.find((entry) => entry.edgeKey === "start→middle");
    assert.ok(insight, "the evaluation should surface insights for traversed edges");
    assert.ok(
      insight.reinforcement > 0.2,
      `reinforcement should remain positive when defaults are preserved, received ${insight.reinforcement}`,
    );
  });

  it("only forwards avoidance hints when prune recommendations exist", () => {
    const graph: NormalisedGraph = {
      name: "adaptive-branching",
      graphId: "adaptive-branching",
      graphVersion: 1,
      nodes: [
        { id: "alpha", attributes: {} },
        { id: "beta", attributes: {} },
        { id: "gamma", attributes: {} },
        { id: "delta", attributes: {} },
      ],
      edges: [
        { from: "alpha", to: "beta", attributes: { mode: "parallel" } },
        { from: "alpha", to: "gamma", attributes: {} },
        { from: "beta", to: "delta", attributes: {} },
        { from: "gamma", to: "delta", attributes: {} },
      ],
      metadata: {},
    };

    const evaluation: AdaptiveEvaluationResult = {
      insights: [
        {
          edgeKey: "alpha→beta",
          reinforcement: 0,
          confidence: 1,
          recommendation: "prune",
          metrics: {
            successes: 0,
            failures: 1,
            totalDurationMs: 1,
            totalReward: 0,
            lastUpdatedAt: 0,
            attempts: 1,
            successRate: 0,
            averageDurationMs: 1,
          },
        },
      ],
      edgesToPrune: ["alpha→beta"],
      edgesToBoost: [],
    };

    const result = applyAdaptiveRewrites(graph, evaluation, {
      stopOnNoChange: undefined,
      additionalRules: undefined,
      avoidLabels: undefined,
    });

    assert.ok(result.history.length >= 1, "the rewrite pipeline should execute at least one rule");
    const rewritten = result.graph.edges.some((edge) => edge.from === "alpha" && edge.to === "gamma");
    assert.ok(rewritten, "the adaptive rewrite should retain the safe alternative path");
  });
});

