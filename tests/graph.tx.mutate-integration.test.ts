import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../src/graph/tx.js";
import {
  GraphMutateInputSchema,
  handleGraphGenerate,
  handleGraphMutate,
  normaliseGraphPayload,
  serialiseNormalisedGraph,
} from "../src/tools/graphTools.js";

/** Utility resetting the global clock after a test altered Date.now. */
function restoreNow(original: () => number): void {
  Date.now = original;
}

describe("graph transactions - mutate integration", () => {
  it("commits graphs mutated via handleGraphMutate without double increment", () => {
    const manager = new GraphTransactionManager();
    const base = handleGraphGenerate({ name: "pipeline", preset: "lint_test_build_package" });
    const baseline = normaliseGraphPayload(base.graph);

    const times = [10_000, 11_000, 12_000, 13_000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => times[Math.min(cursor++, times.length - 1)];

    try {
      const begin = manager.begin(baseline);
      const mutateInput = GraphMutateInputSchema.parse({
        graph: serialiseNormalisedGraph(begin.workingCopy),
        operations: [
          { op: "add_node", node: { id: "qa", label: "QA" } },
          { op: "add_edge", edge: { from: "build", to: "qa", weight: 1 } },
        ],
      });

      const mutated = handleGraphMutate(mutateInput);
      const committed = manager.commit(begin.txId, normaliseGraphPayload(mutated.graph));

      expect(committed.version).to.equal(begin.baseVersion + 1);
      expect(committed.graph.graphVersion).to.equal(committed.version);
      // The commit timestamp is captured after invariant validation which now
      // performs an additional `Date.now()` call. The metadata therefore
      // reflects the final sample (13_000) rather than the pre-validation value.
      expect(committed.graph.metadata.__txCommittedAt).to.equal(13_000);
      expect(committed.graph.nodes.some((node) => node.id === "qa")).to.equal(true);
    } finally {
      restoreNow(originalNow);
    }
  });

  it("keeps the version stable when mutations resolve to a no-op", () => {
    const manager = new GraphTransactionManager();
    const base = handleGraphGenerate({ name: "baseline", preset: "lint_test_build_package" });
    const baseline = normaliseGraphPayload(base.graph);

    const times = [20_000, 21_000, 22_000, 23_000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => times[Math.min(cursor++, times.length - 1)];

    try {
      const begin = manager.begin(baseline);
      const mutateInput = GraphMutateInputSchema.parse({
        graph: serialiseNormalisedGraph(begin.workingCopy),
        operations: [
          { op: "add_edge", edge: { from: "lint", to: "package", weight: 1 } },
          { op: "remove_edge", from: "lint", to: "package" },
        ],
      });

      const mutated = handleGraphMutate(mutateInput);
      const committed = manager.commit(begin.txId, normaliseGraphPayload(mutated.graph));

      expect(committed.version).to.equal(begin.baseVersion);
      expect(committed.graph.graphVersion).to.equal(begin.baseVersion);
      expect(committed.graph.edges).to.deep.equal(baseline.edges);
      expect(committed.graph.metadata.__txCommittedAt ?? null).to.equal(null);
    } finally {
      restoreNow(originalNow);
    }
  });
});
