import { describe, it } from "mocha";
import { expect } from "chai";

import {
  PlanCompileBTInputSchema,
  PlanRunBTInputSchema,
  PlanRunReactiveInputSchema,
} from "../src/tools/planTools.js";
import { CausalExplainInputSchema } from "../src/tools/causalTools.js";
import {
  ValuesFilterInputSchema,
  ValuesSetInputSchema,
} from "../src/tools/valueTools.js";
import { GraphHyperExportInputSchema, handleGraphGenerate } from "../src/tools/graphTools.js";
import { ConsensusVoteInputSchema } from "../src/tools/coordTools.js";
import { GraphSubgraphExtractInputSchema } from "../src/server.js";

/**
 * Validation-focused regression tests ensuring the server-facing schemas reject
 * malformed payloads deterministically. Keeping those checks centralised avoids
 * relying on MCP integration tests to catch regressions.
 */
describe("server tool schemas", () => {
  it("rejects Behaviour Tree compilation payloads lacking a graph", () => {
    const result = PlanCompileBTInputSchema.safeParse({});
    expect(result.success).to.equal(false);
  });

  it("rejects Behaviour Tree compilation payloads with extraneous properties", () => {
    const generated = handleGraphGenerate({ name: "demo", preset: "lint_test_build_package" });
    const outcome = PlanCompileBTInputSchema.safeParse({
      graph: generated.graph,
      unexpected: true,
    });
    expect(outcome.success).to.equal(false);
  });

  it("rejects Behaviour Tree run payloads with an invalid timeout", () => {
    const definition = {
      id: "bt-test",
      root: { type: "task", node_id: "noop", tool: "noop" },
    };
    const result = PlanRunBTInputSchema.safeParse({
      tree: definition,
      timeout_ms: 0,
    });
    expect(result.success).to.equal(false);
  });

  it("rejects Behaviour Tree run payloads with extraneous properties", () => {
    const definition = {
      id: "bt-test",
      root: { type: "task", node_id: "noop", tool: "noop" },
    };
    const outcome = PlanRunBTInputSchema.safeParse({
      tree: definition,
      dry_run: true,
      unexpected: "flag",
    });
    expect(outcome.success).to.equal(false);
  });

  it("rejects reactive run payloads with a sub-interval tick budget", () => {
    const definition = {
      id: "bt-test",
      root: { type: "task", node_id: "noop", tool: "noop" },
    };
    const outcome = PlanRunReactiveInputSchema.safeParse({
      tree: definition,
      tick_ms: 5,
    });
    expect(outcome.success).to.equal(false);
  });

  it("rejects reactive run payloads with extraneous properties", () => {
    const definition = {
      id: "bt-test",
      root: { type: "task", node_id: "noop", tool: "noop" },
    };
    const result = PlanRunReactiveInputSchema.safeParse({
      tree: definition,
      tick_ms: 100,
      unexpected: true,
    });
    expect(result.success).to.equal(false);
  });

  it("rejects timeout decorators lacking both budget and category", () => {
    const definition = {
      id: "bt-test",
      root: {
        type: "timeout",
        child: { type: "task", node_id: "noop", tool: "noop" },
      },
    };
    const result = PlanRunBTInputSchema.safeParse({ tree: definition });
    expect(result.success).to.equal(false);
  });

  it("accepts timeout decorators using category-driven budgets", () => {
    const definition = {
      id: "bt-test",
      root: {
        type: "timeout",
        timeout_category: "analysis",
        complexity_score: 1.5,
        child: { type: "task", node_id: "noop", tool: "noop" },
      },
    };
    const result = PlanRunBTInputSchema.safeParse({ tree: definition });
    expect(result.success).to.equal(true);
  });

  it("rejects causal explanations without an outcome id", () => {
    const result = CausalExplainInputSchema.safeParse({ outcome_id: "" });
    expect(result.success).to.equal(false);
  });

  it("rejects value graph updates that omit node definitions", () => {
    const result = ValuesSetInputSchema.safeParse({ nodes: [] });
    expect(result.success).to.equal(false);
  });

  it("rejects value guard evaluations without impacts", () => {
    const result = ValuesFilterInputSchema.safeParse({
      impacts: [],
    });
    expect(result.success).to.equal(false);
  });

  it("rejects hyper-graph exports without hyper-edges", () => {
    const outcome = GraphHyperExportInputSchema.safeParse({
      id: "broken",
      nodes: [{ id: "only" }],
      hyper_edges: [],
    });
    expect(outcome.success).to.equal(false);
  });

  it("rejects subgraph extraction payloads carrying unknown properties", () => {
    const generated = handleGraphGenerate({ name: "subgraph", preset: "lint_test_build_package" });
    const nodeId = generated.graph.nodes[0]?.id ?? "lint";
    const result = GraphSubgraphExtractInputSchema.safeParse({
      graph: generated.graph,
      node_id: nodeId,
      run_id: "run-123",
      extra: "noop",
    });
    expect(result.success).to.equal(false);
  });

  it("rejects consensus votes lacking quorum when required", () => {
    const outcome = ConsensusVoteInputSchema.safeParse({
      votes: [
        { voter: "alpha", value: "x" },
        { voter: "beta", value: "y" },
      ],
      config: { mode: "quorum" },
    });
    expect(outcome.success).to.equal(false);
  });
});
