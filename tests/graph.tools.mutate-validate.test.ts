import { describe, it } from "mocha";
import { expect } from "chai";

import {
  GraphMutateInputSchema,
  GraphSummarizeInputSchema,
  handleGraphGenerate,
  handleGraphMutate,
  handleGraphSummarize,
  handleGraphValidate,
} from "../src/tools/graphTools.js";
import type { GraphDescriptorPayload } from "../src/tools/graphTools.js";

describe("graph tools", () => {
  describe("graph_generate", () => {
    it("creates a deterministic pipeline from presets", () => {
      const result = handleGraphGenerate({ name: "preset", preset: "lint_test_build_package" });

      expect(result.task_count).to.equal(4);
      expect(result.graph.nodes.map((node) => node.id)).to.deep.equal([
        "lint",
        "test",
        "build",
        "package",
      ]);
      expect(result.graph.edges.map((edge) => `${edge.from}->${edge.to}`)).to.deep.equal([
        "lint->test",
        "test->build",
        "build->package",
      ]);
      expect(result.notes).to.deep.equal([]);
    });

    it("parses textual descriptions with implicit chaining", () => {
      const description = `
        draft: Draft requirements
        review -> draft
        implement -> review
        qa -> implement
      `;
      const result = handleGraphGenerate({ name: "custom", tasks: description, default_weight: 2 });

      expect(result.graph.nodes).to.have.length(4);
      expect(result.graph.edges).to.have.length(3);
      expect(result.graph.edges[0].weight).to.equal(2);
      expect(result.graph.edges.map((edge) => edge.attributes?.kind ?? null)).to.deep.equal([
        "dependency",
        "dependency",
        "dependency",
      ]);
    });
  });

  describe("graph_mutate", () => {
    it("applies idempotent operations on top of a generated graph", () => {
      const base = handleGraphGenerate({ name: "pipeline", preset: "lint_test_build_package" });
      const input = GraphMutateInputSchema.parse({
        graph: base.graph,
        operations: [
          { op: "add_node", node: { id: "security", label: "Security Review" } },
          { op: "add_edge", edge: { from: "build", to: "security", weight: 1 } },
          { op: "add_edge", edge: { from: "security", to: "package", weight: 1 } },
          { op: "rename_node", id: "lint", new_id: "linting" },
          { op: "set_node_attribute", id: "security", key: "owner", value: "sec-team" },
          { op: "remove_edge", from: "linting", to: "test" },
          { op: "add_edge", edge: { from: "linting", to: "test", weight: 1 } },
        ],
      });

      const mutated = handleGraphMutate(input);
      expect(mutated.graph.nodes.find((node) => node.id === "security")).to.not.be.undefined;
      expect(mutated.graph.nodes.find((node) => node.id === "linting")).to.not.be.undefined;
      const edges = mutated.graph.edges.map((edge) => `${edge.from}->${edge.to}`);
      expect(edges).to.include.members([
        "build->security",
        "security->package",
        "linting->test",
      ]);
      expect(mutated.applied.filter((entry) => entry.changed).length).to.equal(7);

      const repeated = handleGraphMutate(
        GraphMutateInputSchema.parse({ graph: mutated.graph, operations: input.operations }),
      );
      expect(repeated.graph.graph_version).to.equal(mutated.graph.graph_version);
      expect(repeated.graph.graph_id).to.equal(mutated.graph.graph_id);
      expect(repeated.graph.nodes).to.deep.equal(mutated.graph.nodes);
      expect(repeated.graph.edges).to.deep.equal(mutated.graph.edges);
    });

    it("keeps the graph version when mutations cancel out", () => {
      const base = handleGraphGenerate({ name: "baseline", preset: "lint_test_build_package" });
      const input = GraphMutateInputSchema.parse({
        graph: base.graph,
        operations: [
          // Ajout puis suppression de la même arête pour simuler une mutation
          // qui laisse l'état du graphe identique. Cela vérifie que le diff
          // structuré ne déclenche pas d'incrément de version inutile.
          { op: "add_edge", edge: { from: "lint", to: "package", weight: 1 } },
          { op: "remove_edge", from: "lint", to: "package" },
        ],
      });

      const result = handleGraphMutate(input);

      expect(result.graph.graph_version).to.equal(base.graph.graph_version);
      expect(result.graph.graph_id).to.equal(base.graph.graph_id);
      expect(result.graph.edges).to.deep.equal(base.graph.edges);
      expect(result.applied.map((entry) => entry.changed)).to.deep.equal([true, true]);
    });
  });

  describe("graph_validate", () => {
    it("detects missing nodes, invalid weights, and cycles", () => {
      const invalidGraph: GraphDescriptorPayload = {
        name: "invalid",
        nodes: [
          { id: "A", attributes: {} },
          { id: "B", attributes: {} },
          { id: "C", attributes: {} },
        ],
        edges: [
          { from: "A", to: "B", weight: 2, attributes: {} },
          { from: "B", to: "C", weight: -1, attributes: {} },
          { from: "C", to: "A", weight: 1, attributes: {} },
          { from: "C", to: "Z", weight: 1, attributes: {} },
        ],
      };

      const validation = handleGraphValidate({ graph: invalidGraph, strict_weights: true, cycle_limit: 5 });

      expect(validation.ok).to.equal(false);
      expect(validation.errors.some((issue) => issue.code === "MISSING_NODE")).to.equal(true);
      expect(validation.errors.some((issue) => issue.code === "INVALID_WEIGHT")).to.equal(true);
      expect(validation.warnings.some((issue) => issue.code === "CYCLE_DETECTED")).to.equal(true);
      expect(validation.metrics.node_count).to.equal(3);
      expect(validation.metrics.edge_count).to.equal(4);
    });
  });

  describe("graph_summarize", () => {
    it("provides layered summary and centrality scores", () => {
      const base = handleGraphGenerate({ name: "baseline", preset: "lint_test_build_package" });
      const mutated = handleGraphMutate(
        GraphMutateInputSchema.parse({
          graph: base.graph,
          operations: [
            { op: "add_edge", edge: { from: "lint", to: "package", weight: 1 } },
          ],
        }),
      );

      const summary = handleGraphSummarize(
        GraphSummarizeInputSchema.parse({ graph: mutated.graph, include_centrality: true }),
      );

      expect(summary.metrics.node_count).to.equal(4);
      expect(summary.layers[0].nodes).to.include("lint");
      expect(summary.layers.at(-1)?.nodes).to.include("package");
      expect(summary.critical_nodes[0].node).to.be.oneOf(["test", "build"]);
      expect(summary.metrics.density).to.be.greaterThan(0.0);
    });
  });
});
