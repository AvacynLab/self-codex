import { describe, it } from "mocha";
import { expect } from "chai";
import { performance } from "node:perf_hooks";

import { diffGraphs } from "../../src/graph/diff.js";
import { applyGraphPatch } from "../../src/graph/patch.js";
import type { NormalisedGraph } from "../../src/graph/types.js";

/**
 * Compute the percentile of a numeric dataset using linear interpolation. The
 * helper expects an already materialised array because the sample size is
 * intentionally tiny (< 100) to keep the perf regression quick to execute.
 */
function computePercentile(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const index = (sorted.length - 1) * percentile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const ratio = index - lowerIndex;
  return sorted[lowerIndex] * (1 - ratio) + sorted[upperIndex] * ratio;
}

/**
 * Build a deterministic graph description with predictable fan-out so the diff
 * routine has to exercise attribute comparisons, node/edge sorting and JSON
 * patch emission. The parameters represent the node count and the number of
 * edges emitted per node which keeps the scenarios easy to reason about.
 */
function buildGraph(nodes: number, edgesPerNode: number): NormalisedGraph {
  const graphNodes: NormalisedGraph["nodes"] = [];
  for (let index = 0; index < nodes; index += 1) {
    graphNodes.push({
      id: `n${index}`,
      label: index % 2 === 0 ? `Node ${index}` : undefined,
      attributes: {
        weight: index,
        active: index % 3 === 0,
        note: `node_${index}`,
      },
    });
  }

  const graphEdges: NormalisedGraph["edges"] = [];
  for (let index = 0; index < nodes; index += 1) {
    for (let edge = 0; edge < edgesPerNode; edge += 1) {
      const target = (index + edge + 1) % nodes;
      graphEdges.push({
        from: `n${index}`,
        to: `n${target}`,
        label: edge % 2 === 0 ? `edge_${index}_${edge}` : undefined,
        weight: edge,
        attributes: {
          distance: edge * 0.5,
          relation: `rel_${index}_${edge}`,
        },
      });
    }
  }

  return {
    name: `graph_${nodes}_${edgesPerNode}`,
    graphId: `g-${nodes}-${edgesPerNode}`,
    graphVersion: 1,
    metadata: { createdBy: "perf-test" },
    nodes: graphNodes,
    edges: graphEdges,
  };
}

/**
 * Measure the time required to diff two graphs and apply the resulting patch.
 * The routine returns individual durations in milliseconds so callers can
 * compute statistics such as the p95.
 */
function sampleDiffDurations({
  base,
  target,
  iterations,
}: {
  base: NormalisedGraph;
  target: NormalisedGraph;
  iterations: number;
}): number[] {
  const samples: number[] = [];
  for (let run = 0; run < iterations; run += 1) {
    const start = performance.now();
    const diff = diffGraphs(base, target);
    applyGraphPatch(base, diff.operations);
    const elapsed = performance.now() - start;
    samples.push(elapsed);
  }
  return samples;
}

const shouldSkipPerf = process.env.CI === "true" && process.env.MCP_RUN_PERF_TESTS !== "true";
const describePerf = shouldSkipPerf ? describe.skip : describe;

describePerf("graph diff/patch performance", function () {
  // Perf scenarios run slightly longer than unit tests; extend the timeout to
  // give slower environments breathing room without masking actual regressions.
  this.timeout(10_000);

  it("keeps the small scenario p95 under the 8ms envelope", () => {
    const base = buildGraph(12, 3);
    const target = buildGraph(12, 3);
    const samples = sampleDiffDurations({ base, target, iterations: 60 });

    expect(samples).to.have.lengthOf(60);
    const p95 = computePercentile(samples, 0.95);
    expect(p95).to.be.lessThan(8);
  });

  it("keeps the medium scenario p95 under the 12ms envelope", () => {
    const base = buildGraph(40, 6);
    const target = buildGraph(40, 6);
    const samples = sampleDiffDurations({ base, target, iterations: 60 });

    expect(samples).to.have.lengthOf(60);
    const p95 = computePercentile(samples, 0.95);
    expect(p95).to.be.lessThan(12);
  });

  it("keeps the large scenario p95 under the 20ms envelope", () => {
    const base = buildGraph(90, 10);
    const target = buildGraph(90, 10);
    const samples = sampleDiffDurations({ base, target, iterations: 60 });

    expect(samples).to.have.lengthOf(60);
    const p95 = computePercentile(samples, 0.95);
    expect(p95).to.be.lessThan(20);
  });
});
