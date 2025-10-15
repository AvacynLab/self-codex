/// <reference path="./graph-forge.d.ts" />
import { describe, it } from "mocha";
import { expect } from "chai";
import { loadGraphForge } from "../src/graph/forgeLoader.js";

const { GraphModel, betweennessCentrality } = (await loadGraphForge()) as unknown as {
  GraphModel: new (
    name: string,
    nodes: Array<{ id: string; attributes: Record<string, string | number | boolean> }>,
    edges: Array<{ from: string; to: string; attributes: Record<string, string | number | boolean> }>,
    directives: Map<string, string | number | boolean>,
  ) => any;
  betweennessCentrality: (
    graph: any,
    options?: Record<string, unknown>,
  ) => Array<{ node: string; score: number }>;
};

type RuntimeGraphModel = InstanceType<typeof GraphModel>;

describe("graph-forge betweenness centrality", () => {
  it("computes centrality scores on an undirected path", () => {
    const graph = buildUndirectedPath();

    const scores = betweennessCentrality(graph);

    const byNode = Object.fromEntries(scores.map((entry: { node: string; score: number }) => [entry.node, entry.score]));
    expect(byNode).to.deep.equal({ A: 0, B: 4, C: 4, D: 0 });
  });

  it("supports weighted edges and normalisation", () => {
    const graph = buildWeightedUndirectedPath();

    const scores = betweennessCentrality(graph, { weighted: true, weightAttribute: "cost", normalise: true });

    const byNode = Object.fromEntries(scores.map((entry: { node: string; score: number }) => [entry.node, entry.score]));
    expect(byNode.A).to.equal(0);
    expect(byNode.D).to.equal(0);
    expect(byNode.B).to.be.closeTo(2 / 3, 1e-9);
    expect(byNode.C).to.be.closeTo(2 / 3, 1e-9);
  });
});

function buildUndirectedPath(): RuntimeGraphModel {
  // Simple four node path where B and C act as bridges between the terminals.
  const nodes = ["A", "B", "C", "D"].map((id) => ({ id, attributes: {} }));
  const edges = [
    { from: "A", to: "B", attributes: {} },
    { from: "B", to: "A", attributes: {} },
    { from: "B", to: "C", attributes: {} },
    { from: "C", to: "B", attributes: {} },
    { from: "C", to: "D", attributes: {} },
    { from: "D", to: "C", attributes: {} },
  ];
  return new GraphModel("path", nodes, edges, new Map());
}

function buildWeightedUndirectedPath(): RuntimeGraphModel {
  const nodes = ["A", "B", "C", "D"].map((id) => ({ id, attributes: {} }));
  const edges = [
    { from: "A", to: "B", attributes: { cost: 1 } },
    { from: "B", to: "A", attributes: { cost: 1 } },
    { from: "B", to: "C", attributes: { cost: 2 } },
    { from: "C", to: "B", attributes: { cost: 2 } },
    { from: "C", to: "D", attributes: { cost: 3 } },
    { from: "D", to: "C", attributes: { cost: 3 } },
  ];
  return new GraphModel("weighted-path", nodes, edges, new Map());
}
