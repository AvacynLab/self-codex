import { expect } from "chai";

import {
  GraphDescriptorPayload,
  GraphSimulateInputSchema,
  handleGraphSimulate,
} from "../src/tools/graphTools.js";

describe("graph_simulate", () => {
  it("resolves durations with fallbacks and reports schedule metrics", () => {
    const graph: GraphDescriptorPayload = {
      name: "review_pipeline",
      nodes: [
        { id: "draft", attributes: { duration: 2 } },
        { id: "analysis", attributes: { estimate: "3" } },
        { id: "review", attributes: {} },
        { id: "publish", attributes: { duration: 1 } },
      ],
      edges: [
        { from: "draft", to: "analysis", attributes: {} },
        { from: "draft", to: "review", attributes: {} },
        { from: "analysis", to: "publish", attributes: {} },
        { from: "review", to: "publish", attributes: {} },
      ],
    };

    const input = GraphSimulateInputSchema.parse({
      graph,
      parallelism: 2,
      duration_attribute: "duration",
      fallback_duration_attribute: "estimate",
      default_duration: 5,
    });

    const result = handleGraphSimulate(input);

    expect(result.metrics.makespan).to.equal(8);
    expect(result.metrics.max_concurrency).to.equal(2);
    expect(result.queue).to.deep.equal([]);
    expect(result.schedule.map((entry) => ({ id: entry.node_id, duration: entry.duration }))).to.deep.equal([
      { id: "draft", duration: 2 },
      { id: "analysis", duration: 3 },
      { id: "review", duration: 5 },
      { id: "publish", duration: 1 },
    ]);
    expect(result.warnings).to.include(
      "node 'review' missing duration attribute, using default 5",
    );
  });

  it("captures queue events when parallelism is saturated", () => {
    const graph: GraphDescriptorPayload = {
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

    const result = handleGraphSimulate(
      GraphSimulateInputSchema.parse({ graph, parallelism: 1 }),
    );

    expect(result.metrics.makespan).to.equal(13);
    expect(result.queue).to.have.length(2);
    expect(result.queue[0].node_id).to.equal("task2");
    expect(result.queue[1].wait).to.equal(8);
    expect(result.warnings[0]).to.match(/detected 2 queue event\(s\)/);
  });
});

