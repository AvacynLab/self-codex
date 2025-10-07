import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager, GraphVersionConflictError } from "../src/graph/tx.js";
import { ERROR_CODES } from "../src/types.js";
import { GraphLockManager } from "../src/graph/locks.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import {
  handleTxBegin,
  handleTxApply,
  handleTxCommit,
  handleTxRollback,
  TxBeginInputSchema,
  TxApplyInputSchema,
  TxCommitInputSchema,
  TxRollbackInputSchema,
  type TxToolContext,
} from "../src/tools/txTools.js";

/**
 * Builds a minimal but connected graph descriptor used across the transaction
 * tests. Keeping it deterministic ensures preview versions remain stable.
 */
function createGraphDescriptor() {
  return {
    name: "workflow",
    graph_id: "demo-graph",
    graph_version: 1,
    nodes: [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
    ],
    edges: [
      { from: "alpha", to: "beta" },
    ],
  };
}

describe("transaction tool handlers", () => {
  let transactions: GraphTransactionManager;
  let resources: ResourceRegistry;
  let context: TxToolContext;
  let locks: GraphLockManager;

  beforeEach(() => {
    transactions = new GraphTransactionManager();
    resources = new ResourceRegistry();
    locks = new GraphLockManager(() => Date.now());
    context = { transactions, resources, locks };
  });

  it("opens, mutates and commits a transaction while recording resources", () => {
    const graphDescriptor = createGraphDescriptor();
    const beginInput = TxBeginInputSchema.parse({
      graph_id: graphDescriptor.graph_id,
      owner: "testsuite",
      note: "initial import",
      ttl_ms: 5_000,
      graph: graphDescriptor,
    });
    const beginResult = handleTxBegin(context, beginInput);

    expect(beginResult.op_id).to.match(/^tx_begin_op_/);
    expect(beginResult.graph.nodes).to.have.length(2);
    expect(beginResult.owner).to.equal("testsuite");
    expect(beginResult.expires_at).to.be.a("number");
    expect(beginResult.idempotent).to.equal(false);
    expect(beginResult.idempotency_key).to.equal(null);

    const snapshotResource = resources.read(`sc://snapshots/${beginResult.graph_id}/${beginResult.tx_id}`);
    expect(snapshotResource.kind).to.equal("snapshot");
    const snapshotPayload = snapshotResource.payload as {
      state: string;
      owner: string | null;
      note: string | null;
      expiresAt: number | null;
    };
    expect(snapshotPayload.state).to.equal("pending");
    expect(snapshotPayload.owner).to.equal("testsuite");
    expect(snapshotPayload.note).to.equal("initial import");
    expect(snapshotPayload.expiresAt).to.be.a("number");

    const applyInput = TxApplyInputSchema.parse({
      tx_id: beginResult.tx_id,
      operations: [
        { op: "add_node", node: { id: "gamma", label: "Gamma" } },
        { op: "add_edge", edge: { from: "beta", to: "gamma" } },
      ],
    });
    const applyResult = handleTxApply(context, applyInput);
    expect(applyResult.op_id).to.match(/^tx_apply_op_/);
    expect(applyResult.changed).to.equal(true);
    expect(applyResult.preview_version).to.equal(beginResult.base_version + 1);
    expect(applyResult.applied.filter((entry) => entry.changed)).to.have.length(2);
    // Validate the RFC 6902 diff alias exposed for documentation parity.
    expect(applyResult.diff.length).to.be.greaterThan(0);
    expect(applyResult.diff_summary.nodesChanged).to.equal(true);
    expect(applyResult.graph.nodes).to.have.length(3);
    expect(applyResult.graph.edges).to.have.length(2);
    expect(applyResult.invariants.ok).to.equal(true);

    const commitInput = TxCommitInputSchema.parse({ tx_id: beginResult.tx_id });
    const commitResult = handleTxCommit(context, commitInput);
    expect(commitResult.op_id).to.match(/^tx_commit_op_/);
    expect(commitResult.version).to.equal(beginResult.base_version + 1);
    expect(commitResult.graph.graph_version).to.equal(commitResult.version);

    const graphResource = resources.read(`sc://graphs/${commitResult.graph_id}`);
    expect(graphResource.kind).to.equal("graph");
    const committedGraph = graphResource.payload.graph as { nodes: unknown[] };
    expect(committedGraph.nodes).to.have.length(3);

    const committedSnapshot = resources.read(`sc://snapshots/${commitResult.graph_id}/${commitResult.tx_id}`);
    const committedPayload = committedSnapshot.payload as { state: string };
    expect(committedPayload.state).to.equal("committed");
  });

  it("raises a version conflict when committing a stale transaction", () => {
    const graphDescriptor = createGraphDescriptor();
    const firstTx = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: graphDescriptor.graph_id, graph: graphDescriptor }),
    );
    const secondTx = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: graphDescriptor.graph_id, graph: graphDescriptor }),
    );

    expect(firstTx.idempotent).to.equal(false);
    expect(secondTx.idempotent).to.equal(false);

    const firstApply = handleTxApply(
      context,
      TxApplyInputSchema.parse({ tx_id: firstTx.tx_id, operations: [{ op: "remove_edge", from: "alpha", to: "beta" }] }),
    );
    expect(firstApply.preview_version).to.equal(firstTx.base_version + 1);
    // The diff summary flags edge removals so downstream previews can stay lightweight.
    expect(firstApply.diff_summary.edgesChanged).to.equal(true);
    handleTxCommit(context, TxCommitInputSchema.parse({ tx_id: firstTx.tx_id }));

    try {
      handleTxCommit(context, TxCommitInputSchema.parse({ tx_id: secondTx.tx_id }));
      expect.fail("expected GraphVersionConflictError");
    } catch (error) {
      expect(error).to.be.instanceOf(GraphVersionConflictError);
      const conflict = error as GraphVersionConflictError;
      expect(conflict.code).to.equal(ERROR_CODES.TX_CONFLICT);
      expect(conflict.hint).to.equal("reload latest committed graph before retrying");
    }
  });

  it("rolls back a transaction and exposes the original snapshot", () => {
    const graphDescriptor = createGraphDescriptor();
    const beginResult = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: graphDescriptor.graph_id, graph: graphDescriptor, note: "rollback" }),
    );

    handleTxApply(
      context,
      TxApplyInputSchema.parse({ tx_id: beginResult.tx_id, operations: [{ op: "remove_node", id: "beta" }] }),
    );

    const rollbackResult = handleTxRollback(context, TxRollbackInputSchema.parse({ tx_id: beginResult.tx_id }));
    expect(rollbackResult.op_id).to.match(/^tx_rollback_op_/);
    expect(rollbackResult.snapshot.nodes).to.have.length(2);

    const snapshotResource = resources.read(`sc://snapshots/${rollbackResult.graph_id}/${rollbackResult.tx_id}`);
    const rolledPayload = snapshotResource.payload as { state: string };
    expect(rolledPayload.state).to.equal("rolled_back");
    expect(transactions.countActiveTransactions()).to.equal(0);
  });

  it("patches graph metadata through transaction operations", () => {
    const graphDescriptor = {
      ...createGraphDescriptor(),
      metadata: { release_channel: "alpha", stale: true },
    };
    const beginResult = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: graphDescriptor.graph_id, graph: graphDescriptor, owner: "metadata-tests" }),
    );

    const applyResult = handleTxApply(
      context,
      TxApplyInputSchema.parse({
        tx_id: beginResult.tx_id,
        operations: [
          { op: "patch_metadata", set: { release_channel: "beta", stable: true } },
          { op: "patch_metadata", unset: ["stale", "unknown"] },
        ],
      }),
    );

    expect(applyResult.changed).to.equal(true);
    expect(applyResult.preview_version).to.equal(beginResult.base_version + 1);
    expect(applyResult.applied.filter((entry) => entry.changed)).to.have.length(2);
    // Metadata edits should translate into JSON Patch operations scoped to `/metadata`.
    expect(applyResult.diff.some((operation) => operation.path.startsWith("/metadata"))).to.equal(true);
    expect(applyResult.graph.metadata?.release_channel).to.equal("beta");
    expect(applyResult.graph.metadata?.stable).to.equal(true);
    expect(applyResult.graph.metadata?.stale ?? null).to.equal(null);
    expect(applyResult.invariants.ok).to.equal(true);

    const commitResult = handleTxCommit(context, TxCommitInputSchema.parse({ tx_id: beginResult.tx_id }));
    expect(commitResult.graph.metadata?.release_channel).to.equal("beta");
    expect(commitResult.graph.metadata?.stable).to.equal(true);
  });

  it("applies rewrite operations directly on the transaction working copy", () => {
    const graphDescriptor = {
      name: "parallel-pipeline",
      graph_id: "parallel-pipeline",
      graph_version: 2,
      nodes: [
        { id: "ingest", label: "Ingest" },
        { id: "store", label: "Store" },
      ],
      edges: [
        { from: "ingest", to: "store", attributes: { parallel: true } },
      ],
      metadata: {},
    };

    const beginResult = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: graphDescriptor.graph_id, graph: graphDescriptor }),
    );

    const applyResult = handleTxApply(
      context,
      TxApplyInputSchema.parse({
        tx_id: beginResult.tx_id,
        operations: [
          {
            op: "rewrite",
            rule: "split_parallel",
            params: { split_parallel_targets: ["ingest→store"] },
          },
        ],
      }),
    );

    expect(applyResult.changed).to.equal(true);
    expect(applyResult.applied).to.have.length(1);
    expect(applyResult.applied[0].op).to.equal("rewrite");
    // Rewrites yield structural additions, reflected in the diff summary.
    expect(applyResult.diff_summary.nodesChanged).to.equal(true);
    expect(applyResult.graph.nodes.length).to.equal(3);
    expect(applyResult.graph.edges.length).to.equal(2);
    expect(applyResult.preview_version).to.equal(beginResult.base_version + 1);
    expect(applyResult.invariants.ok).to.equal(true);

    const commitResult = handleTxCommit(context, TxCommitInputSchema.parse({ tx_id: beginResult.tx_id }));
    expect(commitResult.graph.nodes.length).to.equal(3);
    expect(commitResult.graph.edges.length).to.equal(2);
  });
});
