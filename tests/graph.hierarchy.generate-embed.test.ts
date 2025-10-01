import { describe, it } from "mocha";
import { expect } from "chai";

import {
  embedSubgraph,
  flatten,
  getEmbeddedGraph,
  type HierGraph,
  type SubgraphNode,
} from "../src/graph/hierarchy.js";

describe("graph hierarchy - embed", () => {
  it("embeds a subgraph and exposes the flattened structure", () => {
    const parent: HierGraph = {
      id: "root",
      nodes: [
        { id: "alpha", kind: "task", label: "Alpha", outputs: ["out"] },
        {
          id: "beta",
          kind: "subgraph",
          ref: "child",
          params: { ports: { inputs: { entry: "start" }, outputs: { exit: "finish" } } },
        },
        { id: "omega", kind: "task", label: "Omega", inputs: ["in"] },
      ],
      edges: [
        { id: "e1", from: { nodeId: "alpha", port: "out" }, to: { nodeId: "beta", port: "entry" } },
        { id: "e2", from: { nodeId: "beta", port: "exit" }, to: { nodeId: "omega", port: "in" } },
      ],
    };

    const child: HierGraph = {
      id: "child",
      nodes: [
        { id: "start", kind: "task", label: "Start", outputs: ["out"] },
        { id: "finish", kind: "task", label: "Finish", inputs: ["in"] },
      ],
      edges: [{ id: "inner", from: { nodeId: "start", port: "out" }, to: { nodeId: "finish", port: "in" } }],
    };

    const originalSubNode = parent.nodes.find((node) => node.id === "beta") as SubgraphNode;
    expect(getEmbeddedGraph(originalSubNode)).to.equal(undefined);

    const embedded = embedSubgraph(parent, "beta", child);
    const subNode = embedded.nodes.find((node) => node.id === "beta") as SubgraphNode;
    const embeddedGraph = getEmbeddedGraph(subNode);
    expect(embeddedGraph).to.not.equal(undefined);
    expect(embeddedGraph?.id).to.equal("child");

    const flattened = flatten(embedded);
    const nodeIds = flattened.nodes.map((node) => node.id);
    expect(nodeIds).to.include.members(["alpha", "beta/start", "beta/finish", "omega"]);
    const edgePairs = flattened.edges.map((edge) => `${edge.from}->${edge.to}`);
    expect(edgePairs).to.include("alpha->beta/start");
    expect(edgePairs).to.include("beta/start->beta/finish");
    expect(edgePairs).to.include("beta/finish->omega");
  });

  it("rejects inter-level cycles referencing ancestor graphs", () => {
    const parent: HierGraph = {
      id: "root",
      nodes: [
        {
          id: "beta",
          kind: "subgraph",
          ref: "child",
          params: { ports: { inputs: { entry: "start" }, outputs: { exit: "start" } } },
        },
      ],
      edges: [],
    };

    const cyc: HierGraph = {
      id: "child",
      nodes: [
        { id: "start", kind: "task" },
        {
          id: "loopy",
          kind: "subgraph",
          ref: "root",
          params: { ports: { inputs: { entry: "start" }, outputs: { exit: "start" } } },
        },
      ],
      edges: [],
    };

    expect(() => embedSubgraph(parent, "beta", cyc)).to.throw(/cycle/i);
  });

  it("rejects port mappings targeting missing nodes", () => {
    const parent: HierGraph = {
      id: "root",
      nodes: [
        {
          id: "beta",
          kind: "subgraph",
          ref: "child",
          params: { ports: { inputs: { entry: "start" }, outputs: { exit: "missing" } } },
        },
      ],
      edges: [],
    };

    const child: HierGraph = {
      id: "child",
      nodes: [{ id: "start", kind: "task" }],
      edges: [],
    };

    expect(() => embedSubgraph(parent, "beta", child)).to.throw(/missing node/);
  });
});
