import { strict as assert } from "node:assert";

import {
  handleGraphGenerate,
  handleGraphMutate,
  type GraphMutateResult,
} from "../../src/tools/graph/mutate.js";
import {
  handleGraphOptimize,
  handleGraphOptimizeMoo,
  handleGraphPathsConstrained,
  handleGraphPathsKShortest,
} from "../../src/tools/graph/query.js";
import {
  handleGraphHyperExport,
  type GraphDescriptorPayload,
} from "../../src/tools/graph/snapshot.js";

/**
 * Regression coverage guarding the omission of `undefined` optional properties
 * across the graph tooling layer. These checks backstop the gradual
 * activation of the TypeScript `exactOptionalPropertyTypes` flag by asserting
 * that runtime descriptors never persist dangling optional fields.
 */
describe("graph tooling optional fields", () => {
  function buildBaselineGraph(): GraphDescriptorPayload {
    return {
      name: "optional-fields",
      nodes: [
        { id: "alpha", attributes: {} },
        { id: "beta", attributes: {} },
        { id: "gamma", attributes: {} },
      ],
      edges: [
        { from: "alpha", to: "beta", weight: 2, attributes: { weight: 2 } },
        { from: "beta", to: "gamma", weight: 3, attributes: { weight: 3 } },
      ],
      metadata: {},
    } satisfies GraphDescriptorPayload;
  }

  it("omits optional node and edge fields when absent", () => {
    const baseline = buildBaselineGraph();
    const mutateResult: GraphMutateResult = handleGraphMutate({
      graph: baseline,
      operations: [
        { op: "add_node", node: { id: "delta", attributes: {} } },
        { op: "add_edge", edge: { from: "alpha", to: "delta", attributes: {} } },
      ],
    });

    const addedNode = mutateResult.graph.nodes.find((node) => node.id === "delta");
    assert.ok(addedNode, "the new node should be present in the descriptor");
    assert.strictEqual(Object.hasOwn(addedNode!, "label"), false);

    const addedEdge = mutateResult.graph.edges.find(
      (edge) => edge.from === "alpha" && edge.to === "delta",
    );
    assert.ok(addedEdge, "the new edge should connect alpha to delta");
    assert.strictEqual(Object.hasOwn(addedEdge!, "label"), false);
    assert.strictEqual(Object.hasOwn(addedEdge!, "weight"), false);
  });

  it("omits optional fields when generating graphs from textual tasks", () => {
    const generateResult = handleGraphGenerate({
      name: "textual", // Provide textual tasks without labels to trigger sanitisation.
      tasks: "alpha\nbeta->alpha",
    });

    const alpha = generateResult.graph.nodes.find((node) => node.id === "alpha");
    assert.ok(alpha, "alpha should be present after generation");
    assert.strictEqual(Object.hasOwn(alpha!, "label"), false);

    const beta = generateResult.graph.nodes.find((node) => node.id === "beta");
    assert.ok(beta, "beta should be present after generation");
    assert.strictEqual(Object.hasOwn(beta!, "label"), false);
  });

  it("preserves existing labels when updates omit them", () => {
    const baseline = buildBaselineGraph();
    baseline.nodes[0] = { id: "alpha", label: "Alpha", attributes: {} };

    const mutateResult = handleGraphMutate({
      graph: baseline,
      operations: [{ op: "add_node", node: { id: "alpha", attributes: { priority: 1 } } }],
    });

    const updatedNode = mutateResult.graph.nodes.find((node) => node.id === "alpha");
    assert.ok(updatedNode, "alpha should still exist after the merge");
    assert.strictEqual(updatedNode!.label, "Alpha");
    assert.strictEqual(updatedNode!.attributes.priority, 1);
  });

  it("computes graph paths without leaking optional parameters", () => {
    const baseline = buildBaselineGraph();

    const kShortest = handleGraphPathsKShortest({
      graph: baseline,
      from: "alpha",
      to: "gamma",
      k: 2,
      weight_attribute: "weight",
    });
    assert.ok(kShortest.paths.length >= 1, "at least one path should be returned");

    const constrained = handleGraphPathsConstrained({
      graph: baseline,
      from: "alpha",
      to: "gamma",
      weight_attribute: "weight",
      avoid_nodes: [],
      avoid_edges: [],
      max_cost: 4,
    });
    assert.strictEqual(constrained.status, "cost_exceeded");
    assert.strictEqual(Object.hasOwn(constrained, "max_cost"), true);
    assert.strictEqual(constrained.max_cost, 4);

    const unconstrained = handleGraphPathsConstrained({
      graph: baseline,
      from: "alpha",
      to: "gamma",
      weight_attribute: "weight",
      avoid_nodes: [],
      avoid_edges: [],
    });
    assert.strictEqual(Object.hasOwn(unconstrained, "max_cost"), false);
    assert.strictEqual(unconstrained.status, "found");
  });

  it("projects hyper-graphs without materialising undefined metadata", () => {
    const result = handleGraphHyperExport({
      id: "hyper-sample",
      nodes: [
        { id: "alpha", attributes: {} },
        { id: "beta", attributes: {} },
      ],
      hyper_edges: [
        {
          id: "edge-1",
          sources: ["alpha"],
          targets: ["beta"],
          // The handler should avoid persisting explicit undefined placeholders
          // when callers omit descriptive fields.
          attributes: {},
        },
      ],
    });

    assert.strictEqual(result.stats.hyper_edges, 1);
    assert.strictEqual(Object.hasOwn(result.graph.nodes[0], "label"), false);
    assert.strictEqual(Object.hasOwn(result.graph.edges[0], "label"), false);
    assert.strictEqual(Object.hasOwn(result.graph.edges[0], "weight"), false);
    // The hyper export helper defaults `graph_version` to `1` rather than leaving
    // it undefined, ensuring downstream clients never observe explicit
    // `undefined` placeholders once strict optional typing is enabled.
    assert.strictEqual(Object.hasOwn(result.graph, "graph_version"), true);
    assert.strictEqual(result.graph.graph_version, 1);
  });

  it("omits the objective attribute when optimising purely for makespan", () => {
    const baseline = buildBaselineGraph();

    const optimiseResult = handleGraphOptimize({
      graph: baseline,
      parallelism: 1,
      max_parallelism: 2,
      objective: { type: "makespan" },
    });

    assert.strictEqual(optimiseResult.objective.type, "makespan");
    assert.strictEqual(Object.hasOwn(optimiseResult.objective, "attribute"), false);
  });

  it("omits scalarization details when no weighting scheme is provided", () => {
    const baseline = buildBaselineGraph();

    const mooResult = handleGraphOptimizeMoo({
      graph: baseline,
      parallelism_candidates: [1, 2],
      objectives: [
        { type: "makespan" },
        { type: "cost", attribute: "cost" },
      ],
    });

    assert.strictEqual(Object.hasOwn(mooResult, "scalarization"), false);
    assert.ok(mooResult.pareto_front.length >= 1, "a Pareto frontier should be produced");
  });
});
