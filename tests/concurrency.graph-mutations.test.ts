import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphTransactionManager } from "../src/graph/tx.js";
import { GraphLockManager, GraphMutationLockedError } from "../src/graph/locks.js";
import type { NormalisedGraph } from "../src/graph/types.js";
import { ResourceRegistry, type ResourceGraphPayload } from "../src/resources/registry.js";
import {
  GraphDiffInputSchema,
  GraphPatchInputSchema,
  handleGraphDiff,
  handleGraphPatch,
  type GraphDiffToolContext,
} from "../src/tools/graphDiffTools.js";
import { serialiseNormalisedGraph } from "../src/tools/graphTools.js";

/**
 * Utility returning a deterministic base graph used by the concurrency scenarios.
 * The structure mirrors the pipelines used across the diff/patch suites so the
 * generated JSON Patch operations remain stable across runs.
 */
function buildBaseGraph(): NormalisedGraph {
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

/** Register the base graph as the latest committed version in the in-memory registry. */
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

/** Lightweight helper yielding control to emulate asynchronous scheduling. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wrap the provided promise with a timeout so concurrency failures manifest as
 * deterministic assertion errors rather than hanging the suite.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`concurrency scenario timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Ensures graph patch requests contending on locks do not deadlock and that the
 * lock holder can progress while other callers receive deterministic errors.
 */
describe("graph mutation concurrency", () => {
  it("serialises conflicting patches without deadlocking the lock manager", async () => {
    const transactions = new GraphTransactionManager();
    const resources = new ResourceRegistry();
    const locks = new GraphLockManager(() => Date.now());
    const context: GraphDiffToolContext = { transactions, resources, locks };

    const baseGraph = seedCommittedGraph(context, buildBaseGraph());

    const expandGraph: NormalisedGraph = {
      ...baseGraph,
      nodes: [
        ...baseGraph.nodes,
        { id: "review", label: "Review", attributes: { role: "qa", max_in_degree: 2 } },
      ],
      edges: [
        ...baseGraph.edges,
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

    const annotateGraph: NormalisedGraph = {
      ...baseGraph,
      metadata: {
        ...baseGraph.metadata,
        release_channel: "beta",
      },
    } satisfies NormalisedGraph;

    const diffExpand = handleGraphDiff(
      context,
      GraphDiffInputSchema.parse({
        graph_id: baseGraph.graphId,
        from: { latest: true },
        to: { graph: serialiseNormalisedGraph(expandGraph) },
      }),
    );

    const diffAnnotateFromBase = handleGraphDiff(
      context,
      GraphDiffInputSchema.parse({
        graph_id: baseGraph.graphId,
        from: { latest: true },
        to: { graph: serialiseNormalisedGraph(annotateGraph) },
      }),
    );

    const ownerALock = locks.acquire(baseGraph.graphId, "owner_a", { ttlMs: 10_000 });

    const ownerAPatchInput = GraphPatchInputSchema.parse({
      graph_id: baseGraph.graphId,
      base_version: baseGraph.graphVersion,
      owner: "owner_a",
      patch: diffExpand.operations,
      enforce_invariants: true,
    });

    const ownerBPatchInput = GraphPatchInputSchema.parse({
      graph_id: baseGraph.graphId,
      base_version: baseGraph.graphVersion,
      owner: "owner_b",
      patch: diffAnnotateFromBase.operations,
      enforce_invariants: true,
    });

    const [ownerAResult, ownerBAttempt] = await withTimeout(
      Promise.allSettled([
        (async () => {
          // Allow the competing task to start before the holder commits.
          await delay(5);
          const result = handleGraphPatch(context, ownerAPatchInput);
          locks.release(ownerALock.lockId);
          return result;
        })(),
        (async () => {
          await delay(1);
          try {
            handleGraphPatch(context, ownerBPatchInput);
            return { ok: true as const };
          } catch (error) {
            return { ok: false as const, error };
          }
        })(),
      ]),
      250,
    );

    expect(ownerAResult.status).to.equal("fulfilled");
    const patchResult = ownerAResult.value;
    expect(patchResult.changed).to.equal(true);
    expect(patchResult.graph.nodes.map((node) => node.id)).to.include("review");

    expect(ownerBAttempt.status).to.equal("fulfilled");
    const attemptOutcome = ownerBAttempt.value;
    expect(attemptOutcome.ok).to.equal(false);
    expect(attemptOutcome.error).to.be.instanceOf(GraphMutationLockedError);

    const latest = resources.read(`sc://graphs/${baseGraph.graphId}`);
    expect(latest).to.not.be.null;
    const latestPayload = (latest!.payload as ResourceGraphPayload);
    expect(latestPayload.version).to.equal(patchResult.committed_version);

    const targetAfterExpand: NormalisedGraph = {
      ...expandGraph,
      metadata: {
        ...expandGraph.metadata,
        release_channel: "beta",
      },
    } satisfies NormalisedGraph;

    const diffAnnotateFromExpanded = handleGraphDiff(
      context,
      GraphDiffInputSchema.parse({
        graph_id: baseGraph.graphId,
        from: { latest: true },
        to: { graph: serialiseNormalisedGraph(targetAfterExpand) },
      }),
    );

    const ownerBLock = locks.acquire(baseGraph.graphId, "owner_b", { ttlMs: 10_000 });
    const resumedPatchInput = GraphPatchInputSchema.parse({
      graph_id: baseGraph.graphId,
      base_version: latestPayload.version,
      owner: "owner_b",
      patch: diffAnnotateFromExpanded.operations,
      enforce_invariants: true,
    });
    const resumed = handleGraphPatch(context, resumedPatchInput);
    locks.release(ownerBLock.lockId);

    expect(resumed.changed).to.equal(true);
    expect(resumed.graph.metadata?.release_channel).to.equal("beta");
  });
});
