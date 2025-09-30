import { expect } from "chai";
import {
  GraphDescriptorPayload,
  GraphCausalAnalyzeInputSchema,
  handleGraphCausalAnalyze,
} from "../src/tools/graphTools.js";

describe("graph_causal_analyze", () => {
  it("computes topological order, ancestors, and minimal cut for a DAG", () => {
    // Multi-source and multi-sink pipeline to validate deterministic ordering and
    // the capacity-based minimal cut extraction.
    const graph: GraphDescriptorPayload = {
      name: "dag",
      nodes: [
        { id: "A", attributes: { kind: "start" } },
        { id: "B", attributes: { kind: "middle" } },
        { id: "C", attributes: { kind: "middle" } },
        { id: "D", attributes: { kind: "end" } },
      ],
      edges: [
        { from: "A", to: "B", attributes: {} },
        { from: "A", to: "C", attributes: {} },
        { from: "B", to: "D", attributes: {} },
        { from: "C", to: "D", attributes: {} },
      ],
    };

    const input = GraphCausalAnalyzeInputSchema.parse({ graph });
    const result = handleGraphCausalAnalyze(input);

    expect(result.acyclic).to.equal(true);
    expect(result.topological_order).to.deep.equal(["A", "B", "C", "D"]);
    expect(result.ancestors.D).to.deep.equal(["A", "B", "C"]);
    expect(result.descendants.A).to.deep.equal(["B", "C", "D"]);
    expect(result.min_cut).to.not.be.null;
    expect(result.min_cut!.size).to.equal(2);
    const cutEdges = result.min_cut!.edges
      .map((edge) => `${edge.from}->${edge.to}`)
      .sort();
    expect([
      ["A->B", "A->C"],
      ["B->D", "C->D"],
    ]).to.deep.include(cutEdges);
  });

  it("handles multiple entrypoints/sinks with deterministic ordering and min-cut", () => {
    const graph: GraphDescriptorPayload = {
      name: "multi",
      nodes: [
        { id: "G", attributes: { kind: "merge" } },
        { id: "M1", attributes: { kind: "stage" } },
        { id: "M2", attributes: { kind: "stage" } },
        { id: "S1", attributes: { kind: "source" } },
        { id: "S2", attributes: { kind: "source" } },
        { id: "T1", attributes: { kind: "sink" } },
        { id: "T2", attributes: { kind: "sink" } },
      ],
      edges: [
        { from: "S1", to: "M1", attributes: {} },
        { from: "S1", to: "M2", attributes: {} },
        { from: "S2", to: "M2", attributes: {} },
        { from: "M1", to: "G", attributes: {} },
        { from: "M2", to: "G", attributes: {} },
        { from: "G", to: "T1", attributes: {} },
        { from: "G", to: "T2", attributes: {} },
      ],
    };

    const input = GraphCausalAnalyzeInputSchema.parse({
      graph,
      include_transitive_closure: true,
      compute_min_cut: true,
    });
    const result = handleGraphCausalAnalyze(input);

    expect(result.acyclic).to.equal(true);
    expect(result.entrypoints).to.deep.equal(["S1", "S2"]);
    expect(result.sinks).to.deep.equal(["T1", "T2"]);
    expect(result.topological_order).to.deep.equal(["S1", "M1", "S2", "M2", "G", "T1", "T2"]);
    expect(result.ancestors.G).to.deep.equal(["M1", "M2", "S1", "S2"]);
    expect(result.descendants.S1).to.deep.equal(["G", "M1", "M2", "T1", "T2"]);
    expect(result.min_cut).to.deep.equal({
      size: 2,
      edges: [
        { from: "M2", to: "G" },
        { from: "S1", to: "M1" },
      ],
    });
  });

  it("computes closures via BFS when cycles are present", () => {
    // Graph containing a 3-cycle feeding into a sink to ensure the BFS-based
    // closure logic runs when topological sorting is not possible.
    const cyclicWithTail: GraphDescriptorPayload = {
      name: "cycle-closure",
      nodes: [
        { id: "A", attributes: {} },
        { id: "B", attributes: {} },
        { id: "C", attributes: {} },
        { id: "D", attributes: {} },
      ],
      edges: [
        { from: "A", to: "B", attributes: {} },
        { from: "B", to: "C", attributes: {} },
        { from: "C", to: "A", attributes: {} },
        { from: "C", to: "D", attributes: {} },
      ],
    };

    const input = GraphCausalAnalyzeInputSchema.parse({
      graph: cyclicWithTail,
      include_transitive_closure: true,
      compute_min_cut: false,
      max_cycles: 5,
    });
    const result = handleGraphCausalAnalyze(input);

    expect(result.acyclic).to.equal(false);
    expect(result.cycles).to.deep.equal([["A", "B", "C", "A"]]);
    expect(result.sinks).to.deep.equal(["D"]);
    expect(result.ancestors).to.deep.equal({
      A: ["A", "B", "C"],
      B: ["A", "B", "C"],
      C: ["A", "B", "C"],
      D: ["A", "B", "C"],
    });
    expect(result.descendants).to.deep.equal({
      A: ["A", "B", "C", "D"],
      B: ["A", "B", "C", "D"],
      C: ["A", "B", "C", "D"],
      D: [],
    });
    expect(result.feedback_arc_suggestions).to.deep.equal([
      { remove: { from: "A", to: "B" }, score: 1, reason: "edge closes a cycle (weight=1)" },
      { remove: { from: "B", to: "C" }, score: 1, reason: "edge closes a cycle (weight=1)" },
      { remove: { from: "C", to: "A" }, score: 1, reason: "edge closes a cycle (weight=1)" },
    ]);
    expect(result.notes).to.deep.equal(["cycles_detected (1)"]);
  });

  it("flags cycles and proposes feedback arc removals", () => {
    const cyclic: GraphDescriptorPayload = {
      name: "cycle",
      nodes: [
        { id: "A", attributes: {} },
        { id: "B", attributes: {} },
        { id: "C", attributes: {} },
      ],
      edges: [
        { from: "A", to: "B", attributes: {} },
        { from: "B", to: "C", attributes: {} },
        { from: "C", to: "A", attributes: {} },
      ],
    };

    const input = GraphCausalAnalyzeInputSchema.parse({ graph: cyclic, max_cycles: 5 });
    const result = handleGraphCausalAnalyze(input);

    expect(result.acyclic).to.equal(false);
    expect(result.cycles.length).to.be.greaterThan(0);
    expect(result.feedback_arc_suggestions.length).to.be.greaterThan(0);
    const suggestionEdges = result.feedback_arc_suggestions.map((entry) => entry.remove);
    expect(suggestionEdges).to.deep.equal([
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
    ]);
  });
});
