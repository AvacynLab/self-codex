import { describe, it } from "mocha";
import { expect } from "chai";

import { ValueGraph } from "../src/values/valueGraph.js";

/**
 * Unit coverage for the configuration helpers recently added to the value graph.
 * The scenarios ensure exported snapshots capture relationships and thresholds
 * and that restoring them leaves no residual state between tests.
 */
describe("value graph configuration helpers", () => {
  it("exports and restores configurations including relationships", () => {
    const graph = new ValueGraph({ now: () => 0 });

    graph.set({
      values: [
        { id: "privacy", weight: 1, tolerance: 0.2 },
        { id: "usability", weight: 0.5, tolerance: 0.5 },
      ],
      relationships: [{ from: "privacy", to: "usability", kind: "supports", weight: 0.4 }],
      defaultThreshold: 0.75,
    });

    const baseline = graph.exportConfiguration();
    expect(baseline).to.not.equal(null);
    expect(baseline?.defaultThreshold).to.equal(0.75);
    expect(baseline?.values.map((value) => value.id)).to.deep.equal(["privacy", "usability"]);
    expect(baseline?.relationships).to.deep.equal([
      { from: "privacy", to: "usability", kind: "supports", weight: 0.4 },
    ]);

    graph.set({
      values: [
        { id: "safety", weight: 1, tolerance: 0.1 },
      ],
      defaultThreshold: 0.9,
    });
    expect(graph.getDefaultThreshold()).to.equal(0.9);

    graph.restoreConfiguration(baseline);
    const restored = graph.exportConfiguration();
    expect(restored).to.not.equal(null);
    expect(restored?.defaultThreshold).to.equal(0.75);
    expect(restored?.values.map((value) => value.id)).to.deep.equal(["privacy", "usability"]);
    expect(restored?.relationships).to.deep.equal([
      { from: "privacy", to: "usability", kind: "supports", weight: 0.4 },
    ]);

    graph.restoreConfiguration(null);
    expect(graph.exportConfiguration()).to.equal(null);

    // After clearing the graph, a fresh configuration should start with the default threshold.
    graph.set({
      values: [{ id: "resilience", weight: 0.8, tolerance: 0.3 }],
    });
    expect(graph.getDefaultThreshold()).to.equal(0.6);
  });
});
