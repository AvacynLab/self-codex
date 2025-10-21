import { describe, it } from "mocha";
import { expect } from "chai";

import { ValueGraph, VALUE_GRAPH_LIMITS } from "../src/values/valueGraph.js";

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

  it("omits undefined optional fields when normalising configurations", () => {
    const graph = new ValueGraph({ now: () => 0 });

    graph.set({
      values: [
        {
          id: "privacy",
          label: "   ",
          description: "",
          weight: undefined,
          tolerance: undefined,
        },
      ],
      relationships: [
        {
          from: "privacy",
          to: "privacy",
          kind: "supports",
          weight: undefined,
        },
      ],
      defaultThreshold: undefined,
    });

    const exported = graph.exportConfiguration();
    expect(exported, "configuration should be exported after normalisation").to.not.equal(null);
    expect(exported?.defaultThreshold, "default threshold should fallback to the configured baseline").to.equal(0.6);
    expect(exported?.values).to.have.lengthOf(1);
    const value = exported?.values[0];
    expect(value?.id).to.equal("privacy");
    expect(value).to.have.property("label", undefined);
    expect(value).to.have.property("description", undefined);
    expect(value).to.have.property("weight", 1);
    expect(value).to.have.property("tolerance", 0.35);
    expect(exported?.relationships).to.equal(undefined);
  });
});

describe("value graph safety bounds", () => {
  it("rejects configurations exceeding the value limit", () => {
    const graph = new ValueGraph({ now: () => 0 });
    const values = Array.from({ length: VALUE_GRAPH_LIMITS.maxValues + 1 }, (_, index) => ({
      id: `value-${index}`,
    }));

    expect(() =>
      graph.set({ values }),
    ).to.throw(
      RangeError,
      `value graph supports at most ${VALUE_GRAPH_LIMITS.maxValues} values per configuration`,
    );
  });

  it("rejects configurations exceeding the per-value relationship limit", () => {
    const graph = new ValueGraph({ now: () => 0 });
    const valueCount = VALUE_GRAPH_LIMITS.maxRelationshipsPerValue + 2;
    const values = Array.from({ length: valueCount }, (_, index) => ({ id: `value-${index}` }));
    const relationships = Array.from({ length: VALUE_GRAPH_LIMITS.maxRelationshipsPerValue + 1 }, (_, index) => ({
      from: "value-0",
      to: `value-${index + 1}`,
      kind: "supports" as const,
      weight: 0.5,
    }));

    expect(() =>
      graph.set({ values, relationships }),
    ).to.throw(
      RangeError,
      `value 'value-0' declares more than ${VALUE_GRAPH_LIMITS.maxRelationshipsPerValue} outgoing relationships`,
    );
  });

  it("rejects configurations exceeding the global relationship limit", () => {
    const baseGraph = new ValueGraph({ now: () => 0 });
    const sourceGraph = new ValueGraph({ now: () => 0 });

    const perValue = VALUE_GRAPH_LIMITS.maxRelationshipsPerValue;
    const valueCount = Math.min(VALUE_GRAPH_LIMITS.maxValues, perValue + 1);
    const values = Array.from({ length: valueCount }, (_, index) => ({ id: `value-${index}` }));
    const relationships: { from: string; to: string; kind: "supports"; weight: number }[] = [];

    outer: for (let sourceIndex = 0; sourceIndex < valueCount; sourceIndex += 1) {
      for (let offset = 0; offset < perValue; offset += 1) {
        const from = values[sourceIndex].id;
        const target = values[(sourceIndex + offset + 1) % valueCount].id;
        if (from === target) {
          continue;
        }
        relationships.push({ from, to: target, kind: "supports", weight: 0.5 });
        if (relationships.length === VALUE_GRAPH_LIMITS.maxRelationships + 1) {
          break outer;
        }
      }
    }

    expect(relationships.length).to.equal(VALUE_GRAPH_LIMITS.maxRelationships + 1);

    const validRelationships = relationships.slice(0, VALUE_GRAPH_LIMITS.maxRelationships);
    expect(validRelationships.length).to.equal(VALUE_GRAPH_LIMITS.maxRelationships);

    baseGraph.set({ values, relationships: validRelationships });

    expect(() =>
      sourceGraph.set({ values, relationships }),
    ).to.throw(
      RangeError,
      `value graph supports at most ${VALUE_GRAPH_LIMITS.maxRelationships} relationships`,
    );
  });

  it("caps node weights to the configured ceiling", () => {
    const graph = new ValueGraph({ now: () => 0 });

    graph.set({
      values: [
        {
          id: "safety",
          weight: VALUE_GRAPH_LIMITS.maxValueWeight * 10,
          tolerance: 0.2,
        },
      ],
    });

    const exported = graph.exportConfiguration();
    expect(exported).to.not.equal(null);
    expect(exported?.values[0].weight).to.equal(VALUE_GRAPH_LIMITS.maxValueWeight);
  });

  it("rejects plan evaluations that exceed the impact ceiling", () => {
    const graph = new ValueGraph({ now: () => 0 });
    graph.set({ values: [{ id: "safety" }] });

    const impacts = Array.from({ length: VALUE_GRAPH_LIMITS.maxImpactsPerPlan + 1 }, (_, index) => ({
      value: "safety",
      impact: index % 2 === 0 ? ("support" as const) : ("risk" as const),
      severity: 0.5,
    }));

    expect(() =>
      graph.score({ id: "plan", impacts }),
    ).to.throw(
      RangeError,
      `value graph can only evaluate up to ${VALUE_GRAPH_LIMITS.maxImpactsPerPlan} impacts per plan`,
    );
  });
});
