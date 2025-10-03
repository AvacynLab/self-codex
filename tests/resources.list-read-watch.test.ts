/**
 * Validates the MCP resource registry by exercising listing, reading and
 * watching capabilities. The tests seed graphs, run events, child logs and
 * blackboard entries to ensure URIs resolve deterministically and sequences are
 * strictly monotonic for watch pagination.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";
import type { NormalisedGraph } from "../src/graph/types.js";
import {
  ResourceNotFoundError,
  ResourceRegistry,
  ResourceWatchUnsupportedError,
} from "../src/resources/registry.js";

function createGraph(graphId: string, version: number): NormalisedGraph {
  return {
    name: "workflow",
    graphId,
    graphVersion: version,
    nodes: [
      {
        id: "root",
        label: "root",
        attributes: { order: version },
      },
    ],
    edges: [],
    metadata: { revision: version },
  };
}

describe("resources registry", () => {
  it("lists and reads committed graphs, snapshots, runs, children and blackboard namespaces", () => {
    const blackboard = new BlackboardStore();
    blackboard.set("core:pending", { task: "triage" });
    blackboard.set("core:active", { task: "review" });

    const registry = new ResourceRegistry({ blackboard, runHistoryLimit: 20, childLogHistoryLimit: 20 });

    registry.recordGraphSnapshot({
      graphId: "demo",
      txId: "tx-1",
      baseVersion: 1,
      startedAt: 1_000,
      graph: createGraph("demo", 1),
    });
    registry.markGraphSnapshotCommitted({
      graphId: "demo",
      txId: "tx-1",
      committedAt: 1_500,
      finalVersion: 2,
      finalGraph: createGraph("demo", 2),
    });

    registry.recordGraphVersion({ graphId: "demo", version: 1, committedAt: 900, graph: createGraph("demo", 1) });
    registry.recordGraphVersion({ graphId: "demo", version: 2, committedAt: 1_500, graph: createGraph("demo", 2) });

    registry.recordRunEvent("run-77", {
      seq: 1,
      ts: 2_000,
      kind: "PLAN",
      level: "info",
      jobId: "job-1",
      childId: null,
      payload: { run_id: "run-77", note: "start" },
    });
    registry.recordRunEvent("run-77", {
      seq: 2,
      ts: 2_100,
      kind: "STATUS",
      level: "info",
      jobId: "job-1",
      childId: "child-9",
      payload: { run_id: "run-77", step: "fanout" },
    });

    registry.recordChildLogEntry("child-9", { ts: 2_050, stream: "stdout", message: "ready" });
    registry.recordChildLogEntry("child-9", {
      ts: 2_120,
      stream: "stderr",
      message: "warning",
      jobId: "job-1",
      runId: "run-77",
      opId: "op-1",
    });

    const uris = registry.list().map((entry) => entry.uri);
    expect(uris).to.deep.equal([
      "sc://blackboard/core",
      "sc://children/child-9/logs",
      "sc://graphs/demo",
      "sc://graphs/demo@v1",
      "sc://graphs/demo@v2",
      "sc://runs/run-77/events",
      "sc://snapshots/demo/tx-1",
    ]);

    const graphsOnly = registry.list("sc://graphs/").map((entry) => entry.uri);
    expect(graphsOnly).to.deep.equal(["sc://graphs/demo", "sc://graphs/demo@v1", "sc://graphs/demo@v2"]);

    const latest = registry.read("sc://graphs/demo");
    expect(latest.kind).to.equal("graph");
    expect(latest.payload).to.deep.include({ graphId: "demo", version: 2, committedAt: 1_500 });

    const v1 = registry.read("sc://graphs/demo@v1");
    expect(v1.kind).to.equal("graph_version");
    expect(v1.payload).to.deep.include({ graphId: "demo", version: 1, committedAt: 900 });

    const snapshot = registry.read("sc://snapshots/demo/tx-1");
    expect(snapshot.kind).to.equal("snapshot");
    expect(snapshot.payload).to.deep.include({ state: "committed", baseVersion: 1, finalVersion: 2 });

    const run = registry.read("sc://runs/run-77/events");
    expect(run.kind).to.equal("run_events");
    expect(run.payload).to.deep.equal({
      runId: "run-77",
      events: [
        {
          seq: 1,
          ts: 2_000,
          kind: "PLAN",
          level: "info",
          jobId: "job-1",
          runId: "run-77",
          opId: null,
          graphId: null,
          nodeId: null,
          childId: null,
          payload: { run_id: "run-77", note: "start" },
        },
        {
          seq: 2,
          ts: 2_100,
          kind: "STATUS",
          level: "info",
          jobId: "job-1",
          runId: "run-77",
          opId: null,
          graphId: null,
          nodeId: null,
          childId: "child-9",
          payload: { run_id: "run-77", step: "fanout" },
        },
      ],
    });

    const childLogs = registry.read("sc://children/child-9/logs");
    expect(childLogs.kind).to.equal("child_logs");
    expect(childLogs.payload).to.deep.equal({
      childId: "child-9",
      logs: [
        {
          seq: 1,
          ts: 2_050,
          stream: "stdout",
          message: "ready",
          jobId: null,
          runId: null,
          opId: null,
          graphId: null,
          nodeId: null,
          childId: "child-9",
          raw: null,
          parsed: null,
        },
        {
          seq: 2,
          ts: 2_120,
          stream: "stderr",
          message: "warning",
          jobId: "job-1",
          runId: "run-77",
          opId: "op-1",
          graphId: null,
          nodeId: null,
          childId: "child-9",
          raw: null,
          parsed: null,
        },
      ],
    });

    const namespace = registry.read("sc://blackboard/core");
    expect(namespace.kind).to.equal("blackboard_namespace");
    expect(namespace.payload.namespace).to.equal("core");
    expect(namespace.payload.entries).to.have.length(2);
  });

  it("paginates watches with monotonic sequence numbers", () => {
    const registry = new ResourceRegistry();
    registry.recordRunEvent("run-123", {
      seq: 10,
      ts: 5_000,
      kind: "PLAN",
      level: "info",
      jobId: "job-xyz",
      payload: { run_id: "run-123" },
    });
    registry.recordRunEvent("run-123", {
      seq: 11,
      ts: 5_100,
      kind: "STATUS",
      level: "info",
      childId: "child-a",
      payload: { run_id: "run-123", state: "running" },
    });
    registry.recordRunEvent("run-123", {
      seq: 12,
      ts: 5_200,
      kind: "REPLY",
      level: "info",
      childId: "child-a",
      payload: { run_id: "run-123", reply: "ok" },
    });

    registry.recordRunEvent("run-123", {
      seq: 13,
      ts: 5_250,
      kind: "STATUS",
      level: "info",
      jobId: "job-xyz",
      runId: "run-123",
      opId: "op-7",
      graphId: "graph-42",
      nodeId: "node-beta",
      childId: "child-b",
      payload: { run_id: "run-123", op_id: "op-7", graph_id: "graph-42", node_id: "node-beta" },
    });

    const firstPage = registry.watch("sc://runs/run-123/events", { fromSeq: 0, limit: 2 });
    expect(firstPage.events.map((event) => event.seq)).to.deep.equal([10, 11]);
    expect(firstPage.nextSeq).to.equal(11);

    const secondPage = registry.watch("sc://runs/run-123/events", { fromSeq: firstPage.nextSeq, limit: 2 });
    expect(secondPage.events.map((event) => event.seq)).to.deep.equal([12, 13]);
    expect(secondPage.nextSeq).to.equal(13);

    const correlatedEvent = secondPage.events[1];
    expect(correlatedEvent).to.deep.equal({
      seq: 13,
      ts: 5_250,
      kind: "STATUS",
      level: "info",
      jobId: "job-xyz",
      runId: "run-123",
      opId: "op-7",
      graphId: "graph-42",
      nodeId: "node-beta",
      childId: "child-b",
      payload: {
        run_id: "run-123",
        op_id: "op-7",
        graph_id: "graph-42",
        node_id: "node-beta",
      },
    });

    registry.recordChildLogEntry("child-a", { ts: 5_050, stream: "stdout", message: "tick" });
    registry.recordChildLogEntry("child-a", {
      ts: 5_060,
      stream: "stdout",
      message: "tock",
      runId: "run-123",
      opId: "op-8",
    });

    const logPage = registry.watch("sc://children/child-a/logs", { fromSeq: 0 });
    expect(logPage.events).to.deep.equal([
      {
        seq: 1,
        ts: 5_050,
        stream: "stdout",
        message: "tick",
        jobId: null,
        runId: null,
        opId: null,
        graphId: null,
        nodeId: null,
        childId: "child-a",
        raw: null,
        parsed: null,
      },
      {
        seq: 2,
        ts: 5_060,
        stream: "stdout",
        message: "tock",
        jobId: null,
        runId: "run-123",
        opId: "op-8",
        graphId: null,
        nodeId: null,
        childId: "child-a",
        raw: null,
        parsed: null,
      },
    ]);
    expect(logPage.nextSeq).to.equal(2);
  });

  it("raises domain errors for unsupported operations", () => {
    const registry = new ResourceRegistry();
    expect(() => registry.read("sc://graphs/unknown")).to.throw(ResourceNotFoundError);
    expect(() => registry.watch("sc://graphs/demo", { fromSeq: 0 })).to.throw(ResourceWatchUnsupportedError);
  });
});
