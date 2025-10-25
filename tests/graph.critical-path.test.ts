import { expect } from "chai";

import { GraphCriticalPathInputSchema, handleGraphCriticalPath } from "../src/tools/graph/query.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

describe("graph_critical_path", () => {
  it("returns critical path information for a DAG", () => {
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

    const result = handleGraphCriticalPath(
      GraphCriticalPathInputSchema.parse({ graph, duration_attribute: "duration" }),
    );

    expect(result.duration).to.equal(9);
    expect(result.critical_path).to.deep.equal(["A", "B", "D"]);
    expect(result.earliest_start).to.deep.equal({ A: 0, B: 2, C: 2, D: 5 });
    expect(result.slack_by_node.C).to.equal(2);
    expect(result.warnings).to.deep.equal([]);
  });

  it("throws when cycles are present", () => {
    const cyclic: GraphDescriptorPayload = {
      name: "loop",
      nodes: [
        { id: "A", attributes: { duration: 1 } },
        { id: "B", attributes: { duration: 1 } },
      ],
      edges: [
        { from: "A", to: "B", attributes: {} },
        { from: "B", to: "A", attributes: {} },
      ],
    };

    expect(() =>
      handleGraphCriticalPath(
        GraphCriticalPathInputSchema.parse({ graph: cyclic, duration_attribute: "duration" }),
      ),
    ).to.throw(/graph contains cycles/);
  });
});

