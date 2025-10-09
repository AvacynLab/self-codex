import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../../src/graph/tx.js";
import { GraphLockManager } from "../../src/graph/locks.js";
import { ResourceRegistry } from "../../src/resources/registry.js";
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
} from "../../src/tools/txTools.js";
import { serialiseNormalisedGraph } from "../../src/tools/graphTools.js";
import type { NormalisedGraph } from "../../src/graph/types.js";
import { GraphInvariantError } from "../../src/graph/invariants.js";

/**
 * Build a deterministic directed acyclic graph used across the transaction integration
 * suite. The metadata enforces DAG semantics so invariant checks exercise the full
 * validation pipeline.
 */
function createDagGraph(): NormalisedGraph {
  return {
    name: "pipeline",
    graphId: "integration-pipeline",
    graphVersion: 1,
    metadata: { graph_kind: "dag", require_labels: true },
    nodes: [
      { id: "alpha", label: "Alpha", attributes: {} },
      { id: "beta", label: "Beta", attributes: {} },
    ],
    edges: [
      { from: "alpha", to: "beta", label: "alpha->beta", attributes: { from_port: "out", to_port: "in" } },
    ],
  } satisfies NormalisedGraph;
}

describe("transaction lifecycle integration", () => {
  let transactions: GraphTransactionManager;
  let locks: GraphLockManager;
  let resources: ResourceRegistry;
  let context: TxToolContext;
  let baseGraph: NormalisedGraph;

  beforeEach(() => {
    transactions = new GraphTransactionManager();
    locks = new GraphLockManager(() => Date.now());
    resources = new ResourceRegistry();
    context = { transactions, locks, resources };
    baseGraph = createDagGraph();
  });

  it("commits a transaction end-to-end while persisting resource snapshots", () => {
    const begin = handleTxBegin(
      context,
      TxBeginInputSchema.parse({
        graph_id: baseGraph.graphId,
        graph: serialiseNormalisedGraph(baseGraph),
        owner: "integration-suite",
        note: "full lifecycle",
      }),
    );

    expect(begin.graph.nodes.map((node) => node.id)).to.deep.equal(["alpha", "beta"]);
    expect(begin.idempotent).to.equal(false);

    const apply = handleTxApply(
      context,
      TxApplyInputSchema.parse({
        tx_id: begin.tx_id,
        operations: [
          { op: "add_node", node: { id: "gamma", label: "Gamma" } },
          { op: "add_edge", edge: { from: "beta", to: "gamma", label: "beta->gamma" } },
        ],
      }),
    );

    expect(apply.changed).to.equal(true);
    expect(apply.preview_version).to.equal(begin.base_version + 1);
    expect(apply.invariants.ok).to.equal(true);

    const commit = handleTxCommit(context, TxCommitInputSchema.parse({ tx_id: begin.tx_id }));
    expect(commit.version).to.equal(begin.base_version + 1);
    expect(commit.graph.nodes.map((node) => node.id)).to.include("gamma");

    const latest = resources.read(`sc://graphs/${commit.graph_id}`);
    expect(latest.payload).to.have.property("version", commit.version);

    const snapshot = resources.read(`sc://snapshots/${commit.graph_id}/${commit.tx_id}`);
    expect(snapshot.payload).to.include({ state: "committed" });
  });

  it("rejects invariant-breaking mutations during tx_apply and keeps the working copy pristine", () => {
    const begin = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: baseGraph.graphId, graph: serialiseNormalisedGraph(baseGraph) }),
    );

    expect(() =>
      handleTxApply(
        context,
        TxApplyInputSchema.parse({
          tx_id: begin.tx_id,
          operations: [
            { op: "add_edge", edge: { from: "beta", to: "alpha", label: "cycle" } },
          ],
        }),
      ),
    ).to.throw(GraphInvariantError);

    const untouched = transactions.getWorkingCopy(begin.tx_id);
    expect(untouched.edges).to.have.length(1);
    expect(untouched.edges[0]?.from).to.equal("alpha");

    const recovered = handleTxApply(
      context,
      TxApplyInputSchema.parse({
        tx_id: begin.tx_id,
        operations: [{ op: "add_node", node: { id: "delta", label: "Delta" } }],
      }),
    );

    expect(recovered.changed).to.equal(true);
    expect(recovered.graph.nodes.map((node) => node.id)).to.include("delta");
  });

  it("revalidates invariants at commit time when the working copy was tampered with", () => {
    const begin = handleTxBegin(
      context,
      TxBeginInputSchema.parse({ graph_id: baseGraph.graphId, graph: serialiseNormalisedGraph(baseGraph) }),
    );

    const apply = handleTxApply(
      context,
      TxApplyInputSchema.parse({
        tx_id: begin.tx_id,
        operations: [{ op: "add_node", node: { id: "epsilon", label: "Epsilon" } }],
      }),
    );
    expect(apply.invariants.ok).to.equal(true);

    const tampered = transactions.getWorkingCopy(begin.tx_id);
    tampered.edges.push({
      from: "beta",
      to: "alpha",
      label: "cycle",
      attributes: { from_port: "out", to_port: "in" },
    });
    transactions.setWorkingCopy(begin.tx_id, tampered);

    expect(() => handleTxCommit(context, TxCommitInputSchema.parse({ tx_id: begin.tx_id }))).to.throw(
      GraphInvariantError,
    );

    const rollback = handleTxRollback(context, TxRollbackInputSchema.parse({ tx_id: begin.tx_id }));
    expect(rollback.snapshot.nodes.map((node) => node.id)).to.deep.equal(["alpha", "beta"]);
  });
});
