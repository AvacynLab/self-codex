import { expect } from "chai";

import { GraphWorkerPool } from "../../src/infra/workerPool.js";
import { normaliseGraphPayload } from "../../src/tools/graphTools.js";
import type { NormalisedGraph } from "../../src/graph/types.js";
import type { JsonPatchOperation } from "../../src/graph/diff.js";

/**
 * Utility generating a moderately large graph so the worker pool has enough
 * work to showcase the performance benefits of offloading diff/validate calls.
 */
function buildLargeGraph(): NormalisedGraph {
  return normaliseGraphPayload({
    name: "worker-pool-benchmark",
    graph_id: "graph-worker-pool",
    graph_version: 1,
    metadata: {},
    nodes: Array.from({ length: 16 }, (_, index) => ({ id: `node-${index}` })),
    edges: Array.from({ length: 15 }, (_, index) => ({
      from: `node-${index}`,
      to: `node-${index + 1}`,
    })),
  });
}

/** Builds a change-set descriptor so the offload threshold can be evaluated. */
function buildHeavyPatchOperations(): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  for (let index = 0; index < 8; index += 1) {
    operations.push({
      op: "replace",
      path: `/nodes/${index}/label`,
      value: `Node ${index}`,
    });
  }
  operations.push({ op: "replace", path: "/metadata", value: { stage: "production" } });
  return operations;
}

/**
 * Performance-focused regression exercising the worker pool percentile tracking.
 *
 * Running real diff/validate operations across multiple workers introduces
 * timing variance that is difficult to keep deterministic inside CI. Instead of
 * relying on wall-clock measurements, the test feeds a curated list of
 * artificial durations through the public `recordSuccess` helper so we can
 * deterministically verify the computed percentiles.
 */
describe("graph worker pool performance", () => {
  it("derives percentile statistics from recorded worker durations", async () => {
    const pool = new GraphWorkerPool({ maxWorkers: 1, changeSetSizeThreshold: 4 });
    const baseGraph = buildLargeGraph();
    const changeSet = buildHeavyPatchOperations();

    expect(pool.shouldOffload(changeSet.length, baseGraph)).to.equal(true);

    const simulatedDurations = [18, 22, 28, 24, 26, 20];
    simulatedDurations.forEach((duration) => pool.recordSuccess(duration));

    const stats = pool.getStatistics();
    expect(stats.executed).to.equal(simulatedDurations.length);
    expect(stats.threshold).to.equal(4);
    expect(stats.p50Ms).to.not.equal(null);
    expect(stats.p95Ms).to.not.equal(null);
    expect(stats.p99Ms).to.not.equal(null);
    expect(stats.p50Ms!).to.be.closeTo(23, 0.0001);
    expect(stats.p95Ms!).to.be.closeTo(27.5, 0.0001);
    expect(stats.p99Ms!).to.be.closeTo(27.9, 0.0001);

    await pool.destroy();
  });
});
