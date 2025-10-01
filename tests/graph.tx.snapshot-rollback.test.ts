import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../src/graph/tx.js";
import type { NormalisedGraph } from "../src/graph/types.js";

/**
 * Helper producing a lightweight normalised graph used as fixture across the
 * transaction tests.
 */
function makeGraph(version = 1): NormalisedGraph {
  return {
    name: "workflow",
    graphId: "graph-alpha",
    graphVersion: version,
    nodes: [
      { id: "start", attributes: {}, label: "Start" },
      { id: "finish", attributes: {}, label: "Finish" },
    ],
    edges: [
      { from: "start", to: "finish", attributes: {}, label: "done" },
    ],
    metadata: { domain: "test" },
  };
}

describe("graph transactions - snapshot & rollback", () => {
  it("provides an isolated working copy and restores the snapshot on rollback", () => {
    const manager = new GraphTransactionManager();
    const baseGraph = makeGraph();

    const nowValues = [1000, 1000, 2000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => nowValues[Math.min(cursor++, nowValues.length - 1)];

    try {
      const begin = manager.begin(baseGraph);
      expect(begin.txId).to.have.length.greaterThan(10);
      expect(begin.workingCopy).to.not.equal(baseGraph);
      expect(begin.workingCopy).to.deep.equal(baseGraph);

      // Mutate the working copy to confirm it does not affect the stored snapshot.
      begin.workingCopy.nodes.push({ id: "extra", attributes: {}, label: "Extra" });

      const rolled = manager.rollback(begin.txId);
      expect(rolled.graphId).to.equal(baseGraph.graphId);
      expect(rolled.version).to.equal(baseGraph.graphVersion);
      expect(rolled.snapshot).to.deep.equal(baseGraph);
      expect(rolled.rolledBackAt).to.equal(2000);
      expect(manager.countActiveTransactions()).to.equal(0);
    } finally {
      Date.now = originalNow;
    }
  });

  it("increments the version and stamps the commit timestamp", () => {
    const manager = new GraphTransactionManager();
    const baseGraph = makeGraph();

    const nowValues = [5000, 6000, 7000];
    let cursor = 0;
    const originalNow = Date.now;
    Date.now = () => nowValues[Math.min(cursor++, nowValues.length - 1)];

    try {
      const begin = manager.begin(baseGraph);
      begin.workingCopy.metadata.note = "mutated";

      const committed = manager.commit(begin.txId, begin.workingCopy);
      expect(committed.version).to.equal(baseGraph.graphVersion + 1);
      expect(committed.committedAt).to.equal(7000);
      expect(committed.graph.metadata.__txCommittedAt).to.equal(7000);
      expect(committed.graph.graphVersion).to.equal(committed.version);
      expect(manager.countActiveTransactions()).to.equal(0);
    } finally {
      Date.now = originalNow;
    }
  });
});
