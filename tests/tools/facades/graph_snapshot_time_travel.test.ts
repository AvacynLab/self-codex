import { expect } from "chai";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../../src/logger.js";
import { GraphTransactionManager } from "../../../src/graph/tx.js";
import { GraphLockManager } from "../../../src/graph/locks.js";
import type { NormalisedGraph } from "../../../src/graph/types.js";
import { ResourceRegistry } from "../../../src/resources/registry.js";
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import { normaliseGraphPayload } from "../../../src/tools/graph/snapshot.js";
import {
  createGraphSnapshotTimeTravelHandler,
  GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME,
} from "../../../src/tools/graph_snapshot_time_travel.js";
import type { GraphSnapshotTimeTravelInput } from "../../../src/rpc/graphSnapshotTimeTravelSchemas.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in graph_snapshot_time_travel tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in graph_snapshot_time_travel tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

async function seedCommittedGraph(
  transactions: GraphTransactionManager,
  resources: ResourceRegistry,
  graph: ReturnType<typeof normaliseGraphPayload>,
): Promise<void> {
  const tx = transactions.begin(graph);
  transactions.rollback(tx.txId);
  resources.recordGraphVersion({
    graphId: graph.graphId!,
    version: graph.graphVersion!,
    committedAt: Date.now(),
    graph,
  });
}

async function commitGraphMutation(
  transactions: GraphTransactionManager,
  locks: GraphLockManager,
  resources: ResourceRegistry,
  graphId: string,
  mutate: (graph: NormalisedGraph) => NormalisedGraph,
): Promise<void> {
  const committed = transactions.getCommittedState(graphId);
  if (!committed) {
    throw new Error(`graph ${graphId} has no committed state`);
  }
  locks.assertCanMutate(graphId, null);
  const tx = transactions.begin(committed.graph);
  resources.recordGraphSnapshot({
    graphId: tx.graphId,
    txId: tx.txId,
    baseVersion: tx.baseVersion,
    startedAt: tx.startedAt,
    graph: tx.workingCopy,
    owner: tx.owner,
    note: tx.note,
    expiresAt: tx.expiresAt,
  });
  const nextGraph = mutate(structuredClone(committed.graph));
  nextGraph.graphVersion = committed.version + 1;
  transactions.setWorkingCopy(tx.txId, nextGraph);
  const result = transactions.commit(tx.txId, nextGraph);
  resources.markGraphSnapshotCommitted({
    graphId: result.graphId,
    txId: result.txId,
    committedAt: result.committedAt,
    finalVersion: result.version,
    finalGraph: result.graph,
  });
  resources.recordGraphVersion({
    graphId: result.graphId,
    version: result.version,
    committedAt: result.committedAt,
    graph: result.graph,
  });
  await delay(50);
}

describe("graph_snapshot_time_travel facade", () => {
  const graphId = "graph-snapshot-tests";
  const previousRunsRoot = process.env.MCP_RUNS_ROOT;
  let runsRoot: string;
  let transactions: GraphTransactionManager;
  let locks: GraphLockManager;
  let resources: ResourceRegistry;
  let idempotency: IdempotencyRegistry;
  let entries: LogEntry[];
  let logger: StructuredLogger;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "graph-snapshots-"));
    process.env.MCP_RUNS_ROOT = runsRoot;

    transactions = new GraphTransactionManager();
    locks = new GraphLockManager();
    resources = new ResourceRegistry();
    idempotency = new IdempotencyRegistry();
    entries = [];
    logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });

    const baseGraph = normaliseGraphPayload({
      name: "workflow",
      graph_id: graphId,
      graph_version: 1,
      metadata: {},
      nodes: [
        { id: "start", label: "Start" },
        { id: "finish", label: "Finish" },
      ],
      edges: [{ from: "start", to: "finish", label: "flow" }],
    });
    await seedCommittedGraph(transactions, resources, baseGraph);
    await commitGraphMutation(transactions, locks, resources, graphId, (graph) => ({
      ...graph,
      metadata: { ...(graph.metadata ?? {}), revision: "v2" },
      edges: [...graph.edges, { from: "start", to: "finish", label: "confirm" }],
    }));
  });

  afterEach(() => {
    process.env.MCP_RUNS_ROOT = previousRunsRoot;
  });

  it("lists the available snapshots for a graph", async () => {
    const handler = createGraphSnapshotTimeTravelHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
      runsRoot,
    });
    const extras = createRequestExtras("req-snapshot-list");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const input: GraphSnapshotTimeTravelInput = {
      graph_id: graphId,
      mode: "list",
      limit: 5,
    };

    const result = await runWithRpcTrace(
      { method: `tools/${GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME}`, traceId: "trace-snapshot-list", requestId: extras.requestId },
      async () => await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(input, extras)),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.snapshots).to.be.an("array").that.is.not.empty;
    expect(structured.details.snapshots[0].snapshot_id).to.be.a("string");
    const logEntry = entries.find((entry) => entry.message === "graph_snapshot_time_travel_listed");
    const payload = (logEntry?.payload ?? {}) as Record<string, unknown>;
    expect(payload.graph_id).to.equal(graphId);
  });

  it("previews a snapshot and returns the embedded graph when requested", async () => {
    const handler = createGraphSnapshotTimeTravelHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
      runsRoot,
    });
    const extras = createRequestExtras("req-snapshot-preview");
    const budget = new BudgetTracker({ toolCalls: 4, bytesOut: 256_000 });

    const listResult = await handler({ graph_id: graphId, mode: "list" }, extras);
    const listStructured = listResult.structuredContent as Record<string, any>;
    const snapshotId = listStructured.details.snapshots[0].snapshot_id as string;

    const result = await runWithRpcTrace(
      {
        method: `tools/${GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME}`,
        traceId: "trace-snapshot-preview",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ graph_id: graphId, mode: "preview", snapshot_id: snapshotId, include_graph: true }, extras),
        ),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.snapshot_id).to.equal(snapshotId);
    expect(structured.details.included_graph).to.equal(true);
    expect(structured.details.graph.nodes).to.have.length.greaterThan(0);
  });

  it("restores a snapshot and bumps the committed version", async () => {
    const handler = createGraphSnapshotTimeTravelHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
      runsRoot,
    });
    const extras = createRequestExtras("req-snapshot-restore");
    const budget = new BudgetTracker({ toolCalls: 6 });

    const list = await handler({ graph_id: graphId, mode: "list" }, extras);
    const firstSnapshotId = (list.structuredContent as Record<string, any>).details.snapshots[0].snapshot_id as string;

    const result = await runWithRpcTrace(
      {
        method: `tools/${GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME}`,
        traceId: "trace-snapshot-restore",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ graph_id: graphId, mode: "restore", snapshot_id: firstSnapshotId, idempotency_key: "restore-1" }, extras),
        ),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.restored_version).to.be.a("number").greaterThan(structured.details.base_version);
    const committed = transactions.getCommittedState(graphId);
    expect(committed?.version).to.equal(structured.details.restored_version);
    const restoreLog = entries.find((entry) => entry.message === "graph_snapshot_time_travel_restored");
    const restorePayload = (restoreLog?.payload ?? {}) as Record<string, unknown>;
    expect(restorePayload.snapshot_id).to.equal(firstSnapshotId);
  });

  it("returns a degraded response when the tool budget is exhausted", async () => {
    const handler = createGraphSnapshotTimeTravelHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
      runsRoot,
    });
    const extras = createRequestExtras("req-snapshot-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      {
        method: `tools/${GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME}`,
        traceId: "trace-snapshot-budget",
        requestId: extras.requestId,
      },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ graph_id: graphId, mode: "list" }, extras),
        ),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.budget.reason).to.equal("budget_exhausted");
  });

  it("validates the input payload", async () => {
    const handler = createGraphSnapshotTimeTravelHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
      runsRoot,
    });
    const extras = createRequestExtras("req-snapshot-invalid");

    let captured: unknown;
    try {
      await handler({} as Record<string, unknown>, extras);
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
