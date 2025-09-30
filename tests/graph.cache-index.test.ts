import { expect } from "chai";

import { GraphComputationCache } from "../src/graph/cache.js";
import { buildGraphAttributeIndex } from "../src/graph/index.js";
import type { NormalisedGraph } from "../src/graph/types.js";

describe("graph cache and index utilities", () => {
  it("caches results per graph/version and evicts least recently used entries", () => {
    // A small cache with capacity 2 makes it easy to validate the eviction
    // order and the graph/version scoping behaviour.
    const cache = new GraphComputationCache(2);
    const variantA = { foo: 1 };
    const variantB = { foo: 2 };
    const variantC = { foo: 3 };

    expect(cache.get("graph-alpha", 1, "op", variantA)).to.equal(undefined);

    cache.set("graph-alpha", 1, "op", variantA, { value: "A" });
    cache.set("graph-alpha", 1, "op", variantB, { value: "B" });
    expect(cache.get("graph-alpha", 1, "op", variantA)).to.deep.equal({ value: "A" });

    cache.set("graph-alpha", 1, "op", variantC, { value: "C" });
    expect(cache.get("graph-alpha", 1, "op", variantB)).to.equal(undefined);
    expect(cache.get("graph-alpha", 1, "op", variantC)).to.deep.equal({ value: "C" });

    cache.invalidateGraph("graph-alpha");
    expect(cache.get("graph-alpha", 1, "op", variantA)).to.equal(undefined);

    cache.set("graph-alpha", 1, "op", variantA, { value: "A" });
    expect(cache.get("graph-alpha", 2, "op", variantA)).to.equal(undefined);
  });

  it("indexes node attributes, degrees, and components", () => {
    // The toy graph exercises attribute indexing, degree aggregation, and
    // connected components in a single connected component.
    const graph: NormalisedGraph = {
      name: "toy",
      graphId: "graph-toy",
      graphVersion: 1,
      metadata: {},
      nodes: [
        { id: "A", attributes: { role: "entry" } },
        { id: "B", attributes: { role: "hub" } },
        { id: "C", attributes: { role: "sink" } },
      ],
      edges: [
        { from: "A", to: "B", attributes: { weight: 1 } },
        { from: "B", to: "C", attributes: { weight: 2 } },
      ],
    };

    const index = buildGraphAttributeIndex(graph);

    expect(index.entrypoints).to.deep.equal(["A"]);
    expect(index.sinks).to.deep.equal(["C"]);
    expect(index.isolated).to.deep.equal([]);
    expect(index.hubs[0]).to.equal("B");
    expect(index.components).to.deep.equal([["A", "B", "C"]]);

    const roleIndex = index.nodesByAttribute.get("role");
    expect(roleIndex?.get("entry")).to.deep.equal(["A"]);
    expect(roleIndex?.get("hub")).to.deep.equal(["B"]);
    expect(roleIndex?.get("sink")).to.deep.equal(["C"]);

    expect(index.degreeSummary.averageOut).to.equal(0.6667);
    expect(index.degreeSummary.maxOut).to.equal(1);
  });
});
