import { describe, it } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  eventStore,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../src/server.js";

/**
 * Ensures final child replies emitted over the events bus surface aggregated
 * provenance citations derived from the EventStore window. The scenario primes
 * the EventStore with provenance-bearing events, completes a pending child
 * reply, and asserts that both the event payload and persisted provenance carry
 * the expected citations.
 */
describe("events subscribe final reply citations", () => {
  it("propagates aggregated provenance citations with final replies", async () => {
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-final-reply-citations-test", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "test-final-reply-citations" } });
      childProcessSupervisor.childrenIndex.restore({});

      const now = Date.now();
      const jobId = "job_final_reply_citations";
      const childId = "child_final_reply_citations";
      const runId = "run-final-reply";
      const opId = "op-final-reply";
      const graphId = "graph-final-reply";
      const nodeId = "node-final-reply";

      graphState.createJob(jobId, { goal: "Verify final reply citations", createdAt: now, state: "running" });
      graphState.createChild(jobId, childId, { name: "Responder", runtime: "codex" }, { createdAt: now, ttlAt: null });

      childProcessSupervisor.childrenIndex.registerChild({
        childId,
        pid: 5252,
        workdir: "/tmp/test-final-reply",
        state: "ready",
        startedAt: now,
        metadata: { job_id: jobId, run_id: runId, op_id: opId, graph_id: graphId, node_id: nodeId },
      });

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      // Prime the EventStore with provenance-bearing events so the collector can
      // surface deterministic citations once the reply completes.
      eventStore.emit({
        kind: "INFO",
        jobId,
        childId,
        provenance: [{ sourceId: "doc://alpha", type: "url", confidence: 0.4 }],
      });
      eventStore.emit({
        kind: "INFO",
        jobId,
        childId,
        provenance: [
          { sourceId: "doc://beta", type: "rag", confidence: 0.9 },
          { sourceId: "doc://alpha", type: "url", confidence: 0.7, span: [5, 15] },
        ],
      });

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
        events: Array<{ kind: string; data: { citations?: Array<{ sourceId: string; type: string; span?: [number, number]; confidence?: number }> } }>;
      };

      const replyEvent = structured.events.find((event) => event.kind === "REPLY");
      expect(replyEvent, "REPLY event should be present").to.not.equal(undefined);
      const expectedCitations = [
        { sourceId: "doc://beta", type: "rag", confidence: 0.9 },
        { sourceId: "doc://alpha", type: "url", confidence: 0.7, span: [5, 15] },
      ];
      expect(replyEvent?.data?.citations).to.deep.equal(expectedCitations);

      const replyEvents = eventStore.list({ jobId, kinds: ["REPLY"], reverse: true, limit: 1 });
      expect(replyEvents).to.have.length(1);
      expect(replyEvents[0]?.provenance).to.deep.equal(expectedCitations);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
