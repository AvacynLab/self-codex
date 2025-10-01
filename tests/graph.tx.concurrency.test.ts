import { describe, it } from "mocha";
import { expect } from "chai";

import {
  GraphTransactionManager,
  GraphVersionConflictError,
} from "../src/graph/tx.js";
import type { NormalisedGraph } from "../src/graph/types.js";

/** Build a graph fixture with the provided identifier and version. */
function makeGraph(version: number): NormalisedGraph {
  return {
    name: "workflow",
    graphId: "graph-beta",
    graphVersion: version,
    nodes: [
      { id: "alpha", attributes: {}, label: "Alpha" },
      { id: "omega", attributes: {}, label: "Omega" },
    ],
    edges: [
      { from: "alpha", to: "omega", attributes: {}, label: "flow" },
    ],
    metadata: {},
  };
}

describe("graph transactions - concurrency control", () => {
  it("rejects commits issued from stale transactions", () => {
    const manager = new GraphTransactionManager();
    const original = makeGraph(1);

    const times = [10_000, 11_000, 12_000, 13_000, 14_000, 15_000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => times[Math.min(cursor++, times.length - 1)];

    try {
      const first = manager.begin(original);
      first.workingCopy.metadata.stage = "first";
      const firstCommit = manager.commit(first.txId, first.workingCopy);
      expect(firstCommit.version).to.equal(2);

      const second = manager.begin(firstCommit.graph);
      const third = manager.begin(firstCommit.graph);

      second.workingCopy.metadata.stage = "second";
      const secondCommit = manager.commit(second.txId, second.workingCopy);
      expect(secondCommit.version).to.equal(3);

      third.workingCopy.metadata.stage = "third";
      expect(() => manager.commit(third.txId, third.workingCopy)).to.throw(GraphVersionConflictError);
      expect(manager.countActiveTransactions()).to.equal(0);
    } finally {
      Date.now = originalNow;
    }
  });
});
