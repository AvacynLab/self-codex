import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphGenerateInputSchema, handleGraphGenerate } from "../src/tools/graph/mutate.js";
import { GraphSummarizeInputSchema, handleGraphSummarize } from "../src/tools/graph/query.js";

/**
 * Regression tests dedicated to the `graph_generate` and `graph_summarize`
 * tools. These scenarios focus on the richer behaviours that are easy to miss
 * when relying solely on preset pipelines (synthetic dependencies, metadata
 * propagation, layered summaries, …).
 */
describe("graph tools – generate & summarize", () => {
  describe("graph_generate", () => {
    it("merges presets with explicit tasks and synthesises missing dependencies", () => {
      const input = GraphGenerateInputSchema.parse({
        name: "release",
        preset: "lint_test_build_package",
        default_weight: 3,
        tasks: {
          tasks: [
            {
              id: "deploy",
              label: "Deploy",
              depends_on: ["package"],
              weight: 2,
              metadata: { owner: "ops" },
            },
            {
              id: "post", // depends on an undeclared node to trigger synthesis
              label: "Post-mortem",
              depends_on: ["deploy", "verify"],
            },
          ],
        },
      });

      const result = handleGraphGenerate(input);

      const nodeIds = result.graph.nodes.map((node) => node.id);
      expect(nodeIds).to.include.members(["lint", "deploy", "post", "verify"]);
      expect(result.task_count).to.equal(6, "synthetic nodes must not be counted as real tasks");

      const syntheticNode = result.graph.nodes.find((node) => node.id === "verify");
      expect(syntheticNode?.attributes?.synthetic).to.equal(true);

      const deployNode = result.graph.nodes.find((node) => node.id === "deploy");
      expect(deployNode?.attributes?.owner).to.equal("ops");
      expect(deployNode?.attributes?.weight).to.equal(2);

      const edgeMap = new Map(result.graph.edges.map((edge) => [`${edge.from}->${edge.to}`, edge] as const));
      expect(edgeMap.get("package->deploy")?.weight).to.equal(2);
      expect(edgeMap.get("deploy->post")?.weight).to.equal(3);
      expect(edgeMap.get("verify->post")?.weight).to.equal(3);
    });
  });

  describe("graph_summarize", () => {
    it("builds layered metrics and highlights critical nodes", () => {
      const generated = handleGraphGenerate(
        GraphGenerateInputSchema.parse({
          name: "release",
          preset: "lint_test_build_package",
          tasks: {
            tasks: [
              { id: "deploy", depends_on: ["package"], weight: 2 },
              { id: "post", depends_on: ["deploy", "verify"] },
            ],
          },
        }),
      );

      const summary = handleGraphSummarize(
        GraphSummarizeInputSchema.parse({ graph: generated.graph, include_centrality: true }),
      );

      expect(summary.metrics.node_count).to.equal(7);
      expect(summary.metrics.edge_count).to.be.greaterThan(0);
      expect(summary.metrics.entrypoints).to.include.members(["lint", "verify"]);
      expect(summary.metrics.sinks).to.include("post");
      expect(summary.metrics.isolated).to.deep.equal([]);
      expect(summary.layers[0].nodes).to.include.members(["lint", "verify"]);
      expect(summary.structure.components).to.have.length(1);
      expect(summary.critical_nodes.length).to.be.greaterThan(0);
      expect(summary.critical_nodes[0].score).to.be.greaterThan(0);
      expect(
        summary.critical_nodes.map((entry) => entry.node),
      ).to.include.oneOf(["test", "build", "package"]);
    });
  });
});
