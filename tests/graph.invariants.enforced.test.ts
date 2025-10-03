import { describe, it } from "mocha";
import { expect } from "chai";

import type { NormalisedGraph } from "../src/graph/types.js";
import {
  assertGraphInvariants,
  evaluateGraphInvariants,
  GraphInvariantError,
} from "../src/graph/invariants.js";

function createGraph(partial?: Partial<NormalisedGraph>): NormalisedGraph {
  return {
    name: "invariants",
    graphId: "inv",
    graphVersion: 1,
    metadata: {},
    nodes: [
      { id: "alpha", label: "Alpha", attributes: {} },
      { id: "beta", label: "Beta", attributes: {} },
      { id: "gamma", label: "Gamma", attributes: {} },
    ],
    edges: [
      { from: "alpha", to: "beta", label: "alpha->beta", attributes: { from_port: "out", to_port: "in" } },
      { from: "beta", to: "gamma", label: "beta->gamma", attributes: { from_port: "out", to_port: "in" } },
    ],
    ...partial,
  } satisfies NormalisedGraph;
}

describe("graph invariants", () => {
  it("detects cycles when the graph declares itself as a DAG", () => {
    const graph = createGraph({
      metadata: { graph_kind: "dag" },
      edges: [
        { from: "alpha", to: "beta", label: "alpha->beta", attributes: { from_port: "out", to_port: "in" } },
        { from: "beta", to: "gamma", label: "beta->gamma", attributes: { from_port: "out", to_port: "in" } },
        { from: "gamma", to: "alpha", label: "gamma->alpha", attributes: { from_port: "out", to_port: "in" } },
      ],
    });

    expect(() => assertGraphInvariants(graph)).to.throw(GraphInvariantError).that.satisfies((error: unknown) => {
      const invariantError = error as GraphInvariantError;
      expect(invariantError.violations.some((violation) => violation.code === "E-GRAPH-CYCLE")).to.equal(true);
      return true;
    });
  });

  it("requires node labels when metadata opts in", () => {
    const graph = createGraph({ metadata: { require_labels: true } });
    graph.nodes[1]!.label = "";

    const report = evaluateGraphInvariants(graph);
    expect(report.ok).to.equal(false);
    const violation = report.violations.find((entry) => entry.code === "E-NODE-LABEL");
    expect(violation).to.not.be.undefined;
    expect(violation?.nodes).to.deep.equal(["beta"]);
  });

  it("requires port attributes when enabled", () => {
    const graph = createGraph({ metadata: { require_ports: true } });
    graph.edges[0]!.attributes = {};

    expect(() => assertGraphInvariants(graph)).to.throw(GraphInvariantError).that.satisfies((error: unknown) => {
      const invariantError = error as GraphInvariantError;
      expect(invariantError.violations.some((violation) => violation.code === "E-EDGE-PORT")).to.equal(true);
      return true;
    });
  });

  it("enforces cardinality hints from metadata and node attributes", () => {
    const graph = createGraph({ metadata: { max_in_degree: 1 } });
    graph.edges.push({
      from: "alpha",
      to: "beta",
      label: "alpha->beta#2",
      attributes: { from_port: "out", to_port: "in" },
    });

    const report = evaluateGraphInvariants(graph);
    expect(report.ok).to.equal(false);
    expect(report.violations.some((violation) => violation.code === "E-IN-DEGREE")).to.equal(true);
  });

  it("accepts a graph respecting every declared invariant", () => {
    const graph = createGraph({
      metadata: {
        graph_kind: "dag",
        require_labels: true,
        require_ports: true,
        require_edge_labels: true,
        max_in_degree: 2,
      },
    });

    expect(() => assertGraphInvariants(graph)).to.not.throw();
  });
});
