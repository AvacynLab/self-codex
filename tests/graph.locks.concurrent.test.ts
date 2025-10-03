import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import {
  GraphLockManager,
  GraphLockHeldError,
  GraphLockUnknownError,
  GraphMutationLockedError,
} from "../src/graph/locks.js";
import { GraphTransactionManager } from "../src/graph/tx.js";
import type { NormalisedGraph } from "../src/graph/types.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import {
  TxBeginInputSchema,
  TxApplyInputSchema,
  TxCommitInputSchema,
  handleTxBegin,
  handleTxApply,
  handleTxCommit,
  type TxToolContext,
} from "../src/tools/txTools.js";
import { serialiseNormalisedGraph } from "../src/tools/graphTools.js";

function createGraph(): NormalisedGraph {
  return {
    name: "workflow",
    graphId: "g1",
    graphVersion: 1,
    metadata: { graph_kind: "dag" },
    nodes: [
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
    ],
    edges: [
      { from: "plan", to: "build", label: "plan->build", weight: 1 },
    ],
  } satisfies NormalisedGraph;
}

describe("graph locks", () => {
  let now: number;
  let locks: GraphLockManager;

  beforeEach(() => {
    now = Date.now();
    locks = new GraphLockManager(() => now);
  });

  it("supports re-entrance and TTL refresh for the same holder", () => {
    now = 1_000;
    const first = locks.acquire("g1", "owner_a", { ttlMs: 5_000 });
    expect(first.expiresAt).to.equal(6_000);

    now = 2_000;
    const refreshed = locks.acquire("g1", "owner_a", { ttlMs: 7_000 });
    expect(refreshed.lockId).to.equal(first.lockId);
    expect(refreshed.refreshedAt).to.equal(2_000);
    expect(refreshed.expiresAt).to.equal(9_000);
  });

  it("rejects competing holders until the previous lock expires", () => {
    now = 1_000;
    locks.acquire("g1", "owner_a", { ttlMs: 2_000 });

    expect(() => locks.acquire("g1", "owner_b", { ttlMs: 2_000 })).to.throw(GraphLockHeldError);

    now = 3_100;
    const second = locks.acquire("g1", "owner_b", { ttlMs: 2_000 });
    expect(second.holder).to.equal("owner_b");
    expect(second.lockId).to.not.be.undefined;

    const release = locks.release(second.lockId);
    expect(release.expired).to.equal(false);

    expect(() => locks.release(second.lockId)).to.throw(GraphLockUnknownError);
  });

  it("blocks transactions once a new holder acquires the graph", () => {
    const baseGraph = createGraph();
    const transactions = new GraphTransactionManager();
    const resources = new ResourceRegistry();
    const txContext: TxToolContext = { transactions, resources, locks };

    now = 1_000;
    locks.acquire(baseGraph.graphId, "owner_a", { ttlMs: 2_000 });

    const begin = handleTxBegin(
      txContext,
      TxBeginInputSchema.parse({
        graph_id: baseGraph.graphId,
        owner: "owner_a",
        graph: serialiseNormalisedGraph(baseGraph),
      }),
    );

    const apply = handleTxApply(
      txContext,
      TxApplyInputSchema.parse({
        tx_id: begin.tx_id,
        operations: [
          {
            op: "add_node",
            node: { id: "qa", label: "QA" },
          },
        ],
      }),
    );
    expect(apply.changed).to.equal(true);

    now = 3_500;
    locks.acquire(baseGraph.graphId, "owner_b", { ttlMs: 2_000 });

    expect(() =>
      handleTxCommit(
        txContext,
        TxCommitInputSchema.parse({
          tx_id: begin.tx_id,
        }),
      ),
    ).to.throw(GraphMutationLockedError);
  });
});
