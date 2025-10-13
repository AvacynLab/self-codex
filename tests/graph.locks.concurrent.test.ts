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

    try {
      locks.acquire("g1", "owner_b", { ttlMs: 2_000 });
      expect.fail("expected GraphLockHeldError to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(GraphLockHeldError);
      const held = error as GraphLockHeldError;
      expect(held.code).to.equal("E-LOCK-HELD");
      expect(held.hint).to.equal("wait for the active holder to release or retry after expiry");
    }

    now = 3_100;
    const second = locks.acquire("g1", "owner_b", { ttlMs: 2_000 });
    expect(second.holder).to.equal("owner_b");
    expect(second.lockId).to.not.be.undefined;

    const release = locks.release(second.lockId);
    expect(release.expired).to.equal(false);

    try {
      locks.release(second.lockId);
      expect.fail("expected GraphLockUnknownError to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(GraphLockUnknownError);
      const unknown = error as GraphLockUnknownError;
      expect(unknown.code).to.equal("E-LOCK-NOTFOUND");
      expect(unknown.hint).to.equal("refresh the lock catalogue before retrying");
    }
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
          {
            op: "add_edge",
            edge: { from: "build", to: "qa", label: "build->qa" },
          },
        ],
      }),
    );
    expect(apply.changed).to.equal(true);

    now = 3_500;
    locks.acquire(baseGraph.graphId, "owner_b", { ttlMs: 2_000 });

    try {
      handleTxCommit(
        txContext,
        TxCommitInputSchema.parse({
          tx_id: begin.tx_id,
        }),
      );
      expect.fail("expected GraphMutationLockedError to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(GraphMutationLockedError);
      const conflict = error as GraphMutationLockedError;
      expect(conflict.code).to.equal("E-LOCK-HELD");
      expect(conflict.hint).to.equal("acquire the lock with the same holder or wait for expiry");
    }
  });

  it("refreshes an existing lock by identifier without changing the holder", () => {
    now = 500;
    const acquired = locks.acquire("g2", "owner_a", { ttlMs: 2_000 });
    expect(acquired.expiresAt).to.equal(2_500);

    now = 1_000;
    const refreshed = locks.refresh(acquired.lockId, { ttlMs: 3_000 });
    expect(refreshed.lockId).to.equal(acquired.lockId);
    expect(refreshed.graphId).to.equal("g2");
    expect(refreshed.holder).to.equal("owner_a");
    expect(refreshed.refreshedAt).to.equal(1_000);
    expect(refreshed.expiresAt).to.equal(4_000);

    // If no TTL override is provided, the previous TTL is reused.
    now = 1_500;
    const reused = locks.refresh(acquired.lockId, {});
    expect(reused.expiresAt).to.equal(4_500);
  });
});
