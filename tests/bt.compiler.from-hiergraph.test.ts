import { describe, it } from "mocha";
import { expect } from "chai";

import { compileHierGraphToBehaviorTree } from "../src/executor/bt/compiler.js";
import type { HierGraph } from "../src/graph/hierarchy.js";

/**
 * Unit tests verifying the compilation of hierarchical graphs to Behaviour Tree
 * definitions. The scenarios keep the graphs intentionally small to favour
 * determinism and readability.
 */
describe("behaviour tree compiler", () => {
  it("transforms a linear graph into a sequence of task leaves", () => {
    const graph: HierGraph = {
      id: "pipeline",
      nodes: [
        { id: "fetch", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "fetch" } },
        { id: "build", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "build" } },
        { id: "deploy", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "deploy" } },
      ],
      edges: [
        { id: "e1", from: { nodeId: "fetch" }, to: { nodeId: "build" } },
        { id: "e2", from: { nodeId: "build" }, to: { nodeId: "deploy" } },
      ],
    };

    const compiled = compileHierGraphToBehaviorTree(graph);
    expect(compiled.id).to.equal("pipeline");
    expect(compiled.root.type).to.equal("sequence");
    if (compiled.root.type !== "sequence") {
      return;
    }
    expect(compiled.root.children).to.have.length(3);
    expect(compiled.root.children.map((child) => child.type)).to.deep.equal([
      "task",
      "task",
      "task",
    ]);
    const toolNames = compiled.root.children.map((child) =>
      child.type === "task" ? child.tool : "",
    );
    expect(toolNames).to.deep.equal(["noop", "noop", "noop"]);
  });

  it("detects cycles and raises an error", () => {
    const graph: HierGraph = {
      id: "cycle",
      nodes: [
        { id: "a", kind: "task", attributes: { bt_tool: "noop" } },
        { id: "b", kind: "task", attributes: { bt_tool: "noop" } },
      ],
      edges: [
        { id: "e1", from: { nodeId: "a" }, to: { nodeId: "b" } },
        { id: "e2", from: { nodeId: "b" }, to: { nodeId: "a" } },
      ],
    };

    expect(() => compileHierGraphToBehaviorTree(graph)).to.throw(
      /contains cycles/i,
    );
  });
});
