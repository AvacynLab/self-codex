import { describe, it } from "mocha";
import { expect } from "chai";

import { handlePlanDryRun, type PlanDryRunInput, type PlanToolContext } from "../src/tools/planTools.js";
import { ValueGraph } from "../src/values/valueGraph.js";
import { createPlanToolContext, type PlanToolContextOverrides } from "./helpers/planContext.js";

/**
 * Unit coverage for the plan dry-run helper to ensure rewrite previews are produced alongside
 * value guard projections when hierarchical graphs are supplied.
 */
describe("plan dry-run", () => {
  function buildContext(overrides: PlanToolContextOverrides = {}): PlanToolContext {
    return createPlanToolContext(overrides);
  }

  it("returns a rewrite preview when a parallel edge is present", () => {
    const context = buildContext();
    const result = handlePlanDryRun(context, {
      plan_id: "plan-rewrite",
      plan_label: "Rewrite Preview",
      threshold: null,
      graph: {
        graph_id: "graph-rewrite",
        graph_version: 1,
        nodes: [
          { id: "start", label: "Start", attributes: { kind: "root" } },
          { id: "task", label: "Task", attributes: { kind: "task", node_id: "task" } },
        ],
        edges: [
          {
            from: "start",
            to: "task",
            label: "edge",
            weight: 1,
            attributes: { parallel: true },
          },
        ],
        metadata: {},
      },
      nodes: [],
      impacts: [],
    });

    expect(result.rewrite_preview).to.not.equal(null);
    const preview = result.rewrite_preview!;
    expect(preview.applied).to.be.greaterThan(0);
    const appliedRules = preview.history.filter((entry) => entry.applied > 0).map((entry) => entry.rule);
    expect(appliedRules).to.include("split-parallel");
    expect(preview.graph.edges.some((edge) => edge.attributes.rewritten_split_parallel === true)).to.equal(true);
  });

  it("expands inline subgraphs and records the rewrite history", () => {
    const context = buildContext();
    const subgraph = {
      name: "child",
      graph_id: "child",
      graph_version: 1,
      nodes: [
        { id: "entry", label: "Entry", attributes: { kind: "task" } },
        { id: "exit", label: "Exit", attributes: { kind: "task" } },
      ],
      edges: [
        { from: "entry", to: "exit", label: "flow", attributes: {} },
      ],
      metadata: {},
    } as const;

    const result = handlePlanDryRun(context, {
      plan_id: "plan-inline",
      plan_label: "Inline Preview",
      graph: {
        name: "parent",
        graph_id: "parent",
        graph_version: 1,
        nodes: [
          { id: "root", label: "Root", attributes: { kind: "task" } },
          { id: "sub", label: "Sub", attributes: { kind: "subgraph", ref: "child" } },
          { id: "sink", label: "Sink", attributes: { kind: "task" } },
        ],
        edges: [
          { from: "root", to: "sub", label: "enter", attributes: {} },
          { from: "sub", to: "sink", label: "leave", attributes: {} },
        ],
        metadata: {
          "hierarchy:subgraphs": JSON.stringify({
            child: { graph: subgraph, entryPoints: ["entry"], exitPoints: ["exit"] },
          }),
        },
      },
      nodes: [],
      impacts: [],
    });

    expect(result.rewrite_preview).to.not.equal(null);
    const preview = result.rewrite_preview!;
    const inlineHistory = preview.history.find((entry) => entry.rule === "inline-subgraph");
    expect(inlineHistory?.applied).to.be.greaterThan(0);
    const nodeIds = preview.graph.nodes.map((node) => node.id);
    expect(nodeIds).to.include("sub/entry");
    expect(nodeIds).to.include("sub/exit");
    expect(nodeIds).to.not.include("sub");
  });

  it("bypasses avoided nodes using rewrite hints derived from the graph", () => {
    const context = buildContext();
    const result = handlePlanDryRun(context, {
      plan_id: "plan-reroute",
      plan_label: "Reroute Preview",
      graph: {
        name: "reroute",
        graph_id: "reroute",
        graph_version: 1,
        nodes: [
          { id: "start", label: "Start", attributes: { kind: "task" } },
          { id: "avoid", label: "Avoid", attributes: { kind: "task", avoid: true } },
          { id: "safe", label: "Safe", attributes: { kind: "task" } },
          { id: "end", label: "End", attributes: { kind: "task" } },
        ],
        edges: [
          { from: "start", to: "avoid", label: "enter", attributes: {} },
          { from: "avoid", to: "safe", label: "branch", attributes: {} },
          { from: "avoid", to: "end", label: "finish", attributes: {} },
          { from: "safe", to: "end", label: "close", attributes: {} },
        ],
        metadata: {},
      },
      nodes: [],
      impacts: [],
    });

    expect(result.rewrite_preview).to.not.equal(null);
    const preview = result.rewrite_preview!;
    const rerouteHistory = preview.history.find((entry) => entry.rule === "reroute-avoid");
    expect(rerouteHistory?.applied).to.be.greaterThan(0);
    const nodeIds = preview.graph.nodes.map((node) => node.id);
    expect(nodeIds).to.not.include("avoid");
    const bypassEdges = preview.graph.edges.filter((edge) => edge.attributes.rewritten_reroute_avoid === true);
    expect(bypassEdges.length).to.be.greaterThan(0);
    const edgePairs = bypassEdges.map((edge) => `${edge.from}->${edge.to}`);
    expect(edgePairs).to.include("start->safe");
    expect(edgePairs).to.include("start->end");
    expect(result.reroute_avoid).to.not.equal(null);
    expect(result.reroute_avoid?.node_ids).to.deep.equal(["avoid"]);
    expect(result.reroute_avoid?.labels).to.deep.equal(["Avoid"]);
  });

  it("honours explicit reroute avoid hints supplied by the caller", () => {
    const context = buildContext();
    const result = handlePlanDryRun(context, {
      plan_id: "plan-manual-reroute",
      graph: {
        name: "manual",
        graph_id: "manual",
        graph_version: 1,
        nodes: [
          { id: "start", label: "Start", attributes: { kind: "task" } },
          { id: "manual-risk", label: "Risky", attributes: { kind: "task" } },
          { id: "finish", label: "Finish", attributes: { kind: "task" } },
        ],
        edges: [
          { from: "start", to: "manual-risk", label: "to-risk", attributes: {} },
          { from: "manual-risk", to: "finish", label: "to-finish", attributes: {} },
        ],
        metadata: {},
      },
      reroute_avoid: {
        node_ids: ["manual-risk"],
        labels: ["Risky"],
      },
    });

    expect(result.rewrite_preview).to.not.equal(null);
    const preview = result.rewrite_preview!;
    const rerouteHistory = preview.history.find((entry) => entry.rule === "reroute-avoid");
    expect(rerouteHistory?.applied).to.be.greaterThan(0);
    const bypassEdges = preview.graph.edges.filter((edge) => edge.attributes.rewritten_reroute_avoid === true);
    expect(bypassEdges.map((edge) => `${edge.from}->${edge.to}`)).to.include("start->finish");
    expect(result.reroute_avoid).to.not.equal(null);
    expect(result.reroute_avoid?.node_ids).to.deep.equal(["manual-risk"]);
    expect(result.reroute_avoid?.labels).to.deep.equal(["Risky"]);
  });

  it("sanitises hierarchical graphs and empty reroute hints before computing previews", () => {
    const context = buildContext();
    const result = handlePlanDryRun(context, {
      plan_id: "plan-hierarchical-sanitise",
      plan_label: "Hierarchical Sanitise",
      graph: {
        id: "hierarchical-root",
        nodes: [
          { id: "root", kind: "task", attributes: { bt_tool: "noop" } },
          { id: "leaf", kind: "task", attributes: { bt_tool: "noop" } },
        ],
        edges: [
          {
            id: "edge-root-leaf",
            from: { nodeId: "root" },
            to: { nodeId: "leaf" },
          },
        ],
      },
      rewrite: {},
      reroute_avoid: {},
    } as PlanDryRunInput);

    expect(result.compiled_tree).to.not.equal(null);
    expect(result.compiled_tree?.id).to.equal("hierarchical-root");
    const rootNode = result.compiled_tree?.root;
    expect(rootNode).to.not.equal(undefined);
    if (rootNode?.type === "sequence") {
      for (const child of rootNode.children) {
        expect(child.type).to.equal("task");
      }
    } else {
      expect(rootNode?.type).to.equal("task");
    }
    expect(result.rewrite_preview).to.not.equal(null);
    expect(result.rewrite_preview?.history).to.be.an("array");
    expect(result.reroute_avoid).to.equal(null);
  });

  // Ensure aggregated impacts trigger the value guard so dry-run payloads include
  // a structured explanation with actionable hints tied to the originating node.
  it("explains value guard violations with actionable hints", () => {
    const valueGraph = new ValueGraph({ now: () => 123_456 });
    valueGraph.set({
      values: [
        {
          id: "safety",
          label: "Safety",
          weight: 1,
          tolerance: 0.2,
        },
      ],
    });

    const context = buildContext({ valueGuard: { graph: valueGraph, registry: new Map() } });

    const result = handlePlanDryRun(context, {
      plan_id: "plan-guard",
      plan_label: "Guarded Plan",
      threshold: 0.9,
      nodes: [
        {
          id: "risk-node",
          label: "Risk Node",
          value_impacts: [
            {
              value: "safety",
              impact: "risk",
              severity: 1,
              rationale: "Introduces a safety risk",
              source: "analysis",
            },
          ],
        },
      ],
    });

    expect(result.value_guard).to.not.equal(null);
    const guard = result.value_guard!;
    expect(guard.decision.allowed).to.equal(false);
    expect(guard.decision.threshold).to.equal(0.9);
    expect(guard.decision.violations).to.have.lengthOf(1);
    const violation = guard.violations[0]!;
    expect(violation.value).to.equal("safety");
    expect(violation.hint).to.be.a("string").that.is.not.empty;
    expect(violation.primaryContributor).to.not.equal(null);
    expect(violation.primaryContributor?.impact.nodeId).to.equal("risk-node");
    expect(result.impacts).to.deep.include({
      value: "safety",
      impact: "risk",
      severity: 1,
      rationale: "Introduces a safety risk",
      source: "analysis",
      nodeId: "risk-node",
    });
    expect(result.nodes).to.deep.include({
      id: "risk-node",
      label: "Risk Node",
      impacts: [
        {
          value: "safety",
          impact: "risk",
          severity: 1,
          rationale: "Introduces a safety risk",
          source: "analysis",
          nodeId: "risk-node",
        },
      ],
    });
  });
});
