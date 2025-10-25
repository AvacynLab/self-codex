import { expect } from "chai";

import { GraphOptimizeInputSchema, handleGraphOptimize } from "../src/tools/graph/query.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

describe("graph_optimize", () => {
  const GRAPH: GraphDescriptorPayload = {
    name: "fanout",
    nodes: [
      { id: "root", attributes: { duration: 1 } },
      { id: "task1", attributes: { duration: 4 } },
      { id: "task2", attributes: { duration: 4 } },
      { id: "task3", attributes: { duration: 4 } },
    ],
    edges: [
      { from: "root", to: "task1", attributes: {} },
      { from: "root", to: "task2", attributes: {} },
      { from: "root", to: "task3", attributes: {} },
    ],
  };

  it("suggests higher parallelism when minimising makespan", () => {
    const result = handleGraphOptimize(
      GraphOptimizeInputSchema.parse({
        graph: GRAPH,
        parallelism: 1,
        max_parallelism: 3,
        explore_parallelism: [2, 3],
        objective: { type: "makespan" },
      }),
    );

    expect(result.objective.type).to.equal("makespan");
    expect(result.projections.some((p) => p.parallelism === 3 && p.objective_value === 5)).to.equal(
      true,
    );
    const suggestion = result.suggestions.find((item) => item.type === "increase_parallelism");
    expect(suggestion).to.not.be.undefined;
    expect(suggestion?.impact.projected_objective).to.equal(5);
    expect(suggestion?.impact.objective_label).to.equal("makespan");
  });

  it("keeps baseline parallelism when minimising cost with penalties", () => {
    const result = handleGraphOptimize(
      GraphOptimizeInputSchema.parse({
        graph: GRAPH,
        parallelism: 1,
        max_parallelism: 3,
        explore_parallelism: [2, 3],
        objective: { type: "cost", attribute: "cost", default_value: 2, parallel_penalty: 10 },
      }),
    );

    expect(result.objective.type).to.equal("cost");
    const baselineProjection = result.projections.find((entry) => entry.parallelism === 1);
    const highProjection = result.projections.find((entry) => entry.parallelism === 3);
    expect(baselineProjection?.objective_value).to.equal(18); // base 8 + penalty (10 * 1)
    expect(highProjection?.objective_value).to.equal(38); // base 8 + penalty (10 * 3)
    expect(result.suggestions.some((item) => item.type === "increase_parallelism")).to.equal(
      false,
    );
  });

  it("penalises concurrency when optimising for risk", () => {
    const result = handleGraphOptimize(
      GraphOptimizeInputSchema.parse({
        graph: GRAPH,
        parallelism: 1,
        max_parallelism: 3,
        explore_parallelism: [2, 3],
        objective: {
          type: "risk",
          attribute: "risk",
          default_value: 0.5,
          parallel_penalty: 2,
          concurrency_penalty: 1.5,
        },
      }),
    );

    // The risk objective aggregates per-node defaults then adds both a per-thread
    // penalty (parallelism - 1) and a concurrency penalty based on the simulated
    // maximum concurrent tasks. With a fan-out graph this ensures the optimiser
    // keeps conservative parallelism levels.
    expect(result.objective.type).to.equal("risk");
    expect(result.objective.attribute).to.equal("risk");

    const baseline = result.projections.find((entry) => entry.parallelism === 1);
    const aggressive = result.projections.find((entry) => entry.parallelism === 3);
    expect(baseline).to.not.equal(undefined);
    expect(aggressive).to.not.equal(undefined);
    // Default contributions: 4 nodes * 0.5 = 2 risk units. For parallelism=1 the
    // concurrency penalty = 1.5 * 1 while the parallelism penalty is null, so the
    // total stays at 3.5. At parallelism=3 the additional penalties raise the
    // objective value, proving the optimiser discourages higher concurrency.
    expect(baseline?.objective_value).to.equal(3.5);
    expect(aggressive?.objective_value).to.equal(10.5);

    // Because the baseline already minimises risk, no recommendation should try
    // to increase the parallelism further.
    expect(result.suggestions.some((item) => item.type === "increase_parallelism")).to.equal(
      false,
    );
  });
});

