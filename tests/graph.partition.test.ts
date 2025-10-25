import { expect } from "chai";

import { GraphPartitionInputSchema, handleGraphPartition } from "../src/tools/graph/query.js";

import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

describe("graph_partition tool", () => {
  const baseGraph: GraphDescriptorPayload = {
    name: "clusters",
    nodes: [
      { id: "A", attributes: {} },
      { id: "B", attributes: {} },
      { id: "C", attributes: {} },
      { id: "D", attributes: {} },
      { id: "E", attributes: {} },
      { id: "F", attributes: {} },
    ],
    edges: [
      { from: "A", to: "B", attributes: {} },
      { from: "B", to: "C", attributes: {} },
      { from: "C", to: "D", attributes: {} },
      { from: "D", to: "E", attributes: {} },
      { from: "E", to: "F", attributes: {} },
    ],
  };

  it("produces stable community partitions", () => {
    // Ensures the community-oriented heuristic groups adjacent nodes together
    // when the graph forms a simple path.
    const result = handleGraphPartition(
      GraphPartitionInputSchema.parse({ graph: baseGraph, k: 2, objective: "community" }),
    );

    const assignments = new Map(result.assignments.map((entry) => [entry.node, entry.partition] as const));
    expect(result.partition_count).to.equal(2);
    expect(assignments.get("A")).to.equal(assignments.get("B"));
    expect(assignments.get("E")).to.equal(assignments.get("F"));
    expect(result.notes).to.be.an("array");
  });

  it("minimises cut edges when using the min-cut objective", () => {
    // The additional bridge from B to E should be handled by placing the cut
    // near the sink so that only the E -> F transition is severed.
    const graphWithBridge: GraphDescriptorPayload = {
      ...baseGraph,
      edges: [
        ...baseGraph.edges,
        { from: "B", to: "E", attributes: {} },
      ],
    };

    const result = handleGraphPartition(
      GraphPartitionInputSchema.parse({ graph: graphWithBridge, k: 2, objective: "min-cut", seed: 1 }),
    );

    expect(result.cut_edges).to.be.at.most(1);
    expect(result.partition_count).to.equal(2);
    expect(result.seed_nodes.length).to.be.greaterThan(0);
  });

  it("caps the partition count to the available node count when k is oversized", () => {
    // Asking for more partitions than there are nodes should be gracefully
    // clamped, guaranteeing that each vertex receives a deterministic label and
    // that the planner records the adjustment in the diagnostic notes.
    const oversized = handleGraphPartition(
      GraphPartitionInputSchema.parse({ graph: baseGraph, k: 12, objective: "community" }),
    );

    const assignedNodes = new Set(oversized.assignments.map((entry) => entry.node));
    expect(oversized.partition_count).to.equal(baseGraph.nodes.length);
    expect(assignedNodes.size).to.equal(baseGraph.nodes.length);
    expect(oversized.notes).to.include("k_reduced_to_node_count");
  });

  it("maintains distinct partitions on dense graphs with overlapping bridges", () => {
    // Two tightly connected cliques linked by a pair of bridges force the
    // heuristics to pick meaningful cut points even when the overlap is
    // significant. We only require that the primary clique stays intact, that a
    // second partition remains populated, and that the cut does not explode.
    const denseGraph: GraphDescriptorPayload = {
      name: "two-dense-cliques",
      nodes: ["A", "B", "C", "D", "E", "F"].map((id) => ({ id, attributes: {} })),
      edges: [
        { from: "A", to: "B", attributes: {} },
        { from: "B", to: "C", attributes: {} },
        { from: "C", to: "A", attributes: {} },
        { from: "D", to: "E", attributes: {} },
        { from: "E", to: "F", attributes: {} },
        { from: "F", to: "D", attributes: {} },
        { from: "C", to: "D", attributes: {} },
        { from: "B", to: "E", attributes: {} },
      ],
    };

    const denseResult = handleGraphPartition(
      GraphPartitionInputSchema.parse({ graph: denseGraph, k: 2, objective: "min-cut", seed: 3 }),
    );

    const assignments = new Map(denseResult.assignments.map((entry) => [entry.node, entry.partition] as const));
    const partitions = new Set(denseResult.assignments.map((entry) => entry.partition));
    expect(assignments.get("A")).to.equal(assignments.get("B"));
    expect(assignments.get("B")).to.equal(assignments.get("C"));
    expect(partitions.size).to.equal(2);
    expect(assignments.get("E")).to.not.equal(assignments.get("B"));
    expect(denseResult.cut_edges).to.be.at.most(4);
  });
});
