import { describe, it } from "mocha";
import { expect } from "chai";

import {
  AdaptiveGraphState,
  createAdaptiveGraphState,
  deriveWeightMultipliers,
  evaluateAdaptiveGraph,
  pruneWeakBranches,
  recordPathOutcome,
} from "../src/graph/adaptive.js";
import { NormalisedGraph } from "../src/graph/types.js";

function buildGraph(): NormalisedGraph {
  return {
    name: "demo",
    graphId: "g1",
    graphVersion: 1,
    metadata: {},
    nodes: [
      { id: "start", attributes: {} },
      { id: "mid", attributes: {} },
      { id: "alt", attributes: {} },
      { id: "end", attributes: {} },
    ],
    edges: [
      { from: "start", to: "mid", attributes: {}, weight: 1 },
      { from: "mid", to: "end", attributes: {}, weight: 1 },
      { from: "start", to: "alt", attributes: {}, weight: 1 },
      { from: "alt", to: "end", attributes: {}, weight: 1 },
    ],
  };
}

describe("graph adaptive heuristics", () => {
  it("computes reinforcement scores and prunes weak branches", () => {
    const graph = buildGraph();
    const state: AdaptiveGraphState = createAdaptiveGraphState();

    recordPathOutcome(state, {
      path: ["start", "mid", "end"],
      success: true,
      durationMs: 1_200,
      reward: 0.9,
      timestamp: 10_000,
    });
    recordPathOutcome(state, {
      path: ["start", "mid", "end"],
      success: true,
      durationMs: 900,
      reward: 1,
      timestamp: 12_000,
    });
    recordPathOutcome(state, {
      path: ["start", "alt", "end"],
      success: false,
      durationMs: 2_600,
      reward: 0.2,
      timestamp: 13_000,
    });

    const evaluation = evaluateAdaptiveGraph(graph, state, {
      targetDurationMs: 1_500,
      now: 15_000,
      pruneThreshold: 0.3,
      boostThreshold: 0.6,
      minSamplesForConfidence: 2,
    });

    const boostKeys = evaluation.edgesToBoost;
    const pruneKeys = evaluation.edgesToPrune;

    expect(boostKeys).to.deep.equal(["mid→end", "start→mid"]);
    expect(pruneKeys).to.deep.equal(["alt→end", "start→alt"]);

    const multipliers = deriveWeightMultipliers(evaluation, {
      boostMultiplier: 1.4,
      pruneMultiplier: 0.4,
    });
    expect(multipliers.get("start→mid")).to.equal(1.4);
    expect(multipliers.get("alt→end")).to.equal(0.4);

    const pruned = pruneWeakBranches(graph, evaluation);
    expect(pruned.edges).to.have.length(2);
    expect(pruned.graphVersion).to.equal(graph.graphVersion + 1);
  });

  it("keeps edges neutral when no telemetry was recorded", () => {
    const graph = buildGraph();
    const state = createAdaptiveGraphState();

    const evaluation = evaluateAdaptiveGraph(graph, state, { now: 1 });
    expect(evaluation.edgesToPrune).to.be.empty;
    expect(evaluation.insights.every((insight) => insight.recommendation === "keep")).to.equal(true);
  });
});
