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

  it("handles very large but finite edge weights without overflowing", () => {
    const heavy = new GraphModel(
      "heavy",
      [
        { id: "S", attributes: {} },
        { id: "M", attributes: {} },
        { id: "T", attributes: {} },
      ],
      [
        { from: "S", to: "M", attributes: { weight: 500_000 } },
        { from: "M", to: "T", attributes: { weight: 600_000 } },
        { from: "S", to: "T", attributes: { weight: 1_500_000 } },
      ],
      new Map(),
    );

    const results = kShortestPaths(heavy, "S", "T", 2);
    expect(results).to.have.length(2);

    const [best, alternative] = results;

    expect(best.distance).to.equal(1_100_000);
    expect(best.path).to.deep.equal(["S", "M", "T"]);
    expect(alternative.distance).to.equal(1_500_000);
    expect(alternative.path).to.deep.equal(["S", "T"]);
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
