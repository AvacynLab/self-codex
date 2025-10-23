import { describe, it } from "mocha";
import { expect } from "chai";

import { embedSubgraph, flatten, type HierGraph } from "../src/graph/hierarchy.js";

describe("graph hierarchy - flatten", () => {
  it("expands nested subgraphs into a normalised graph", () => {
    const quality: HierGraph = {
      id: "quality",
      nodes: [
        { id: "lint", kind: "task", label: "Lint", outputs: ["out"] },
        { id: "test", kind: "task", label: "Test", inputs: ["in"], outputs: ["out"] },
      ],
      edges: [{ id: "q1", from: { nodeId: "lint", port: "out" }, to: { nodeId: "test", port: "in" } }],
    };

    const analysis: HierGraph = {
      id: "analysis",
      nodes: [
        { id: "parse", kind: "task", label: "Parse", outputs: ["out"] },
        {
          id: "qualityStage",
          kind: "subgraph",
          ref: "quality",
          params: { ports: { inputs: { begin: "lint" }, outputs: { end: "test" } } },
        },
        { id: "score", kind: "task", label: "Score", inputs: ["in"] },
      ],
      edges: [
        { id: "a1", from: { nodeId: "parse", port: "out" }, to: { nodeId: "qualityStage", port: "begin" } },
        { id: "a2", from: { nodeId: "qualityStage", port: "end" }, to: { nodeId: "score", port: "in" } },
      ],
    };

    const root: HierGraph = {
      id: "root",
      nodes: [
        { id: "ingest", kind: "task", label: "Ingest", outputs: ["out"] },
        {
          id: "analysis",
          kind: "subgraph",
          ref: "analysis",
          params: { ports: { inputs: { entry: "parse" }, outputs: { exit: "score" } } },
        },
        { id: "ship", kind: "task", label: "Ship", inputs: ["in"] },
      ],
      edges: [
        { id: "r1", from: { nodeId: "ingest", port: "out" }, to: { nodeId: "analysis", port: "entry" } },
        { id: "r2", from: { nodeId: "analysis", port: "exit" }, to: { nodeId: "ship", port: "in" } },
      ],
    };

    const analysisEmbedded = embedSubgraph(analysis, "qualityStage", quality);
    const fullyEmbedded = embedSubgraph(root, "analysis", analysisEmbedded);

    const flat = flatten(fullyEmbedded);
    expect(flat.metadata.hierarchical).to.equal(true);
    expect(flat.name).to.equal("root");

    const nodeIds = flat.nodes.map((node) => node.id);
    expect(nodeIds).to.include.members([
      "ingest",
      "analysis/parse",
      "analysis/qualityStage/lint",
      "analysis/qualityStage/test",
      "analysis/score",
      "ship",
    ]);

    const transitions = flat.edges.map((edge) => ({ from: edge.from, to: edge.to }));
    expect(transitions).to.deep.include({ from: "ingest", to: "analysis/parse" });
    expect(transitions).to.deep.include({ from: "analysis/parse", to: "analysis/qualityStage/lint" });
    expect(transitions).to.deep.include({ from: "analysis/qualityStage/lint", to: "analysis/qualityStage/test" });
    expect(transitions).to.deep.include({ from: "analysis/qualityStage/test", to: "analysis/score" });
    expect(transitions).to.deep.include({ from: "analysis/score", to: "ship" });

    const qualityEdge = flat.edges.find(
      (edge) => edge.from === "analysis/qualityStage/lint" && edge.to === "analysis/qualityStage/test",
    );
    expect(qualityEdge?.attributes.from_port).to.equal("out");
    expect(qualityEdge?.attributes.to_port).to.equal("in");

    const repeat = flatten(fullyEmbedded);
    expect(repeat.edges.map((edge) => `${edge.from}->${edge.to}`)).to.deep.equal(
      flat.edges.map((edge) => `${edge.from}->${edge.to}`),
    );
  });

  it("omits optional node and edge fields when hierarchy definitions skip them", () => {
    const hier: HierGraph = {
      id: "minimal",
      nodes: [
        { id: "alpha", kind: "task", attributes: { tier: "core" } },
        { id: "beta", kind: "task" },
      ],
      edges: [
        { id: "e1", from: { nodeId: "alpha" }, to: { nodeId: "beta" } },
      ],
    };

    const flat = flatten(hier);

    const alpha = flat.nodes.find((node) => node.id === "alpha");
    expect(alpha?.attributes.tier).to.equal("core");
    expect(Object.hasOwn(alpha ?? {}, "label")).to.equal(false);

    const beta = flat.nodes.find((node) => node.id === "beta");
    expect(beta).to.not.equal(undefined);
    expect(Object.hasOwn(beta ?? {}, "label")).to.equal(false);

    const edge = flat.edges.find((candidate) => candidate.from === "alpha" && candidate.to === "beta");
    expect(edge).to.not.equal(undefined);
    expect(Object.hasOwn(edge ?? {}, "label")).to.equal(false);
  });
});
