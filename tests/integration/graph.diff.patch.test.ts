import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../../src/graph/tx.js";
import { GraphLockManager } from "../../src/graph/locks.js";
import { ResourceRegistry } from "../../src/resources/registry.js";
import {
  handleGraphDiff,
  handleGraphPatch,
  GraphDiffInputSchema,
  GraphPatchInputSchema,
  type GraphDiffToolContext,
} from "../../src/tools/graphDiffTools.js";
import { serialiseNormalisedGraph } from "../../src/tools/graph/snapshot.js";
import type { NormalisedGraph } from "../../src/graph/types.js";
import { GraphInvariantError } from "../../src/graph/invariants.js";

/**
 * Build a graph descriptor enforcing labels, port attributes, and DAG semantics so diff/patch
 * exercises invariant enforcement in both the happy path and failure scenarios.
 */
function createSeedGraph(): NormalisedGraph {
  return {
    name: "release-pipeline",
    graphId: "release-pipeline",
    graphVersion: 1,
    metadata: {
      graph_kind: "dag",
      require_labels: true,
      require_edge_labels: true,
      require_ports: true,
    },
    nodes: [
      { id: "ingest", label: "Ingest", attributes: {} },
      { id: "process", label: "Process", attributes: {} },
      { id: "publish", label: "Publish", attributes: {} },
    ],
    edges: [
      { from: "ingest", to: "process", label: "ingest->process", attributes: { from_port: "out", to_port: "in" } },
      { from: "process", to: "publish", label: "process->publish", attributes: { from_port: "out", to_port: "in" } },
    ],
  } satisfies NormalisedGraph;
}

/** Register the seed graph as the latest committed version for diff/patch operations. */
function bootstrapCommittedGraph(context: GraphDiffToolContext, graph: NormalisedGraph): void {
  const tx = context.transactions.begin(graph);
  context.resources.recordGraphSnapshot({
    graphId: tx.graphId,
    txId: tx.txId,
    baseVersion: tx.baseVersion,
    startedAt: tx.startedAt,
    graph: tx.workingCopy,
    owner: tx.owner,
    note: tx.note,
    expiresAt: tx.expiresAt,
  });
  const committed = context.transactions.commit(tx.txId, graph);
  context.resources.markGraphSnapshotCommitted({
    graphId: committed.graphId,
    txId: committed.txId,
    committedAt: committed.committedAt,
    finalVersion: committed.version,
    finalGraph: committed.graph,
  });
  context.resources.recordGraphVersion({
    graphId: committed.graphId,
    version: committed.version,
    committedAt: committed.committedAt,
    graph: committed.graph,
  });
}

describe("graph diff & patch integration", () => {
  let transactions: GraphTransactionManager;
  let locks: GraphLockManager;
  let resources: ResourceRegistry;
  let context: GraphDiffToolContext;
  let seed: NormalisedGraph;

  beforeEach(() => {
    transactions = new GraphTransactionManager();
    locks = new GraphLockManager(() => Date.now());
    resources = new ResourceRegistry();
    context = { transactions, locks, resources };
    seed = createSeedGraph();
    bootstrapCommittedGraph(context, seed);
  });

  it("diffs two committed versions and applies the patch when invariants hold", () => {
    const upgraded: NormalisedGraph = {
      ...seed,
      graphVersion: seed.graphVersion + 1,
      metadata: { ...seed.metadata, release_channel: "beta" },
      nodes: [
        ...seed.nodes,
        { id: "review", label: "Review", attributes: {} },
      ],
      edges: [
        seed.edges[0]!,
        { from: "process", to: "review", label: "process->review", attributes: { from_port: "out", to_port: "in" } },
        { from: "review", to: "publish", label: "review->publish", attributes: { from_port: "out", to_port: "in" } },
      ],
    };

    const diff = handleGraphDiff(
      context,
      GraphDiffInputSchema.parse({
        graph_id: seed.graphId,
        from: { version: seed.graphVersion },
        to: { graph: serialiseNormalisedGraph(upgraded) },
      }),
    );

    expect(diff.changed).to.equal(true);
    expect(diff.summary.nodesChanged).to.equal(true);

    const patch = handleGraphPatch(
      context,
      GraphPatchInputSchema.parse({
        graph_id: seed.graphId,
        base_version: seed.graphVersion,
        owner: "integration-tests",
        patch: diff.operations,
        enforce_invariants: true,
      }),
    );

    expect(patch.changed).to.equal(true);
    expect(patch.invariants?.ok ?? true).to.equal(true);
    expect(patch.graph.nodes.map((node) => node.id)).to.include("review");
    expect(patch.committed_version).to.equal(seed.graphVersion + 1);
  });

  it("aborts patching when invariants break and marks the snapshot as rolled back", () => {
    const cyclic: NormalisedGraph = {
      ...seed,
      graphVersion: seed.graphVersion + 1,
      edges: [
        ...seed.edges,
        { from: "publish", to: "ingest", label: "publish->ingest", attributes: { from_port: "out", to_port: "in" } },
      ],
    };

    const diff = handleGraphDiff(
      context,
      GraphDiffInputSchema.parse({
        graph_id: seed.graphId,
        from: { latest: true },
        to: { graph: serialiseNormalisedGraph(cyclic) },
      }),
    );

    const beforeUris = new Set(resources.list("sc://snapshots/").map((entry) => entry.uri));

    expect(() =>
      handleGraphPatch(
        context,
        GraphPatchInputSchema.parse({
          graph_id: seed.graphId,
          base_version: seed.graphVersion,
          patch: diff.operations,
          enforce_invariants: true,
        }),
      ),
    ).to.throw(GraphInvariantError);

    const afterEntries = resources.list("sc://snapshots/");
    const newEntry = afterEntries.find((entry) => !beforeUris.has(entry.uri));
    expect(newEntry, "expected graph_patch to register a snapshot").to.not.equal(undefined);

    if (!newEntry) {
      return;
    }

    const snapshot = resources.read(newEntry.uri);
    expect(snapshot.payload).to.include({ state: "rolled_back" });
  });
});
