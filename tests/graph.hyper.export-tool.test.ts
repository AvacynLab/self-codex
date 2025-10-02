import { describe, it } from "mocha";
import { expect } from "chai";

import {
  GraphHyperExportInputSchema,
  handleGraphHyperExport,
} from "../src/tools/graphTools.js";

/**
 * Exercises the hyper-graph export tool to ensure the projection preserves
 * metadata and reports useful statistics for downstream auditing.
 */
describe("graph hyper export tool", () => {
  it("projects hyper-edges and returns stable stats", () => {
    const input = {
      id: "workflow",
      nodes: [
        { id: "ingest", label: "Ingest", attributes: { kind: "source" } },
        { id: "analyze", label: "Analyze", attributes: { kind: "task" } },
        { id: "report", label: "Report", attributes: { kind: "sink" } },
      ],
      hyper_edges: [
        {
          id: "fanout",
          sources: ["ingest"],
          targets: ["analyze", "report"],
          label: "dispatch",
          weight: 2,
          attributes: { channel: "primary" },
        },
      ],
      metadata: { owner: "ops" },
      graph_version: 3,
    } as const;

    const result = handleGraphHyperExport(input);

    expect(result.stats.nodes).to.equal(3);
    expect(result.stats.hyper_edges).to.equal(1);
    expect(result.stats.edges).to.equal(2);
    expect(result.graph.graph_id).to.equal("workflow");
    expect(result.graph.graph_version).to.equal(3);
    expect(result.graph.metadata?.owner).to.equal("ops");

    const projectedLabels = result.graph.edges.map((edge) => edge.label);
    expect(projectedLabels).to.deep.equal(["dispatch", "dispatch"]);

    const pairIndexes = result.graph.edges.map(
      (edge) => edge.attributes?.hyper_edge_pair_index,
    );
    expect(pairIndexes).to.deep.equal([0, 1]);
  });

  it("rejects payloads missing nodes via schema validation", () => {
    const outcome = GraphHyperExportInputSchema.safeParse({
      id: "broken",
      nodes: [],
      hyper_edges: [],
    });
    expect(outcome.success).to.equal(false);
  });
});
