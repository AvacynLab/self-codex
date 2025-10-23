import { describe, it } from "mocha";
import { expect } from "chai";

import {
  applyAll,
  createSplitParallelRule,
  createInlineSubgraphRule,
  createRerouteAvoidRule,
} from "../src/graph/rewrite.js";
import { applyGraphPatch } from "../src/graph/patch.js";
import { SUBGRAPH_REGISTRY_KEY, stringifySubgraphRegistry } from "../src/graph/subgraphRegistry.js";
import type { NormalisedGraph } from "../src/graph/types.js";
import type { JsonPatchOperation } from "../src/graph/diff.js";

/**
 * Regression coverage ensuring the graph rewrite pipeline and patch helpers
 * never persist optional fields with explicit `undefined` values. The suite
 * mirrors the sanitisation applied while enabling
 * `exactOptionalPropertyTypes`.
 */
describe("graph rewrite optional fields", () => {
  function baseGraph(): NormalisedGraph {
    return {
      name: "optional",
      graphId: "g-optional",
      graphVersion: 1,
      metadata: {},
      nodes: [
        { id: "alpha", attributes: {} },
        { id: "beta", attributes: {} },
        { id: "gamma", attributes: {} },
      ],
      edges: [
        { from: "alpha", to: "beta", attributes: { mode: "parallel" } },
        { from: "beta", to: "gamma", attributes: {} },
      ],
    } satisfies NormalisedGraph;
  }

  it("omits labels and weights when splitting parallel edges", () => {
    const graph = baseGraph();
    const { graph: rewritten } = applyAll(graph, [createSplitParallelRule()]);

    const rewrittenEdges = rewritten.edges.filter((edge) => edge.attributes.rewritten_split_parallel === true);
    expect(rewrittenEdges).to.have.lengthOf(2);
    for (const edge of rewrittenEdges) {
      expect(Object.hasOwn(edge, "label"), "split edges should not expose labels when absent").to.equal(false);
      expect(Object.hasOwn(edge, "weight"), "split edges should not expose weights when absent").to.equal(false);
    }
  });

  it("keeps rewired inline-subgraph edges free from undefined placeholders", () => {
    const embedded: NormalisedGraph = {
      name: "module",
      graphId: "module",
      graphVersion: 1,
      metadata: {},
      nodes: [
        { id: "entry", attributes: {} },
        { id: "exit", attributes: {} },
      ],
      edges: [{ from: "entry", to: "exit", attributes: {} }],
    };

    const registry = stringifySubgraphRegistry(
      new Map([["module-ref", { graph: embedded, entryPoints: ["entry"], exitPoints: ["exit"] }]]),
    );

    const graph: NormalisedGraph = {
      name: "inline",
      graphId: "inline",
      graphVersion: 1,
      metadata: { [SUBGRAPH_REGISTRY_KEY]: registry },
      nodes: [
        { id: "source", attributes: {} },
        { id: "module", attributes: { kind: "subgraph", ref: "module-ref" } },
        { id: "sink", attributes: {} },
      ],
      edges: [
        { from: "source", to: "module", attributes: {} },
        { from: "module", to: "sink", attributes: {} },
      ],
    };

    const { graph: rewritten } = applyAll(graph, [createInlineSubgraphRule()]);
    const rewiredEdges = rewritten.edges.filter((edge) => edge.attributes.via === "module");
    expect(rewiredEdges).to.not.be.empty;
    for (const edge of rewiredEdges) {
      expect(Object.hasOwn(edge, "label"), "rewired edges should omit labels when none exist").to.equal(false);
      expect(Object.hasOwn(edge, "weight"), "rewired edges should omit weights when none exist").to.equal(false);
    }
  });

  it("removes optional fields when bypassing avoided nodes", () => {
    const graph: NormalisedGraph = {
      name: "avoid",
      graphId: "avoid",
      graphVersion: 1,
      metadata: {},
      nodes: [
        { id: "start", attributes: {} },
        { id: "avoid", attributes: { risk: true } },
        { id: "end", attributes: {} },
      ],
      edges: [
        { from: "start", to: "avoid", attributes: {} },
        { from: "avoid", to: "end", attributes: {} },
      ],
    };

    const { graph: rewritten } = applyAll(
      graph,
      [createRerouteAvoidRule({ avoidNodeIds: new Set(["avoid"]) })],
    );

    const bypassEdges = rewritten.edges.filter((edge) => edge.attributes.rewritten_reroute_avoid === true);
    expect(bypassEdges).to.have.lengthOf(1);
    const bypass = bypassEdges[0]!;
    expect(Object.hasOwn(bypass, "label"), "bypass edge should not expose a label when none existed").to.equal(false);
    expect(Object.hasOwn(bypass, "weight"), "bypass edge should not expose a weight when none existed").to.equal(false);
  });

  it("strips null placeholders when applying graph patches", () => {
    const graph = baseGraph();
    const patch: JsonPatchOperation[] = [
      { op: "add", path: "/nodes/-", value: { id: "delta", label: null, attributes: {} } },
      {
        op: "add",
        path: "/edges/-",
        value: { from: "alpha", to: "delta", label: null, weight: null, attributes: {} },
      },
    ];

    const patched = applyGraphPatch(graph, patch);
    const delta = patched.nodes.find((node) => node.id === "delta");
    expect(delta).to.not.be.undefined;
    expect(Object.hasOwn(delta!, "label"), "patches should drop null node labels").to.equal(false);

    const newEdge = patched.edges.find((edge) => edge.from === "alpha" && edge.to === "delta");
    expect(newEdge).to.not.be.undefined;
    expect(Object.hasOwn(newEdge!, "label"), "patches should drop null edge labels").to.equal(false);
    expect(Object.hasOwn(newEdge!, "weight"), "patches should drop null edge weights").to.equal(false);
  });
});
