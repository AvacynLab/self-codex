import { describe, it } from "mocha";
import { expect } from "chai";

import { createInlineSubgraphRule, createRerouteAvoidRule, createSplitParallelRule, applyAll } from "../src/graph/rewrite.js";
import type { HierGraph } from "../src/graph/hierarchy.js";
import type { NormalisedGraph } from "../src/graph/types.js";

/**
 * Unit tests covering the behaviour of the standalone rewrite rules. Each test
 * documents the target transformation so future maintainers can evolve the
 * heuristics without regressing foundational guarantees (idempotence,
 * cycle-avoidance, metadata preservation).
 */
describe("graph rewrite - rule bank", () => {
  it("splits parallel edges into dedicated fan-out branches", () => {
    const graph: NormalisedGraph = {
      name: "parallel-test",
      graphId: "parallel-test",
      graphVersion: 1,
      nodes: [
        { id: "start", label: "Start", attributes: { kind: "task" } },
        { id: "alpha", label: "Alpha", attributes: { kind: "task" } },
        { id: "omega", label: "Omega", attributes: { kind: "task" } },
      ],
      edges: [
        { from: "start", to: "alpha", label: "spawn", attributes: { parallel: true } },
        { from: "alpha", to: "omega", label: "finish", attributes: {} },
      ],
      metadata: {},
    };

    const { graph: rewritten, history } = applyAll(graph, [createSplitParallelRule()]);
    const fanoutNode = rewritten.nodes.find((node) => node.id.startsWith("start∥alpha"));
    expect(fanoutNode, "a synthetic fan-out node should be inserted").to.not.equal(undefined);
    const rewrittenEdges = rewritten.edges.map((edge) => `${edge.from}->${edge.to}`);
    expect(rewrittenEdges).to.include("start->start∥alpha");
    expect(rewrittenEdges).to.include("start∥alpha->alpha");
    expect(history.filter((entry) => entry.rule === "split-parallel")[0]?.applied).to.equal(1);

    const secondPass = applyAll(rewritten, [createSplitParallelRule()]);
    expect(secondPass.graph).to.deep.equal(rewritten);
    expect(secondPass.history.filter((entry) => entry.rule === "split-parallel")[0]?.applied).to.equal(0);
  });

  it("inlines embedded subgraphs and rewires edges", () => {
    const subgraph: HierGraph = {
      id: "child",
      nodes: [
        { id: "entry", kind: "task", label: "Entry" },
        { id: "exit", kind: "task", label: "Exit" },
      ],
      edges: [
        { id: "inner", from: { nodeId: "entry" }, to: { nodeId: "exit" } },
      ],
    };

    const graph: NormalisedGraph = {
      name: "inline-test",
      graphId: "inline-test",
      graphVersion: 1,
      nodes: [
        { id: "root", label: "Root", attributes: { kind: "task" } },
        { id: "sub", label: "Sub", attributes: { kind: "subgraph", ref: "child" } },
        { id: "sink", label: "Sink", attributes: { kind: "task" } },
      ],
      edges: [
        { from: "root", to: "sub", label: "enter", attributes: {} },
        { from: "sub", to: "sink", label: "leave", attributes: {} },
      ],
      metadata: {
        "hierarchy:subgraphs": JSON.stringify({
          child: { graph: subgraph, entryPoints: ["entry"], exitPoints: ["exit"] },
        }),
      },
    };

    const { graph: rewritten } = applyAll(graph, [createInlineSubgraphRule()]);
    const nodeIds = rewritten.nodes.map((node) => node.id);
    expect(nodeIds).to.not.include("sub");
    expect(nodeIds).to.include("sub/entry");
    expect(nodeIds).to.include("sub/exit");
    const edgePairs = rewritten.edges.map((edge) => `${edge.from}->${edge.to}`);
    expect(edgePairs).to.include("root->sub/entry");
    expect(edgePairs).to.include("sub/exit->sink");
  });

  it("reroutes around avoided nodes without creating cycles", () => {
    const graph: NormalisedGraph = {
      name: "avoid-test",
      graphId: "avoid-test",
      graphVersion: 1,
      nodes: [
        { id: "start", label: "Start", attributes: { kind: "task" } },
        { id: "avoid-me", label: "Hotspot", attributes: { kind: "task" } },
        { id: "mid", label: "Mid", attributes: { kind: "task" } },
        { id: "end", label: "End", attributes: { kind: "task" } },
      ],
      edges: [
        { from: "start", to: "avoid-me", label: "forward", attributes: {} },
        { from: "avoid-me", to: "mid", label: "branch-a", attributes: {} },
        { from: "avoid-me", to: "end", label: "branch-b", attributes: {} },
        { from: "mid", to: "end", label: "close", attributes: {} },
      ],
      metadata: {},
    };

    const rule = createRerouteAvoidRule({ avoidNodeIds: new Set(["avoid-me"]) });
    const { graph: rewritten } = applyAll(graph, [rule]);
    const nodeIds = rewritten.nodes.map((node) => node.id);
    expect(nodeIds).to.not.include("avoid-me");
    const edgePairs = new Set(rewritten.edges.map((edge) => `${edge.from}->${edge.to}`));
    expect(edgePairs.has("start->mid")).to.equal(true);
    expect(edgePairs.has("start->end")).to.equal(true);
    expect([...edgePairs].some((pair) => pair.startsWith("avoid-me"))).to.equal(false);
  });
});
