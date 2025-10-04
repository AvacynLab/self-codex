import { describe, it } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childSupervisor,
  emitHeartbeatTick,
  stopHeartbeat,
  getRuntimeFeatures,
  configureRuntimeFeatures,
} from "../src/server.js";
import type { MessageRecord } from "../src/types.js";

/**
 * Integration coverage asserting that job-scoped tools publish correlated events retrievable via
 * the `events_subscribe` tool. The scenario exercises heartbeat, status and aggregate emissions so
 * downstream MCP clients can rely on consistent run/op identifiers.
 */
describe("events subscribe job correlation", () => {
  it("streams correlated heartbeat, status and aggregate events", async () => {
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-job-correlation-test", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "test-events" } });
      childSupervisor.childrenIndex.restore({});

      const now = Date.now();
      const jobId = "job_test_events";
      const childId = "child_test_events";
      const runId = "run-correlated";
      const opId = "op-correlated";
      const graphId = "graph-correlated";
      const nodeId = "node-correlated";

      graphState.createJob(jobId, { goal: "Validate event correlations", createdAt: now, state: "running" });
      graphState.createChild(jobId, childId, { name: "Observer", runtime: "codex" }, { createdAt: now, ttlAt: null });
      const message: MessageRecord = {
        role: "assistant",
        content: "Result payload",
        ts: now + 1,
        actor: "child",
      };
      graphState.appendMessage(childId, message);

      childSupervisor.childrenIndex.registerChild({
        childId,
        pid: 12345,
        workdir: "/tmp/test",
        state: "ready",
        startedAt: now,
        metadata: { job_id: jobId, run_id: runId, op_id: opId, graph_id: graphId, node_id: nodeId },
      });

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent.next_seq ?? 0;

      emitHeartbeatTick();

      const statusResponse = await client.callTool({ name: "status", arguments: { job_id: jobId } });
      expect(statusResponse.isError ?? false).to.equal(false);

      const aggregateResponse = await client.callTool({
        name: "aggregate",
        arguments: { job_id: jobId, strategy: "concat", include_system: false, include_goals: false },
      });
      expect(aggregateResponse.isError ?? false).to.equal(false);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: { from_seq: cursor, cats: ["status", "aggregate", "heartbeat"] },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);

      const structured = eventsResponse.structuredContent as {
        events: Array<{
          kind: string;
          job_id: string | null;
          run_id: string | null;
          op_id: string | null;
          graph_id: string | null;
          node_id: string | null;
          msg: string;
        }>;
      };

      const byKind = new Map(structured.events.map((evt) => [evt.kind, evt]));

      const heartbeat = byKind.get("HEARTBEAT");
      expect(heartbeat, "heartbeat event should be recorded").to.not.equal(undefined);
      expect(heartbeat?.job_id).to.equal(jobId);
      expect(heartbeat?.run_id).to.equal(runId);
      expect(heartbeat?.op_id).to.equal(opId);
      expect(heartbeat?.graph_id).to.equal(graphId);
      expect(heartbeat?.node_id).to.equal(nodeId);

      const statusEvent = byKind.get("STATUS");
      expect(statusEvent, "status event should be recorded").to.not.equal(undefined);
      expect(statusEvent?.job_id).to.equal(jobId);
      expect(statusEvent?.run_id).to.equal(runId);
      expect(statusEvent?.op_id).to.equal(opId);

      const aggregateEvent = byKind.get("AGGREGATE");
      expect(aggregateEvent, "aggregate event should be recorded").to.not.equal(undefined);
      expect(aggregateEvent?.job_id).to.equal(jobId);
      expect(aggregateEvent?.run_id).to.equal(runId);
      expect(aggregateEvent?.op_id).to.equal(opId);

      expect(structured.events.length).to.be.at.least(3);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      stopHeartbeat();
      childSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
