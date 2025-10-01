import { expect } from "chai";

import {
  GraphCriticalPathInputSchema,
  GraphOptimizeInputSchema,
  GraphSimulateInputSchema,
  handleGraphCriticalPath,
  handleGraphOptimize,
  handleGraphSimulate,
} from "../src/tools/graphTools.js";
import type { GraphDescriptorPayload } from "../src/tools/graphTools.js";

describe("graph simulate & optimize", () => {
  it("computes schedules, critical path flags, and queue metrics", () => {
    const graph: GraphDescriptorPayload = {
      name: "diamond",
      nodes: [
        { id: "A", attributes: { duration: 2 } },
        { id: "B", attributes: { duration: 3 } },
        { id: "C", attributes: { duration: 1 } },
        { id: "D", attributes: { duration: 4 } },
      ],
      edges: [
        { from: "A", to: "B", attributes: {} },
        { from: "A", to: "C", attributes: {} },
        { from: "B", to: "D", attributes: {} },
        { from: "C", to: "D", attributes: {} },
      ],
    };

    const simulation = handleGraphSimulate(
      GraphSimulateInputSchema.parse({
        graph,
        parallelism: 2,
        duration_attribute: "duration",
        default_duration: 1,
      }),
    );

    expect(simulation.metrics.makespan).to.equal(9);
    expect(simulation.metrics.max_concurrency).to.equal(2);
    expect(simulation.queue).to.have.length(0);

    const schedule = Object.fromEntries(simulation.schedule.map((entry) => [entry.node_id, entry]));
    expect(schedule.A.start).to.equal(0);
    expect(schedule.A.end).to.equal(2);
    expect(schedule.B.start).to.equal(2);
    expect(schedule.B.end).to.equal(5);
    expect(schedule.C.start).to.equal(2);
    expect(schedule.C.end).to.equal(3);
    expect(schedule.D.start).to.equal(5);
    expect(schedule.D.end).to.equal(9);

    expect(schedule.A.critical).to.equal(true);
    expect(schedule.B.critical).to.equal(true);
    expect(schedule.D.critical).to.equal(true);
    expect(schedule.C.critical).to.equal(false);
    expect(schedule.D.waiting_time).to.equal(0);
    expect(simulation.warnings).to.deep.equal([]);
  });

  it("keeps simulation makespan aligned with the critical path duration", () => {
    const graph: GraphDescriptorPayload = {
      name: "parallel_chain",
      nodes: [
        { id: "start", attributes: { duration: 1 } },
        { id: "branch_a", attributes: { duration: 4 } },
        { id: "branch_b", attributes: { duration: 2 } },
        { id: "merge", attributes: { duration: 3 } },
      ],
      edges: [
        { from: "start", to: "branch_a", attributes: {} },
        { from: "start", to: "branch_b", attributes: {} },
        { from: "branch_a", to: "merge", attributes: {} },
        { from: "branch_b", to: "merge", attributes: {} },
      ],
    };

    const simulation = handleGraphSimulate(
      GraphSimulateInputSchema.parse({ graph, parallelism: 2, duration_attribute: "duration" }),
    );
    const critical = handleGraphCriticalPath(
      GraphCriticalPathInputSchema.parse({ graph, duration_attribute: "duration" }),
    );

    expect(simulation.metrics.makespan).to.equal(critical.duration);

    const criticalNodes = [...critical.critical_path].sort();
    const flagged = simulation.schedule
      .filter((entry) => entry.critical)
      .map((entry) => entry.node_id)
      .sort();
    expect(flagged).to.deep.equal(criticalNodes);
  });

  it("suggests parallelism improvements and exposes queue diagnostics", () => {
    const graph: GraphDescriptorPayload = {
      name: "fanout",
      nodes: [
        { id: "root", attributes: { duration: 1 } },
        { id: "task1", attributes: { duration: 2 } },
        { id: "task2", attributes: { duration: 2 } },
        { id: "task3", attributes: { duration: 2 } },
      ],
      edges: [
        { from: "root", to: "task1", attributes: {} },
        { from: "root", to: "task2", attributes: {} },
        { from: "root", to: "task3", attributes: {} },
      ],
    };

    const simulation = handleGraphSimulate(
      GraphSimulateInputSchema.parse({ graph, parallelism: 1, duration_attribute: "duration" }),
    );
    expect(simulation.metrics.makespan).to.equal(7);
    expect(simulation.queue).to.have.length(2);
    expect(simulation.queue[0].node_id).to.equal("task2");
    expect(simulation.queue[1].wait).to.equal(4);
    expect(simulation.warnings[0]).to.match(/queue event/);

    const optimization = handleGraphOptimize(
      GraphOptimizeInputSchema.parse({ graph, parallelism: 1, max_parallelism: 3 }),
    );

    expect(optimization.baseline.metrics.makespan).to.equal(7);
    const projection = optimization.projections.find((entry) => entry.parallelism === 3);
    expect(projection).to.not.be.undefined;
    expect(projection?.makespan).to.equal(3);
    expect(optimization.suggestions.some((suggestion) => suggestion.type === "increase_parallelism")).to.equal(
      true,
    );
    expect(optimization.critical_path.nodes).to.include("root");
    expect(optimization.warnings.length).to.be.greaterThan(0);
  });
});
