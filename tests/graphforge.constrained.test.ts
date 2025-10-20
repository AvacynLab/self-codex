/// <reference path="./graph-forge.d.ts" />
import { describe, it } from "mocha";
import { expect } from "chai";
import { getGraphForge } from "./helpers/graphForge.js";

// The helper delivers the strongly typed runtime so constrained path tests stay
// focused on behaviour rather than wiring up manual type assertions.
const { GraphModel, constrainedShortestPath } = await getGraphForge();

type RuntimeGraphModel = InstanceType<typeof GraphModel>;

describe("graph-forge constrained shortest path", () => {
  it("respects node exclusion lists", () => {
    const graph = buildSampleGraph();

    const result = constrainedShortestPath(graph, "A", "D", { avoidNodes: ["B"] });

    expect(result.status).to.equal("found");
    expect(result.path).to.deep.equal(["A", "C", "D"]);
    expect(result.distance).to.equal(3);
    expect(result.filteredNodes).to.deep.equal(["B"]);
    expect(result.filteredEdges).to.deep.equal([
      { from: "A", to: "B" },
      { from: "B", to: "D" },
    ]);
    expect(result.notes).to.include("constraints_pruned_graph");
    expect(result.violations).to.deep.equal([]);
  });

  it("flags cost overruns while returning the best path", () => {
    const graph = buildSampleGraph();

    const result = constrainedShortestPath(graph, "A", "D", { maxCost: 1 });

    expect(result.status).to.equal("max_cost_exceeded");
    expect(result.path).to.deep.equal(["A", "B", "D"]);
    expect(result.distance).to.equal(2);
    expect(result.notes).to.include("cost_budget_exceeded");
    expect(result.filteredNodes).to.deep.equal([]);
    expect(result.filteredEdges).to.deep.equal([]);
  });

  it("short-circuits when the start node is excluded", () => {
    const graph = buildSampleGraph();

    const result = constrainedShortestPath(graph, "A", "D", { avoidNodes: ["A"] });

    expect(result.status).to.equal("start_or_goal_excluded");
    expect(result.path).to.deep.equal([]);
    expect(result.distance).to.equal(Number.POSITIVE_INFINITY);
    expect(result.violations[0]).to.match(/start node 'A'/);
    expect(result.notes).to.include("start_or_goal_excluded");
  });
});

function buildSampleGraph(): RuntimeGraphModel {
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
      { from: "B", to: "D", attributes: { weight: 1 } },
      { from: "A", to: "C", attributes: { weight: 2 } },
      { from: "C", to: "D", attributes: { weight: 1 } },
    ],
    new Map(),
  );
}
