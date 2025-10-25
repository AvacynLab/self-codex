import { expect } from "chai";
import { GraphOptimizeMooInputSchema, handleGraphOptimizeMoo } from "../src/tools/graph/query.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

const BASE_GRAPH: GraphDescriptorPayload = {
  name: "parallel_fan_in",
  nodes: [
    { id: "A", attributes: { duration: 8, cost: 5 } },
    { id: "B", attributes: { duration: 6, cost: 4 } },
    { id: "C", attributes: { duration: 4, cost: 3 } },
    { id: "D", attributes: { duration: 2, cost: 2 } },
  ],
  edges: [
    { from: "A", to: "D", attributes: {} },
    { from: "B", to: "D", attributes: {} },
    { from: "C", to: "D", attributes: {} },
  ],
};

describe("graph_optimize_moo", () => {
  it("computes a Pareto frontier with parallelism trade-offs", () => {
    const input = GraphOptimizeMooInputSchema.parse({
      graph: BASE_GRAPH,
      parallelism_candidates: [1, 2, 3],
      objectives: [
        { type: "makespan" },
        { type: "cost", attribute: "cost", default_value: 0, parallel_penalty: 2 },
      ],
      duration_attribute: "duration",
      default_duration: 1,
    });

    const result = handleGraphOptimizeMoo(input);
    const paretoParallelism = result.pareto_front.map((candidate) => candidate.parallelism).sort();
    expect(paretoParallelism).to.deep.equal([1, 2, 3]);

    const objectiveSummaries = result.pareto_front.map((candidate) => ({
      parallelism: candidate.parallelism,
      makespan: candidate.objectives.makespan,
      cost: candidate.objectives.cost,
    }));

    expect(objectiveSummaries).to.deep.equal([
      { parallelism: 1, makespan: 20, cost: 16 },
      { parallelism: 2, makespan: 12, cost: 18 },
      { parallelism: 3, makespan: 10, cost: 20 },
    ]);

    // None of the Pareto solutions should dominate the others. The middle
    // point trades makespan for cost, ensuring the optimiser keeps the full
    // frontier instead of collapsing to the two extremes.
    for (let i = 0; i < objectiveSummaries.length; i += 1) {
      for (let j = 0; j < objectiveSummaries.length; j += 1) {
        if (i === j) {
          continue;
        }
        const a = objectiveSummaries[i];
        const b = objectiveSummaries[j];
        const aDominates = a.makespan <= b.makespan && a.cost <= b.cost && (a.makespan < b.makespan || a.cost < b.cost);
        expect(aDominates).to.equal(false);
      }
    }
  });

  it("applies weighted scalarisation on top of the Pareto set", () => {
    const input = GraphOptimizeMooInputSchema.parse({
      graph: BASE_GRAPH,
      parallelism_candidates: [1, 2, 3],
      objectives: [
        { type: "makespan" },
        { type: "cost", attribute: "cost", default_value: 0, parallel_penalty: 2 },
      ],
      duration_attribute: "duration",
      default_duration: 1,
      scalarization: {
        method: "weighted_sum",
        weights: { makespan: 0.7, cost: 0.3 },
      },
    });

    const result = handleGraphOptimizeMoo(input);
    expect(result.scalarization).to.not.be.undefined;
    const ranking = result.scalarization!.ranking;
    expect(ranking[0].parallelism).to.equal(3);
    expect(ranking[ranking.length - 1].parallelism).to.equal(1);
  });

  it("rejects duplicated objective labels at validation time", () => {
    expect(() =>
      GraphOptimizeMooInputSchema.parse({
        graph: BASE_GRAPH,
        parallelism_candidates: [1, 2],
        objectives: [
          { type: "makespan", label: "duration" },
          { type: "cost", label: "duration" },
        ],
        duration_attribute: "duration",
        default_duration: 1,
      }),
    ).to.throw(/duplicate objective label 'duration'/);
  });

  it("emits a diagnostic when scalarisation weights sum to zero", () => {
    // The schema allows zero-valued weights, so we exercise the runtime note that
    // the handler appends when no meaningful ranking can be computed.
    const input = GraphOptimizeMooInputSchema.parse({
      graph: BASE_GRAPH,
      parallelism_candidates: [1, 2],
      objectives: [
        { type: "makespan" },
        { type: "cost", attribute: "cost", default_value: 0 },
      ],
      duration_attribute: "duration",
      default_duration: 1,
      scalarization: {
        method: "weighted_sum",
        weights: { makespan: 0, cost: 0 },
      },
    });

    const result = handleGraphOptimizeMoo(input);
    expect(result.scalarization).to.be.undefined;
    expect(result.notes).to.include("scalarization_weights_sum_zero");
  });
});
