import { describe, it } from "mocha";
import { expect } from "chai";

import { applyGraphPatch } from "../src/graph/patch.js";
import type { NormalisedGraph } from "../src/graph/types.js";

describe("graph patch optional field sanitisation", () => {
  it("normalises null labels and weights to undefined", () => {
    const base: NormalisedGraph = {
      name: "demo",
      graphId: "g-1",
      graphVersion: 1,
      metadata: {},
      nodes: [
        { id: "start", label: "Start", attributes: {} },
        { id: "end", label: "End", attributes: {} },
      ],
      edges: [
        { from: "start", to: "end", label: "edge", weight: 1, attributes: {} },
      ],
    };

    const patched = applyGraphPatch(base, [
      { op: "replace", path: "/nodes/0/label", value: null },
      { op: "replace", path: "/edges/0/weight", value: null },
    ]);

    expect(patched.nodes[0]?.label).to.equal(undefined);
    expect(patched.edges[0]?.weight).to.equal(undefined);
  });
});
