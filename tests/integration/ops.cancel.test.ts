import { describe, it, afterEach, beforeEach } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../../src/server.js";
import {
  registerCancellation,
  unregisterCancellation,
  resetCancellationRegistry,
  subscribeCancellationEvents,
  type CancellationEventPayload,
} from "../../src/executor/cancel.js";

/**
 * Integration coverage for the cancellation tools ensuring they surface structured payloads and
 * forward `cancelled` events through the shared bridge. The scenarios register synthetic
 * operations, invoke the public MCP tools, and then assert that both the tool responses and the
 * cancellation event stream expose the correlation identifiers expected by downstream observers.
 */
describe("operation cancellation tools", () => {
  let baselineGraphSnapshot: ReturnType<typeof graphState.serialize>;
  let baselineChildrenSnapshot: ReturnType<typeof childProcessSupervisor.childrenIndex.serialize>;
  let baselineFeatures: ReturnType<typeof getRuntimeFeatures>;

  beforeEach(() => {
    baselineGraphSnapshot = graphState.serialize();
    baselineChildrenSnapshot = childProcessSupervisor.childrenIndex.serialize();
    baselineFeatures = getRuntimeFeatures();
    resetCancellationRegistry();
  });

  afterEach(async () => {
    configureRuntimeFeatures(baselineFeatures);
    graphState.resetFromSnapshot(baselineGraphSnapshot);
    childProcessSupervisor.childrenIndex.restore(baselineChildrenSnapshot);
    resetCancellationRegistry();
    await server.close().catch(() => {});
  });

  it("emits cancellation events when op_cancel targets a registered operation", async function () {
    this.timeout(5000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ops-cancel", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    configureRuntimeFeatures({
      ...baselineFeatures,
      enableCancellation: true,
      enablePlanLifecycle: true,
    });

    // The handle mimics a long running operation tracked by the orchestrator so the cancellation
    // tool has a valid target. The correlation identifiers exercise the event bridge enrichment.
    const opId = "op-cancel-integration";
    const runId = "run-cancel-integration";
    registerCancellation(opId, {
      runId,
      jobId: "job-cancel", // deterministic metadata for the event assertions
      graphId: "graph-cancel",
      nodeId: "node-cancel",
      childId: "child-cancel",
    });

    const observed: CancellationEventPayload[] = [];
    const unsubscribe = subscribeCancellationEvents((event) => {
      observed.push(event);
    });

    try {
      const response = await client.callTool({
        name: "op_cancel",
        arguments: { op_id: opId, reason: "cleanup" },
      });
      expect(response.isError ?? false).to.equal(false);
      const payload = response.structuredContent as {
        outcome: string;
        run_id: string | null;
        job_id: string | null;
        graph_id: string | null;
        node_id: string | null;
        child_id: string | null;
        reason: string | null;
      };
      expect(payload.outcome).to.equal("requested");
      expect(payload.run_id).to.equal(runId);
      expect(payload.job_id).to.equal("job-cancel");
      expect(payload.graph_id).to.equal("graph-cancel");
      expect(payload.node_id).to.equal("node-cancel");
      expect(payload.child_id).to.equal("child-cancel");
      expect(payload.reason).to.equal("cleanup");

      expect(observed.length).to.equal(1);
      expect(observed[0]!.outcome).to.equal("requested");
      expect(observed[0]!.reason).to.equal("cleanup");
      expect(observed[0]!.runId).to.equal(runId);
    } finally {
      unsubscribe();
      unregisterCancellation(opId);
      await client.close().catch(() => {});
    }
  });

  it("cancels every operation attached to a run via plan_cancel", async function () {
    this.timeout(5000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-cancel", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    configureRuntimeFeatures({
      ...baselineFeatures,
      enableCancellation: true,
      enablePlanLifecycle: true,
    });

    const runId = "plan-cancel-run";
    const firstOp = "plan-cancel-op-1";
    const secondOp = "plan-cancel-op-2";
    registerCancellation(firstOp, { runId, jobId: "job-1" });
    registerCancellation(secondOp, { runId, jobId: "job-2" });

    const observed: CancellationEventPayload[] = [];
    const unsubscribe = subscribeCancellationEvents((event) => {
      if (event.runId === runId) {
        observed.push(event);
      }
    });

    try {
      const response = await client.callTool({
        name: "plan_cancel",
        arguments: { run_id: runId, reason: "shutdown" },
      });
      expect(response.isError ?? false).to.equal(false);
      const payload = response.structuredContent as {
        operations: Array<{ op_id: string; outcome: string; job_id: string | null }>;
        reason: string | null;
      };
      expect(payload.reason).to.equal("shutdown");
      const outcomes = new Map(payload.operations.map((operation) => [operation.op_id, operation.outcome] as const));
      expect(outcomes.get(firstOp)).to.equal("requested");
      expect(outcomes.get(secondOp)).to.equal("requested");

      expect(observed.length).to.equal(2);
      const eventOpIds = observed.map((event) => event.opId).sort();
      expect(eventOpIds).to.deep.equal([firstOp, secondOp].sort());
    } finally {
      unsubscribe();
      unregisterCancellation(firstOp);
      unregisterCancellation(secondOp);
      await client.close().catch(() => {});
    }
  });
});
