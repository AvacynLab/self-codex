import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../src/graph/tx.js";
import {
  GraphRewriteApplyInputSchema,
  handleGraphRewriteApply,
} from "../src/tools/graph/mutate.js";
import { normaliseGraphPayload, serialiseNormalisedGraph } from "../src/tools/graph/snapshot.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

/** Utility restoring the global clock after deterministic timer overrides. */
function restoreNow(original: () => number): void {
  Date.now = original;
}

describe("graph transactions - rewrite integration", () => {
  it("commits rewritten graphs with a single optimistic increment", () => {
    const manager = new GraphTransactionManager();
    const baseGraph: GraphDescriptorPayload = {
      name: "tx-manual",
      graph_id: "tx-manual",
      graph_version: 4,
      nodes: [
        { id: "plan", label: "Plan", attributes: {} },
        { id: "execute", label: "Execute", attributes: {} },
      ],
      edges: [
        {
          from: "plan",
          to: "execute",
          label: "plan→execute",
          attributes: { parallel: true },
        },
      ],
      metadata: {},
    };
    const baseline = normaliseGraphPayload(baseGraph);

    const times = [50_000, 51_000, 52_000, 53_000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => times[Math.min(cursor++, times.length - 1)];

    try {
      const begin = manager.begin(baseline);
      const rewriteInput = GraphRewriteApplyInputSchema.parse({
        graph: serialiseNormalisedGraph(begin.workingCopy),
        mode: "manual" as const,
        rules: ["split_parallel"],
      });
      const result = handleGraphRewriteApply(rewriteInput);
      const committed = manager.commit(begin.txId, normaliseGraphPayload(result.graph));

      expect(committed.version).to.equal(begin.baseVersion + 1);
      expect(committed.graph.graphVersion).to.equal(committed.version);
      // Invariant validation samples the clock once more before the commit is
      // persisted, hence the recorded timestamp now reflects the final entry
      // in the deterministic sequence (53_000).
      expect(committed.graph.metadata.__txCommittedAt).to.equal(53_000);
      expect(result.changed).to.equal(true);
    } finally {
      restoreNow(originalNow);
    }
  });

  it("preserves the base version when no rewrite is applied", () => {
    const manager = new GraphTransactionManager();
    const baseGraph: GraphDescriptorPayload = {
      name: "tx-stable",
      graph_id: "tx-stable",
      graph_version: 7,
      nodes: [
        { id: "ingest", label: "Ingest", attributes: {} },
        { id: "store", label: "Store", attributes: {} },
      ],
      edges: [
        { from: "ingest", to: "store", label: "ingest→store", attributes: {} },
      ],
      metadata: {},
    };
    const baseline = normaliseGraphPayload(baseGraph);

    const times = [60_000, 61_000, 62_000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => times[Math.min(cursor++, times.length - 1)];

    try {
      const begin = manager.begin(baseline);
      const rewriteInput = GraphRewriteApplyInputSchema.parse({
        graph: serialiseNormalisedGraph(begin.workingCopy),
        mode: "manual" as const,
        rules: ["split_parallel"],
      });
      const result = handleGraphRewriteApply(rewriteInput);
      const committed = manager.commit(begin.txId, normaliseGraphPayload(result.graph));

      expect(result.changed).to.equal(false);
      expect(committed.version).to.equal(begin.baseVersion);
      expect(committed.graph.graphVersion).to.equal(begin.baseVersion);
      expect(committed.graph.metadata.__txCommittedAt ?? null).to.equal(null);
    } finally {
      restoreNow(originalNow);
    }
  });
});
