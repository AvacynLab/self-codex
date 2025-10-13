import { describe, it } from "mocha";
import { expect } from "chai";

import type { NormalisedGraph } from "../../src/graph/types.js";
import { validateGraph, GraphValidationError, assertValidGraph } from "../../src/graph/validate.js";

function buildGraph(overrides: Partial<NormalisedGraph> = {}): NormalisedGraph {
  return {
    name: "validation",
    graphId: "graph-validation",
    graphVersion: 1,
    metadata: {},
    nodes: [
      { id: "A", label: "A", attributes: {} },
      { id: "B", label: "B", attributes: {} },
    ],
    edges: [{ from: "A", to: "B", label: "A->B", attributes: {} }],
    ...overrides,
  } satisfies NormalisedGraph;
}

describe("graph validation", () => {
  it("rejects duplicate node identifiers", () => {
    const graph = buildGraph({
      nodes: [
        { id: "A", label: "A", attributes: {} },
        { id: "A", label: "Duplicate", attributes: {} },
      ],
    });

    const result = validateGraph(graph);
    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.violations.some((violation) => violation.message.includes("duplicate"))).to.equal(true);
    }
  });

  it("rejects self-loops unless explicitly allowed", () => {
    const graph = buildGraph({ edges: [{ from: "A", to: "A", label: "loop", attributes: {} }] });
    expect(() => assertValidGraph(graph, { allowSelfLoops: false })).to.throw(GraphValidationError);
  });

  it("enforces isolation rules derived from metadata", () => {
    const graph = buildGraph({
      nodes: [
        { id: "A", label: "A", attributes: {} },
        { id: "B", label: "B", attributes: {} },
        { id: "C", label: "C", attributes: {} },
      ],
      edges: [{ from: "A", to: "B", label: "edge", attributes: {} }],
      metadata: { allow_isolated_nodes: false },
    });

    const result = validateGraph(graph);
    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.violations.some((violation) => violation.message.includes("isolated"))).to.equal(true);
    }
  });

  it("applies configured size limits", () => {
    const graph = buildGraph();
    const result = validateGraph(graph, { maxNodes: 1, maxEdges: 0 });
    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.violations.some((violation) => violation.message.includes("node limit"))).to.equal(true);
      expect(result.violations.some((violation) => violation.message.includes("edge limit"))).to.equal(true);
    }
  });

  it("passes for structurally valid graphs", () => {
    const graph = buildGraph();
    expect(() => assertValidGraph(graph)).to.not.throw();
  });
});
