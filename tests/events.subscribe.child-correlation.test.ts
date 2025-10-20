import { describe, it } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../src/server.js";

/**
 * Integration coverage asserting that child lifecycle tools publish correlated events retrievable via
 * the `events_subscribe` tool. The scenario exercises PROMPT/PENDING/REPLY/REPLY_PART emissions so
 * downstream MCP clients can rely on consistent child/run/op identifiers while streaming outputs.
 */
describe("events subscribe child correlation", () => {
  it("streams correlated child lifecycle events", async () => {
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-child-correlation-test", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "test-child-events" } });
      childProcessSupervisor.childrenIndex.restore({});

      const now = Date.now();
      const jobId = "job_child_events";
      const childId = "child_child_events";
      const runId = "run-child";
      const opId = "op-child";
      const graphId = "graph-child";
      const nodeId = "node-child";

      graphState.createJob(jobId, { goal: "Validate child event correlations", createdAt: now, state: "running" });
      graphState.createChild(jobId, childId, { name: "Responder", runtime: "codex" }, { createdAt: now, ttlAt: null });

      childProcessSupervisor.childrenIndex.registerChild({
        childId,
        pid: 4242,
        workdir: "/tmp/test-child",
        state: "ready",
        startedAt: now,
        metadata: { job_id: jobId, run_id: runId, op_id: opId, graph_id: graphId, node_id: nodeId },
      });

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const promptResponse = await client.callTool({
        name: "child_prompt",
        arguments: {
          child_id: childId,
          messages: [
            {
              role: "user",
              content: "Ping",
            },
          ],
        },
      });
      expect(promptResponse.isError ?? false).to.equal(false);
      const promptText = promptResponse.content?.[0]?.text ?? "{}";
      const promptStructured = JSON.parse(promptText) as { pending_id?: string };
      const pendingId = promptStructured.pending_id;
      expect(pendingId, "pending_id should be returned by child_prompt").to.be.a("string");

      const partialResponse = await client.callTool({
        name: "child_push_partial",
        arguments: { pending_id: pendingId, delta: "partial", done: false },
      });
      expect(partialResponse.isError ?? false).to.equal(false);

      const finalResponse = await client.callTool({
        name: "child_push_partial",
        arguments: { pending_id: pendingId, delta: "final", done: true },
      });
      expect(finalResponse.isError ?? false).to.equal(false);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          child_id: childId,
        },
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
          child_id: string | null;
        }>;
      };

      const eventsByKind = new Map<string, { job_id: string | null; run_id: string | null; op_id: string | null; graph_id: string | null; node_id: string | null; child_id: string | null }>();
      for (const event of structured.events) {
        eventsByKind.set(event.kind, event);
      }

      const promptEvent = eventsByKind.get("PROMPT");
      expect(promptEvent, "PROMPT event should be present").to.not.equal(undefined);
      expect(promptEvent?.job_id).to.equal(jobId);
      expect(promptEvent?.run_id).to.equal(runId);
      expect(promptEvent?.op_id).to.equal(opId);
      expect(promptEvent?.graph_id).to.equal(graphId);
      expect(promptEvent?.node_id).to.equal(nodeId);
      expect(promptEvent?.child_id).to.equal(childId);

      const pendingEvent = eventsByKind.get("PENDING");
      expect(pendingEvent, "PENDING event should be present").to.not.equal(undefined);
      expect(pendingEvent?.job_id).to.equal(jobId);
      expect(pendingEvent?.run_id).to.equal(runId);
      expect(pendingEvent?.op_id).to.equal(opId);
      expect(pendingEvent?.graph_id).to.equal(graphId);
      expect(pendingEvent?.node_id).to.equal(nodeId);
      expect(pendingEvent?.child_id).to.equal(childId);

      const replyEvent = eventsByKind.get("REPLY");
      expect(replyEvent, "REPLY event should be present").to.not.equal(undefined);
      expect(replyEvent?.job_id).to.equal(jobId);
      expect(replyEvent?.run_id).to.equal(runId);
      expect(replyEvent?.op_id).to.equal(opId);
      expect(replyEvent?.graph_id).to.equal(graphId);
      expect(replyEvent?.node_id).to.equal(nodeId);
      expect(replyEvent?.child_id).to.equal(childId);

      const replyPartEvent = eventsByKind.get("REPLY_PART");
      expect(replyPartEvent, "REPLY_PART event should be present").to.not.equal(undefined);
      expect(replyPartEvent?.job_id).to.equal(jobId);
      expect(replyPartEvent?.run_id).to.equal(runId);
      expect(replyPartEvent?.op_id).to.equal(opId);
      expect(replyPartEvent?.graph_id).to.equal(graphId);
      expect(replyPartEvent?.node_id).to.equal(nodeId);
      expect(replyPartEvent?.child_id).to.equal(childId);

      expect(structured.events.length).to.be.at.least(4);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
