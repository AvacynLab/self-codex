/**
 * Validates the vendored Graph Forge primitives with Node's built-in test
 * runner. Keeping this suite inside the vendored directory ensures the
 * `test:graph-forge` script can exercise the module in isolation without
 * relying on the orchestrator's Mocha harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GraphModel, shortestPath } from "../src/index.js";

type AttributeBag = Record<string, number | string | boolean>;
type RuntimeGraphModel = InstanceType<typeof GraphModel>;

function buildDemoGraph(): RuntimeGraphModel {
  const nodes = [
    { id: "start", attributes: {} as AttributeBag },
    { id: "bridge", attributes: {} as AttributeBag },
    { id: "goal", attributes: {} as AttributeBag }
  ];
  const edges = [
    { from: "start", to: "bridge", attributes: { weight: 1 } as AttributeBag },
    { from: "bridge", to: "goal", attributes: { weight: 2 } as AttributeBag },
    { from: "start", to: "goal", attributes: { weight: 10 } as AttributeBag }
  ];
  return new GraphModel("demo", nodes, edges, new Map());
}

test("GraphModel exposes node metadata and adjacency", () => {
  const graph = buildDemoGraph();
  const nodeIds = graph.listNodes().map((node) => node.id);
  assert.deepStrictEqual(nodeIds, ["start", "bridge", "goal"], "nodes are preserved in insertion order");
  assert.strictEqual(graph.getOutgoing("bridge").length, 1, "bridge node only has one outgoing edge");
  assert.strictEqual(graph.getNode("missing"), undefined, "missing nodes resolve to undefined");
});

test("shortestPath respects custom edge weights", () => {
  const graph = buildDemoGraph();
  const result = shortestPath(graph, "start", "goal", { weightAttribute: "weight" });
  assert.deepStrictEqual(result.path, ["start", "bridge", "goal"], "the weighted route prefers the cheaper intermediate hop");
  assert.strictEqual(result.distance, 3, "the combined weight adds the two lighter edges");
});
