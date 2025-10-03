import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../src/graph/tx.js";
import { GraphLockManager, GraphMutationLockedError } from "../src/graph/locks.js";
import type { NormalisedGraph } from "../src/graph/types.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import type { ResourceGraphPayload } from "../src/resources/registry.js";
import {
  GraphDiffInputSchema,
  GraphPatchInputSchema,
  handleGraphDiff,
  handleGraphPatch,
  type GraphDiffToolContext,
} from "../src/tools/graphDiffTools.js";
import { serialiseNormalisedGraph } from "../src/tools/graphTools.js";

/** Build a deterministic base graph exercising the diff/patch helpers. */
function createBaseGraph(): NormalisedGraph {
  return {
    name: "release_pipeline",
    graphId: "pipeline",
    graphVersion: 1,
    metadata: {
      graph_kind: "dag",
      require_labels: true,
      require_ports: true,
      require_edge_labels: true,
      max_in_degree: 2,
      max_out_degree: 3,
    },
    nodes: [
      { id: "ingest", label: "Ingest", attributes: { role: "source", max_out_degree: 2 } },
      { id: "process", label: "Process", attributes: { role: "worker", max_in_degree: 2 } },
      { id: "publish", label: "Publish", attributes: { role: "sink", max_in_degree: 2 } },
    ],
    edges: [
      {
        from: "ingest",
        to: "process",
        label: "ingest->process",
        weight: 1,
        attributes: { from_port: "out", to_port: "in" },
      },
      {
        from: "process",
        to: "publish",
        label: "process->publish",
        weight: 1,
        attributes: { from_port: "out", to_port: "in" },
      },
    ],
  } satisfies NormalisedGraph;
}

/** Register the base graph as a committed version in the registry and manager. */
function seedCommittedGraph(context: GraphDiffToolContext, graph: NormalisedGraph): NormalisedGraph {
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
  return committed.graph;
}

describe("graph diff & patch tools", () => {
  let transactions: GraphTransactionManager;
  let resources: ResourceRegistry;
  let context: GraphDiffToolContext;
  let baseGraph: NormalisedGraph;
  let locks: GraphLockManager;

  beforeEach(() => {
    transactions = new GraphTransactionManager();
    resources = new ResourceRegistry();
    locks = new GraphLockManager(() => Date.now());
    context = { transactions, resources, locks };
    baseGraph = seedCommittedGraph(context, createBaseGraph());
  });

  it("produces a JSON Patch and applies it while enforcing invariants", () => {
    const target: NormalisedGraph = {
      ...baseGraph,
      name: "release_pipeline_v2",
      metadata: {
        ...baseGraph.metadata,
        release_channel: "stable",
      },
      nodes: [
        ...baseGraph.nodes,
        { id: "review", label: "Review", attributes: { role: "qa", max_in_degree: 2 } },
      ],
      edges: [
        baseGraph.edges[0]!,
        {
          from: "process",
          to: "review",
          label: "process->review",
          weight: 1,
          attributes: { from_port: "out", to_port: "in" },
        },
        {
          from: "review",
          to: "publish",
          label: "review->publish",
          weight: 1,
          attributes: { from_port: "out", to_port: "in" },
        },
      ],
    } satisfies NormalisedGraph;

    const diffInput = GraphDiffInputSchema.parse({
      graph_id: baseGraph.graphId,
      from: { latest: true },
      to: { graph: serialiseNormalisedGraph(target) },
    });
    const diffResult = handleGraphDiff(context, diffInput);

    expect(diffResult.changed).to.equal(true);
    expect(diffResult.operations).to.not.be.empty;
    expect(diffResult.summary.nodesChanged).to.equal(true);
    expect(diffResult.summary.edgesChanged).to.equal(true);

    const patchInput = GraphPatchInputSchema.parse({
      graph_id: baseGraph.graphId,
      base_version: baseGraph.graphVersion,
      patch: diffResult.operations,
      enforce_invariants: true,
    });
    const patchResult = handleGraphPatch(context, patchInput);

    expect(patchResult.graph.nodes.map((node) => node.id)).to.include("review");
    expect(patchResult.graph.edges).to.have.length(3);
    expect(patchResult.changed).to.equal(true);
    expect(patchResult.committed_version).to.equal(baseGraph.graphVersion + 1);
    expect(patchResult.invariants?.ok ?? true).to.equal(true);

    const latest = resources.read(`sc://graphs/${patchResult.graph_id}`);
    const payload = latest.payload as ResourceGraphPayload;
    expect(payload.version).to.equal(patchResult.committed_version);
    expect(payload.graph.nodes.map((node) => node.id)).to.include("review");
  });

  it("rejects conflicting patches when a different holder owns the lock", () => {
    const target: NormalisedGraph = {
      ...baseGraph,
      metadata: { ...baseGraph.metadata, release_channel: "beta" },
    } satisfies NormalisedGraph;

    const diffInput = GraphDiffInputSchema.parse({
      graph_id: baseGraph.graphId,
      from: { latest: true },
      to: { graph: serialiseNormalisedGraph(target) },
    });
    const diffResult = handleGraphDiff(context, diffInput);

    locks.acquire(baseGraph.graphId, "owner_a", { ttlMs: 5_000 });

    const conflicting = GraphPatchInputSchema.parse({
      graph_id: baseGraph.graphId,
      base_version: baseGraph.graphVersion,
      owner: "owner_b",
      patch: diffResult.operations,
      enforce_invariants: true,
    });

    expect(() => handleGraphPatch(context, conflicting)).to.throw(GraphMutationLockedError);

    const allowed = GraphPatchInputSchema.parse({
      graph_id: baseGraph.graphId,
      base_version: baseGraph.graphVersion,
      owner: "owner_a",
      patch: diffResult.operations,
      enforce_invariants: true,
    });
    const result = handleGraphPatch(context, allowed);
    expect(result.changed).to.equal(true);
    expect(result.graph.metadata?.release_channel).to.equal("beta");
  });
});
