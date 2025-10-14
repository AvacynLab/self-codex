import { expect } from "chai";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { configureGraphSnapshotPolicy, GraphTransactionManager } from "../../src/graph/tx.js";
import type { NormalisedGraph } from "../../src/graph/types.js";
import { snapshotList, snapshotLoad } from "../../src/state/snapshot.js";

describe("graph persistence integration", () => {
  const previousRunsRoot = process.env.MCP_RUNS_ROOT;
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "graph-persistence-"));
    process.env.MCP_RUNS_ROOT = runsRoot;
    configureGraphSnapshotPolicy({ commitInterval: 1, timeIntervalMs: null });
  });

  afterEach(async () => {
    process.env.MCP_RUNS_ROOT = previousRunsRoot;
    configureGraphSnapshotPolicy(null);
  });

  it("persists a WAL entry and snapshot after committing a mutation", async () => {
    const manager = new GraphTransactionManager();
    const baseGraph: NormalisedGraph = {
      name: "integration",
      graphId: "graph-persistence",
      graphVersion: 1,
      nodes: [
        { id: "root", label: "root", attributes: {} },
        { id: "child", label: "child", attributes: {} },
      ],
      edges: [
        { from: "root", to: "child", label: "link", attributes: {} },
      ],
      metadata: {},
    };

    const tx = manager.begin(baseGraph);
    const mutated: NormalisedGraph = {
      ...baseGraph,
      graphVersion: baseGraph.graphVersion + 1,
      nodes: [...baseGraph.nodes, { id: "leaf", label: "leaf", attributes: {} }],
      edges: [...baseGraph.edges, { from: "child", to: "leaf", label: "extend", attributes: {} }],
      metadata: { ...baseGraph.metadata },
    };

    manager.setWorkingCopy(tx.txId, mutated);
    const committed = manager.commit(tx.txId, mutated);

    expect(committed.graph.graphVersion).to.equal(2);

    // Allow asynchronous WAL/snapshot writes to flush to disk.
    await delay(100);

    const walDir = path.join(runsRoot, "wal", "graph");
    const walFiles = await readdir(walDir);
    expect(walFiles.length, "expected at least one WAL file").to.be.greaterThan(0);
    const walPath = path.join(walDir, walFiles[0]);
    const walEntries = (await readFile(walPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown> });

    const commitEntry = walEntries.find((entry) => entry.event === "tx_commit");
    expect(commitEntry, "missing tx_commit WAL entry").to.not.equal(undefined);
    expect(commitEntry?.payload.graph_id).to.equal(baseGraph.graphId);
    expect(commitEntry?.payload.next_version).to.equal(2);

    const snapshots = await snapshotList(`graph/${baseGraph.graphId}`, { runsRoot });
    expect(snapshots.length, "expected a persisted snapshot").to.be.greaterThan(0);
    const snapshot = await snapshotLoad<{ graph: NormalisedGraph }>(
      `graph/${baseGraph.graphId}`,
      snapshots[0].id,
      { runsRoot },
    );

    expect(snapshot.state.graph.nodes.map((node) => node.id)).to.include.members(["root", "child", "leaf"]);
    expect(snapshot.state.graph.edges).to.deep.include({ from: "child", to: "leaf", label: "extend", attributes: {} });
  });
});

