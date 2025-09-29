/// <reference path="./graph-forge.d.ts" />
import { describe, it } from "mocha";
import { expect } from "chai";

const graphForgeModuleUrl = new URL("../graph-forge/dist/index.js", import.meta.url);
const { GraphModel, kShortestPaths } = (await import(graphForgeModuleUrl.href)) as {
  GraphModel: new (
    name: string,
    nodes: Array<{ id: string; attributes: Record<string, string | number | boolean> }>,
    edges: Array<{ from: string; to: string; attributes: Record<string, string | number | boolean> }>,
    directives: Map<string, string | number | boolean>,
  ) => any;
  kShortestPaths: (
    graph: any,
    start: string,
    goal: string,
    k: number,
    options?: Record<string, unknown>,
  ) => Array<{ path: string[]; distance: number }>;
};

type RuntimeGraphModel = InstanceType<typeof GraphModel>;

describe("graph-forge k-shortest paths", () => {
  it("computes unique simple paths ordered by total weight", () => {
    const graph = buildSampleGraph();

    const results = kShortestPaths(graph, "A", "D", 4);

    expect(results.map((entry: { path: string[] }) => entry.path)).to.deep.equal([
      ["A", "B", "D"],
      ["A", "C", "D"],
      ["A", "B", "C", "D"],
      ["A", "C", "B", "D"],
    ]);
    expect(results.map((entry: { distance: number }) => entry.distance)).to.deep.equal([2, 2, 3, 4]);
  });

  it("honours the maxDeviation filter", () => {
    const graph = buildSampleGraph();

    const results = kShortestPaths(graph, "A", "D", 4, { maxDeviation: 0.5 });

    expect(results.map((entry: { path: string[] }) => entry.path)).to.deep.equal([
      ["A", "B", "D"],
      ["A", "C", "D"],
    ]);
  });
});

function buildSampleGraph(): RuntimeGraphModel {
  // Directed square with cross edges so Yen's algorithm must explore
  // alternative detours. Weights are chosen to produce deterministic ordering.
  return new GraphModel(
    "sample",
    [
      { id: "A", attributes: {} },
      { id: "B", attributes: {} },
      { id: "C", attributes: {} },
      { id: "D", attributes: {} },
    ],
    [
      { from: "A", to: "B", attributes: { weight: 1 } },
      { from: "A", to: "C", attributes: { weight: 1 } },
      { from: "B", to: "D", attributes: { weight: 1 } },
      { from: "C", to: "D", attributes: { weight: 1 } },
      { from: "B", to: "C", attributes: { weight: 1 } },
      { from: "C", to: "B", attributes: { weight: 2 } },
    ],
    new Map(),
  );
}
