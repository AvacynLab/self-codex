import { expect } from "chai";
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
import { ResourceRegistry } from "../../../src/resources/registry.js";
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import { normaliseGraphPayload } from "../../../src/tools/graph/snapshot.js";
import {
  createGraphApplyChangeSetHandler,
  GRAPH_APPLY_CHANGE_SET_TOOL_NAME,
} from "../../../src/tools/graph_apply_change_set.js";
import type { NormalisedGraph } from "../../../src/graph/types.js";
import type { GraphApplyChangeSetInput } from "../../../src/rpc/graphApplyChangeSetSchemas.js";
import { GraphWorkerPool } from "../../../src/infra/workerPool.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in graph_apply_change_set tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in graph_apply_change_set tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function seedCommittedGraph(
  transactions: GraphTransactionManager,
  resources: ResourceRegistry,
  graph: NormalisedGraph,
): void {
  const tx = transactions.begin(graph);
  transactions.rollback(tx.txId);
  resources.recordGraphVersion({
    graphId: graph.graphId!,
    version: graph.graphVersion!,
    committedAt: Date.now(),
    graph,
  });
}

describe("graph_apply_change_set facade", () => {
  const graphId = "graph-facade-main";
  let transactions: GraphTransactionManager;
  let locks: GraphLockManager;
  let resources: ResourceRegistry;
  let idempotency: IdempotencyRegistry;
  let entries: LogEntry[];
  let logger: StructuredLogger;

  beforeEach(() => {
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
        { id: "start" },
        { id: "end" },
      ],
      edges: [{ from: "start", to: "end" }],
    });
    seedCommittedGraph(transactions, resources, baseGraph);
  });

  it("applies a change-set and commits a new graph version", async () => {
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
    });
    const extras = createRequestExtras("req-graph-change-set-success");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const input: GraphApplyChangeSetInput = {
      graph_id: graphId,
      idempotency_key: "graph-change-1",
      rationale: "Annoter le graphe",
      changes: [
        { op: "update", path: ["nodes", "0", "label"], value: "Start" },
        { op: "add", path: ["metadata", "owner"], value: "automation" },
      ],
    };

    const result = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-change-success", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(input, extras)),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.graph_id).to.equal(graphId);
    expect(structured.details.idempotent).to.equal(false);
    expect(structured.details.base_version).to.equal(1);
    expect(structured.details.committed_version).to.equal(2);
    expect(structured.details.diff.summary.nodes_changed).to.equal(true);
    expect(structured.details.diff.summary.metadata_changed).to.equal(true);
    expect(structured.details).to.not.have.property("metadata");
    expect(structured.details).to.have.property("rationale", "Annoter le graphe");

    const committed = transactions.getCommittedState(graphId);
    expect(committed?.version).to.equal(2);
    const labelledNode = committed?.graph.nodes.find((node) => node.id === "start");
    expect(labelledNode?.label).to.equal("Start");

    const logEntry = entries.find((entry) => entry.message === "graph_apply_change_set_completed");
    expect(logEntry?.request_id).to.equal("req-graph-change-set-success");
  });

  it("offloads heavy change-sets through the worker pool when enabled", async () => {
    const workerPool = new GraphWorkerPool({ maxWorkers: 2, changeSetSizeThreshold: 1 });
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
      workerPool,
    });
    const extras = createRequestExtras("req-graph-change-set-worker");
    const budget = new BudgetTracker({ toolCalls: 3 });

    const input: GraphApplyChangeSetInput = {
      graph_id: graphId,
      idempotency_key: "graph-worker-1",
      changes: [
        { op: "update", path: ["nodes", "0", "label"], value: "Worker Start" },
        { op: "add", path: ["metadata", "worker"], value: "enabled" },
      ],
    };

    const result = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-worker", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(input, extras)),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.details).to.not.have.property("rationale");
    const stats = workerPool.getStatistics();
    expect(stats.executed).to.equal(1);
    expect(stats.threshold).to.equal(1);

    await workerPool.destroy();
  });

  it("replays the committed result when the idempotency key matches", async () => {
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
      idempotency,
    });
    const extras = createRequestExtras("req-graph-change-set-idempotent");
    const budget = new BudgetTracker({ toolCalls: 4 });

    const input: GraphApplyChangeSetInput = {
      graph_id: graphId,
      idempotency_key: "graph-change-2",
      changes: [{ op: "add", path: ["metadata", "revision"], value: "v2" }],
    };

    const first = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-change-first", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(input, extras)),
    );
    const firstStructured = first.structuredContent as Record<string, any>;
    expect(firstStructured.ok).to.equal(true);
    expect(firstStructured.details.idempotent).to.equal(false);

    const second = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-change-second", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(input, extras)),
    );
    const secondStructured = second.structuredContent as Record<string, any>;
    expect(secondStructured.ok).to.equal(true);
    expect(secondStructured.details.idempotent).to.equal(true);
    expect(secondStructured.details.committed_version).to.equal(firstStructured.details.committed_version);
  });

  it("supports dry-run evaluation without committing mutations", async () => {
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
    });
    const extras = createRequestExtras("req-graph-change-set-dry-run");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const input: GraphApplyChangeSetInput = {
      graph_id: graphId,
      dry_run: true,
      changes: [{ op: "add", path: ["metadata", "preview"], value: "enabled" }],
    };

    const result = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-change-dry", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(input, extras)),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.dry_run).to.equal(true);
    expect(structured.details.committed_version).to.equal(null);
    expect(transactions.getCommittedState(graphId)?.version).to.equal(1);
  });

  it("returns a validation failure when invariants are violated", async () => {
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
    });
    const extras = createRequestExtras("req-graph-change-set-invalid");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const result = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-change-invalid", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              graph_id: graphId,
              changes: [{ op: "remove", path: ["nodes", "1"] }],
            },
            extras,
          ),
        ),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.reason).to.equal("validation_failed");
    expect(structured.details.violations).to.be.an("array").that.is.not.empty;

    const logEntry = entries.find((entry) => entry.message === "graph_apply_change_set_validation_failed");
    expect(logEntry?.request_id).to.equal("req-graph-change-set-invalid");
  });

  it("returns a degraded response when the tool-call budget is exhausted", async () => {
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
    });
    const extras = createRequestExtras("req-graph-change-set-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${GRAPH_APPLY_CHANGE_SET_TOOL_NAME}`, traceId: "trace-graph-change-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              graph_id: graphId,
              changes: [{ op: "add", path: ["metadata", "note"], value: "budget" }],
            },
            extras,
          ),
        ),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.reason).to.equal("budget_exhausted");
  });

  it("validates the change-set input payload", async () => {
    const handler = createGraphApplyChangeSetHandler({
      logger,
      transactions,
      locks,
      resources,
    });
    const extras = createRequestExtras("req-graph-change-set-invalid-input");

    let captured: unknown;
    try {
      const invalidInput: GraphApplyChangeSetInput = {
        // The schema enforces at least one change; using an empty list ensures validation fails predictably.
        graph_id: graphId,
        changes: [],
      };
      await handler(invalidInput, extras);
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
