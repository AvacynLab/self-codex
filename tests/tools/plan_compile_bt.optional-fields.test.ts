import { strict as assert } from "node:assert";

import {
  __testing as planToolsTesting,
  handlePlanCompileBT,
  PlanCompileBTInputSchema,
} from "../../src/tools/planTools.js";
import { createPlanToolContext } from "../helpers/planContext.js";

/**
 * Recursively detect `undefined` values nested within a compiled structure. The
 * helper mirrors the assertions used in other optional-field regressions so the
 * tests can fail with a clear signal if sanitisation regresses in the future.
 */
function containsUndefined(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsUndefined);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsUndefined);
  }
  return false;
}

/**
 * Regression suite ensuring the Behaviour Tree compiler entry point continues to
 * strip optional properties that callers omit from hierarchical graph payloads.
 * The sanitisation mirrors the behaviour exercised by the dry-run helpers and
 * keeps the upcoming `exactOptionalPropertyTypes` activation from surfacing
 * `undefined` placeholders within compiled artefacts.
 */
describe("plan_compile_bt optional fields", () => {
  it("sanitises hierarchical graph nodes and edges before compilation", () => {
    const { graph } = PlanCompileBTInputSchema.parse({
      graph: {
        id: "hier-sanitise",
        nodes: [
          {
            id: "root",
            kind: "task",
            label: undefined,
            attributes: { priority: 1, bt_tool: "noop" },
            inputs: undefined,
            outputs: ["out"],
          },
          {
            id: "child-subgraph",
            kind: "subgraph",
            ref: "childGraph",
            params: undefined,
          },
          {
            id: "leaf",
            kind: "task",
            label: "Leaf",
            attributes: { priority: 2, bt_tool: "noop" },
          },
        ],
        edges: [
          {
            id: "root->leaf",
            from: { nodeId: "root", port: undefined },
            to: { nodeId: "leaf", port: undefined },
            label: undefined,
            attributes: undefined,
          },
          {
            id: "root->subgraph",
            from: { nodeId: "root", port: "exit" },
            to: { nodeId: "child-subgraph", port: "entry" },
            label: "handoff",
            attributes: { pathway: "primary" },
          },
        ],
      },
    });

    const sanitised = planToolsTesting.sanitiseHierGraphInput(graph);

    const [rootNode, subgraphNode, leafNode] = sanitised.nodes;
    assert.ok(rootNode, "root node should be present after sanitisation");
    assert.strictEqual(Object.hasOwn(rootNode!, "label"), false);
    assert.strictEqual(Object.hasOwn(rootNode!, "inputs"), false);
    assert.deepStrictEqual(rootNode!.outputs, ["out"]);

    assert.ok(subgraphNode, "subgraph node should be present after sanitisation");
    assert.strictEqual(Object.hasOwn(subgraphNode!, "params"), false);

    assert.ok(leafNode, "leaf node should be present after sanitisation");
    assert.strictEqual(leafNode!.label, "Leaf");

    const minimalEdge = sanitised.edges.find((edge) => edge.id === "root->leaf");
    assert.ok(minimalEdge, "expected the minimal edge to remain present");
    assert.strictEqual(Object.hasOwn(minimalEdge!, "label"), false);
    assert.strictEqual(Object.hasOwn(minimalEdge!, "attributes"), false);
    assert.strictEqual(Object.hasOwn(minimalEdge!.from, "port"), false);
    assert.strictEqual(Object.hasOwn(minimalEdge!.to, "port"), false);

    const labelledEdge = sanitised.edges.find((edge) => edge.id === "root->subgraph");
    assert.ok(labelledEdge, "expected the labelled edge to remain present");
    assert.strictEqual(labelledEdge!.label, "handoff");
    assert.deepStrictEqual(labelledEdge!.attributes, { pathway: "primary" });
    assert.strictEqual(labelledEdge!.from.port, "exit");
    assert.strictEqual(labelledEdge!.to.port, "entry");
  });

  it("compiles hierarchical graphs carrying optional fields without leaking undefined payloads", () => {
    const context = createPlanToolContext();
    const { graph } = PlanCompileBTInputSchema.parse({
      graph: {
        id: "hier-compile",
        nodes: [
          {
            id: "root",
            kind: "task",
            label: undefined,
            attributes: { priority: 1, bt_tool: "noop" },
            outputs: ["out"],
          },
          {
            id: "child",
            kind: "task",
            label: "Child",
            attributes: { priority: 2, bt_tool: "noop" },
          },
        ],
        edges: [
          {
            id: "root->child",
            from: { nodeId: "root", port: undefined },
            to: { nodeId: "child", port: undefined },
            label: undefined,
            attributes: undefined,
          },
        ],
      },
    });

    const compiled = handlePlanCompileBT(context, { graph });

    assert.strictEqual(compiled.id, "hier-compile");
    const rootType = compiled.root.type;
    assert.ok(rootType === "sequence" || rootType === "task", "root node should be executable");
    assert.strictEqual(containsUndefined(compiled), false);
  });
});
