import { describe, it } from "mocha";
import { expect } from "chai";

import {
  GraphRewriteApplyInputSchema,
  handleGraphRewriteApply,
} from "../src/tools/graphTools.js";
import type { GraphDescriptorPayload } from "../src/tools/graphTools.js";

/**
 * Unit test suite covering the rewrite application tool. The scenarios exercise
 * both manual rule selection and adaptive orchestration while asserting that
 * graph identity remains stable for downstream transactions.
 */
describe("graph rewrite apply - tool behaviour", () => {
  it("splits parallel edges exactly once when requested manually", () => {
    const baseGraph: GraphDescriptorPayload = {
      name: "pipeline",
      graph_id: "g-manual",
      graph_version: 1,
      nodes: [
        { id: "build", label: "Build", attributes: { kind: "task" } },
        { id: "deploy", label: "Deploy", attributes: { kind: "task" } },
      ],
      edges: [
        {
          from: "build",
          to: "deploy",
          label: "build→deploy",
          attributes: { parallel: true },
        },
      ],
      metadata: {},
    };

    const input = GraphRewriteApplyInputSchema.parse({
      graph: baseGraph,
      mode: "manual" as const,
      rules: ["split_parallel"],
    });

    const result = handleGraphRewriteApply(input);

    expect(result.changed).to.equal(true);
    expect(result.total_applied).to.equal(1);
    expect(result.graph.graph_version).to.equal(2);
    expect(result.rules_invoked).to.deep.equal(["split-parallel"]);

    const branchNode = result.graph.nodes.find((node) => node.id.startsWith("build∥deploy"));
    expect(branchNode, "expected a synthetic branch node to be introduced").to.exist;
    expect(result.graph.edges).to.have.length(2);
    expect(
      result.graph.edges.some(
        (edge) => edge.from === "build" && edge.to === branchNode?.id && edge.attributes?.role === "fanout",
      ),
    ).to.equal(true);
    expect(
      result.graph.edges.some(
        (edge) => edge.from === branchNode?.id && edge.to === "deploy" && edge.attributes?.role === "branch",
      ),
    ).to.equal(true);
  });

  it("keeps the version stable when no rewrite matches", () => {
    const baseGraph: GraphDescriptorPayload = {
      name: "unchanged",
      graph_id: "g-static",
      graph_version: 3,
      nodes: [
        { id: "lint", label: "Lint", attributes: {} },
        { id: "test", label: "Test", attributes: {} },
      ],
      edges: [
        { from: "lint", to: "test", label: "lint→test", attributes: {} },
      ],
      metadata: {},
    };

    const input = GraphRewriteApplyInputSchema.parse({
      graph: baseGraph,
      mode: "manual" as const,
      rules: ["split_parallel"],
    });

    const result = handleGraphRewriteApply(input);

    expect(result.changed).to.equal(false);
    expect(result.total_applied).to.equal(0);
    expect(result.graph.graph_version).to.equal(3);
    expect(result.rules_invoked).to.deep.equal(["split-parallel"]);
    expect(result.graph.nodes.map((node) => node.id)).to.deep.equal(["lint", "test"]);
    expect(result.graph.edges).to.have.length(1);
    expect(result.graph.edges[0]).to.include({ from: "lint", to: "test", label: "lint→test" });
    expect(result.graph.edges[0].attributes?.rewritten_split_parallel ?? false).to.equal(false);
  });

  it("reroutes around weak nodes when guided by adaptive evaluation", () => {
    const baseGraph: GraphDescriptorPayload = {
      name: "adaptive",
      graph_id: "g-adaptive",
      graph_version: 5,
      nodes: [
        { id: "start", label: "Start", attributes: {} },
        { id: "review", label: "Review", attributes: {} },
        { id: "end", label: "End", attributes: {} },
      ],
      edges: [
        { from: "start", to: "review", label: "start→review", attributes: {} },
        { from: "review", to: "end", label: "review→end", attributes: {} },
      ],
      metadata: {},
    };

    const input = GraphRewriteApplyInputSchema.parse({
      graph: baseGraph,
      mode: "adaptive" as const,
      evaluation: {
        edges_to_boost: [],
        edges_to_prune: ["start→review"],
        insights: [
          {
            edge_key: "start→review",
            reinforcement: 0.1,
            confidence: 0.9,
            recommendation: "prune" as const,
            metrics: {
              successes: 0,
              failures: 3,
              total_duration_ms: 900,
              total_reward: 0,
              last_updated_at: 1_000,
              attempts: 3,
              success_rate: 0,
              average_duration_ms: 300,
            },
          },
        ],
      },
      options: { stop_on_no_change: true },
    });

    const result = handleGraphRewriteApply(input);

    expect(result.changed).to.equal(true);
    expect(result.total_applied).to.be.greaterThan(0);
    expect(result.graph.graph_version).to.equal(6);
    expect(result.rules_invoked).to.include("reroute-avoid");
    expect(result.graph.nodes.map((node) => node.id)).to.not.include("review");
    expect(
      result.graph.edges.some(
        (edge) =>
          edge.from === "start" &&
          edge.to === "end" &&
          edge.attributes?.rewritten_reroute_avoid === true &&
          edge.attributes?.avoided === "review",
      ),
    ).to.equal(true);
  });
});
