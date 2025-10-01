import { describe, it } from "mocha";
import { expect } from "chai";

import { applyAdaptiveRewrites, type AdaptiveEvaluationResult } from "../src/graph/adaptive.js";
import type { HierGraph } from "../src/graph/hierarchy.js";
import type { NormalisedGraph } from "../src/graph/types.js";

/**
 * Integration tests ensuring the adaptive evaluation can drive the rewrite
 * pipeline and that the generated structures remain coherent.
 */
describe("graph adaptive - rewrite integration", () => {
  it("derives rewrite decisions from reinforcement insights", () => {
    const embedded: HierGraph = {
      id: "embedded", 
      nodes: [
        { id: "entry", kind: "task", label: "Sub Entry" },
        { id: "exit", kind: "task", label: "Sub Exit" },
      ],
      edges: [
        { id: "inner", from: { nodeId: "entry" }, to: { nodeId: "exit" } },
      ],
    };

    const graph: NormalisedGraph = {
      name: "adaptive", 
      graphId: "adaptive", 
      graphVersion: 1,
      nodes: [
        { id: "start", label: "Start", attributes: { kind: "task" } },
        { id: "sub", label: "Sub", attributes: { kind: "subgraph", ref: "embedded" } },
        { id: "beta", label: "Beta", attributes: { kind: "task" } },
        { id: "blocker", label: "Blocker", attributes: { kind: "task" } },
        { id: "sink", label: "Sink", attributes: { kind: "task" } },
      ],
      edges: [
        { from: "start", to: "sub", label: "fanout", attributes: { parallel: true } },
        { from: "sub", to: "beta", label: "advance", attributes: {} },
        { from: "beta", to: "blocker", label: "risky", attributes: {} },
        { from: "blocker", to: "sink", label: "final", attributes: {} },
      ],
      metadata: {
        "hierarchy:subgraphs": JSON.stringify({
          embedded: { graph: embedded, entryPoints: ["entry"], exitPoints: ["exit"] },
        }),
      },
    };

    const evaluation: AdaptiveEvaluationResult = {
      insights: [],
      edgesToBoost: ["start→sub"],
      edgesToPrune: ["beta→blocker"],
    };

    const { graph: rewritten, history } = applyAdaptiveRewrites(graph, evaluation);

    const newNodeIds = new Set(rewritten.nodes.map((node) => node.id));
    expect(newNodeIds.has("start∥sub")).to.equal(true);
    expect(newNodeIds.has("sub/entry")).to.equal(true);
    expect(newNodeIds.has("blocker")).to.equal(false);
    const newEdges = new Set(rewritten.edges.map((edge) => `${edge.from}->${edge.to}`));
    expect(newEdges.has("start->start∥sub")).to.equal(true);
    expect(newEdges.has("start∥sub->sub/entry")).to.equal(true);
    expect(newEdges.has("beta->sink")).to.equal(true);

    const splitHistory = history.find((entry) => entry.rule === "split-parallel");
    const inlineHistory = history.find((entry) => entry.rule === "inline-subgraph");
    const rerouteHistory = history.find((entry) => entry.rule === "reroute-avoid");
    expect(splitHistory?.applied).to.be.greaterThan(0);
    expect(inlineHistory?.applied).to.be.greaterThan(0);
    expect(rerouteHistory?.applied).to.be.greaterThan(0);
  });
});
