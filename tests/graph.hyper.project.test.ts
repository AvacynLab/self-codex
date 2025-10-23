import { describe, it } from "mocha";
import { expect } from "chai";

import {
  projectHyperGraph,
  type HyperGraph,
  HYPER_EDGE_ID_KEY,
  HYPER_EDGE_PAIR_INDEX_KEY,
  HYPER_EDGE_SOURCE_CARDINALITY_KEY,
  HYPER_EDGE_TARGET_CARDINALITY_KEY,
} from "../src/graph/hypergraph.js";

// The suite validates that hyper-edges expand deterministically and keep enough
// context to rebuild the original n-ary relation during downstream analyses.
describe("graph hypergraph - projection", () => {
  it("projects hyper-edges into binary edges with metadata", () => {
    const hyperGraph: HyperGraph = {
      id: "build-pipeline",
      nodes: [
        { id: "lint", label: "Lint", attributes: { type: "task" } },
        { id: "test", label: "Test", attributes: { type: "task" } },
        { id: "package", label: "Package", attributes: { type: "task" } },
        { id: "notify", label: "Notify", attributes: { type: "task" } },
      ],
      hyperEdges: [
        {
          id: "quality",
          sources: ["lint", "test"],
          targets: ["package"],
          label: "quality gate",
          weight: 2,
          attributes: { phase: "checks" },
        },
        {
          id: "broadcast",
          sources: ["package"],
          targets: ["notify"],
          attributes: { phase: "delivery" },
        },
      ],
      metadata: { owner: "ci" },
    };

    const normalised = projectHyperGraph(hyperGraph, { graphVersion: 7 });

    expect(normalised.graphId).to.equal("build-pipeline");
    expect(normalised.graphVersion).to.equal(7);
    expect(normalised.metadata.hyper_edge_projection).to.equal(true);
    expect(normalised.metadata.owner).to.equal("ci");

    const edges = normalised.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      attributes: edge.attributes,
      label: edge.label,
      weight: edge.weight,
    }));

    expect(edges).to.have.lengthOf(3);

    const qualityEdges = edges.filter((edge) => edge.attributes[HYPER_EDGE_ID_KEY] === "quality");
    expect(qualityEdges).to.have.lengthOf(2);
    for (const edge of qualityEdges) {
      expect(edge.label).to.equal("quality gate");
      expect(edge.weight).to.equal(2);
      expect(edge.attributes.phase).to.equal("checks");
      expect(edge.attributes[HYPER_EDGE_SOURCE_CARDINALITY_KEY]).to.equal(2);
      expect(edge.attributes[HYPER_EDGE_TARGET_CARDINALITY_KEY]).to.equal(1);
    }

    const pairIndexes = qualityEdges.map((edge) => edge.attributes[HYPER_EDGE_PAIR_INDEX_KEY]);
    expect(pairIndexes).to.deep.equal([0, 1]);

    const broadcastEdges = edges.filter((edge) => edge.attributes[HYPER_EDGE_ID_KEY] === "broadcast");
    expect(broadcastEdges).to.have.lengthOf(1);
    expect(broadcastEdges[0].from).to.equal("package");
    expect(broadcastEdges[0].to).to.equal("notify");
    expect(broadcastEdges[0].attributes.phase).to.equal("delivery");
  });

  it("throws when a hyper-edge references an unknown node", () => {
    const hyperGraph: HyperGraph = {
      id: "broken",
      nodes: [{ id: "known", attributes: {} }],
      hyperEdges: [{ id: "oops", sources: ["known"], targets: ["missing"] }],
    };

    expect(() => projectHyperGraph(hyperGraph)).to.throw(
      "hyper-edge oops references unknown target node missing",
    );
  });

  it("omits optional fields when hyper-edges skip labels and weights", () => {
    const hyperGraph: HyperGraph = {
      id: "sparse",
      nodes: [
        { id: "alpha", attributes: {} },
        { id: "beta", attributes: {} },
      ],
      hyperEdges: [
        { id: "plain", sources: ["alpha"], targets: ["beta"] },
      ],
    };

    const normalised = projectHyperGraph(hyperGraph);

    expect(Object.hasOwn(normalised.nodes[0], "label")).to.equal(false);
    expect(Object.hasOwn(normalised.edges[0], "label")).to.equal(false);
    expect(Object.hasOwn(normalised.edges[0], "weight")).to.equal(false);
  });
});
