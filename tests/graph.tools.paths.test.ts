import { expect } from "chai";

import {
  GraphPathsConstrainedInputSchema,
  GraphPathsKShortestInputSchema,
  GraphCentralityBetweennessInputSchema,
  GraphCriticalPathInputSchema,
  handleGraphPathsConstrained,
  handleGraphPathsKShortest,
  handleGraphCentralityBetweenness,
  handleGraphCriticalPath,
} from "../src/tools/graph/query.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

describe("graph path tools", () => {
  const baseGraph: GraphDescriptorPayload = {
    name: "routes",
    nodes: [
      { id: "A", attributes: {} },
      { id: "B", attributes: {} },
      { id: "C", attributes: {} },
      { id: "D", attributes: {} },
    ],
    edges: [
      { from: "A", to: "B", weight: 1, attributes: { weight: 1 } },
      { from: "A", to: "C", weight: 1, attributes: { weight: 1 } },
      { from: "B", to: "D", weight: 1, attributes: { weight: 1 } },
      { from: "C", to: "D", weight: 1, attributes: { weight: 1 } },
      { from: "B", to: "C", weight: 1, attributes: { weight: 1 } },
      { from: "C", to: "B", weight: 2, attributes: { weight: 2 } },
    ],
  };

  it("returns ranked loop-less paths ordered by cost", () => {
    const input = GraphPathsKShortestInputSchema.parse({
      graph: baseGraph,
      from: "A",
      to: "D",
      k: 3,
    });

    const result = handleGraphPathsKShortest(input);

    expect(result.requested_k).to.equal(3);
    expect(result.returned_k).to.equal(3);
    expect(result.paths.map((entry) => entry.nodes)).to.deep.equal([
      ["A", "B", "D"],
      ["A", "C", "D"],
      ["A", "B", "C", "D"],
    ]);
    expect(result.paths.map((entry) => entry.cost)).to.deep.equal([2, 2, 3]);
  });

  it("honours node exclusions and reports cost overruns", () => {
    const avoidInput = GraphPathsConstrainedInputSchema.parse({
      graph: baseGraph,
      from: "A",
      to: "D",
      avoid_nodes: ["B"],
    });

    const avoidResult = handleGraphPathsConstrained(avoidInput);
    expect(avoidResult.status).to.equal("found");
    expect(avoidResult.path).to.deep.equal(["A", "C", "D"]);
    expect(avoidResult.cost).to.equal(2);
    expect(avoidResult.filtered).to.deep.equal({ nodes: 1, edges: 4 });
    expect(avoidResult.notes).to.include("constraints_pruned_graph");

    const budgetInput = GraphPathsConstrainedInputSchema.parse({
      graph: baseGraph,
      from: "A",
      to: "D",
      max_cost: 1,
    });
    const budgetResult = handleGraphPathsConstrained(budgetInput);
    expect(budgetResult.status).to.equal("cost_exceeded");
    expect(budgetResult.reason).to.equal("MAX_COST_EXCEEDED");
    expect(budgetResult.cost).to.be.greaterThan(1);
    expect(budgetResult.notes).to.include("cost_budget_exceeded");
  });

  it("supports excluding individual edges while keeping neighbouring nodes", () => {
    const input = GraphPathsConstrainedInputSchema.parse({
      graph: baseGraph,
      from: "A",
      to: "D",
      avoid_edges: [{ from: "A", to: "B" }],
    });

    const result = handleGraphPathsConstrained(input);

    expect(result.status).to.equal("found");
    expect(result.path).to.deep.equal(["A", "C", "D"]);
    expect(result.filtered).to.deep.equal({ nodes: 0, edges: 1 });
    expect(result.violations).to.deep.equal([]);
    expect(result.notes).to.include("constraints_pruned_graph");
  });

  it("computes betweenness scores with deterministic ordering", () => {
    const input = GraphCentralityBetweennessInputSchema.parse({
      graph: baseGraph,
      weighted: true,
      normalise: true,
      top_k: 2,
    });

    const result = handleGraphCentralityBetweenness(input);

    expect(result.top).to.have.length(2);
    expect(result.top[0].score).to.be.at.least(result.top[1].score);
    const topNodes = result.top.map((entry) => entry.node);
    expect(topNodes).to.include("B");
    expect(topNodes).to.include("C");
    expect(result.statistics.max).to.be.at.least(result.statistics.mean);
  });

  it("exposes critical path duration and slack information", () => {
    const durationGraph: GraphDescriptorPayload = {
      name: "pipeline",
      nodes: [
        { id: "lint", attributes: { duration: 1 } },
        { id: "test", attributes: { duration: 3 } },
        { id: "docs", attributes: { duration: 2 } },
        { id: "build", attributes: { duration: 2 } },
        { id: "package", attributes: { duration: 1 } },
      ],
      edges: [
        { from: "lint", to: "test", attributes: { weight: 1 } },
        { from: "lint", to: "docs", attributes: { weight: 1 } },
        { from: "test", to: "build", attributes: { weight: 1 } },
        { from: "docs", to: "build", attributes: { weight: 1 } },
        { from: "build", to: "package", attributes: { weight: 1 } },
      ],
    };

    const input = GraphCriticalPathInputSchema.parse({ graph: durationGraph });
    const result = handleGraphCriticalPath(input);

    expect(result.duration).to.equal(7);
    expect(result.critical_path).to.deep.equal(["lint", "test", "build", "package"]);
    expect(result.slack_by_node.docs).to.be.greaterThan(0);
    expect(result.earliest_start.package).to.equal(6);
  });
});
