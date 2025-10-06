import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../src/server.js";
import { parseSseStream } from "./helpers/sse.js";
import type { ChildCollectedOutputs, ChildRuntimeMessage } from "../src/childRuntime.js";

/**
 * Builds a deterministic snapshot of collected outputs for a child. The helper keeps the
 * stubbed supervisor interactions compact while documenting the message semantics exercised
 * by the join/reduce tools.
 */
function buildCollectedOutputs(
  childId: string,
  content: string,
  receivedAt: number,
): ChildCollectedOutputs {
  const message: ChildRuntimeMessage<{ type: string; content: string }> = {
    raw: JSON.stringify({ type: "response", content }),
    parsed: { type: "response", content },
    stream: "stdout",
    receivedAt,
    sequence: 1,
  };
  return {
    childId,
    manifestPath: `/tmp/${childId}-manifest.json`,
    logPath: `/tmp/${childId}-logs.json`,
    messages: [message],
    artifacts: [],
  };
}

/**
 * Exercises the `plan_join` and `plan_reduce` MCP tools while validating that
 * the unified events bus exposes `STATUS` and `AGGREGATE` entries with full
 * correlation metadata over `events_subscribe`.
 */
describe("events subscribe plan status and aggregate", () => {
  it("streams correlated plan join status and reduce aggregate events", async function () {
    this.timeout(15000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-plan", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const collectStub = sinon.stub(childSupervisor, "collect");
    const waitStub = sinon.stub(childSupervisor, "waitForMessage");

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-events" } });
      childSupervisor.childrenIndex.restore({});

      const now = Date.now();
      const jobId = "job_plan_events";
      const runId = "run_plan_events";
      const opId = "op_plan_events";
      const graphId = "graph_plan_events";
      const nodeId = "node_plan_events";
      const parentChildId = "child_plan_parent";

      const collectedByChild: Record<string, ChildCollectedOutputs> = {
        child_alpha: buildCollectedOutputs("child_alpha", "approve", now + 1),
        child_beta: buildCollectedOutputs("child_beta", "approve", now + 2),
      };

      collectStub.callsFake(async (requested) => {
        const snapshot = collectedByChild[requested as keyof typeof collectedByChild];
        if (!snapshot) {
          throw new Error(`unexpected collect request for ${requested}`);
        }
        // Return a shallow clone to mimic distinct supervisor snapshots.
        return {
          ...snapshot,
          messages: [...snapshot.messages],
          artifacts: [...snapshot.artifacts],
        } satisfies ChildCollectedOutputs;
      });
      waitStub.rejects(new Error("waitForMessage should not be invoked when existing outputs are terminal"));

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const joinResponse = await client.callTool({
        name: "plan_join",
        arguments: {
          children: Object.keys(collectedByChild),
          join_policy: "quorum",
          quorum_count: 2,
          run_id: runId,
          op_id: opId,
          job_id: jobId,
          graph_id: graphId,
          node_id: nodeId,
          child_id: parentChildId,
        },
      });
      expect(joinResponse.isError ?? false).to.equal(false);

      const reduceResponse = await client.callTool({
        name: "plan_reduce",
        arguments: {
          children: Object.keys(collectedByChild),
          reducer: "vote",
          spec: { mode: "weighted", quorum: 2, weights: { child_alpha: 2, child_beta: 1 } },
          run_id: runId,
          op_id: opId,
          job_id: jobId,
          graph_id: graphId,
          node_id: nodeId,
          child_id: parentChildId,
        },
      });
      expect(reduceResponse.isError ?? false).to.equal(false);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["status", "aggregate"],
          run_id: runId,
          format: "jsonlines",
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
          data: Record<string, unknown> | null;
        }>;
      };

      const statusEvent = structured.events.find((event) => event.kind === "STATUS");
      expect(statusEvent, "plan_join STATUS event should be published").to.not.equal(undefined);
      expect(statusEvent?.job_id).to.equal(jobId);
      expect(statusEvent?.run_id).to.equal(runId);
      expect(statusEvent?.op_id).to.equal(opId);
      expect(statusEvent?.graph_id).to.equal(graphId);
      expect(statusEvent?.node_id).to.equal(nodeId);
      expect(statusEvent?.child_id).to.equal(parentChildId);
      const statusPayload = (statusEvent?.data ?? {}) as {
        policy?: string;
        run_id?: string;
        child_id?: string | null;
      };
      expect(statusPayload?.policy).to.equal("quorum");
      expect(statusPayload?.run_id).to.equal(runId);
      expect(statusPayload?.child_id).to.equal(parentChildId);

      const aggregateEvent = structured.events.find((event) => event.kind === "AGGREGATE");
      expect(aggregateEvent, "plan_reduce AGGREGATE event should be published").to.not.equal(undefined);
      expect(aggregateEvent?.job_id).to.equal(jobId);
      expect(aggregateEvent?.run_id).to.equal(runId);
      expect(aggregateEvent?.op_id).to.equal(opId);
      expect(aggregateEvent?.graph_id).to.equal(graphId);
      expect(aggregateEvent?.node_id).to.equal(nodeId);
      expect(aggregateEvent?.child_id).to.equal(parentChildId);
      const aggregatePayload = (aggregateEvent?.data ?? {}) as {
        reducer?: string;
        run_id?: string;
        child_id?: string | null;
      };
      expect(aggregatePayload?.reducer).to.equal("vote");
      expect(aggregatePayload?.run_id).to.equal(runId);
      expect(aggregatePayload?.child_id).to.equal(parentChildId);

      // Request the SSE representation to ensure streaming clients receive the same
      // correlation hints. The helper splits the transport framing before decoding
      // the JSON payload for each event entry.
      const sseResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["status", "aggregate"],
          run_id: runId,
          format: "sse",
        },
      });
      expect(sseResponse.isError ?? false).to.equal(false);
      const sseStructured = sseResponse.structuredContent as { stream: string };
      expect(typeof sseStructured.stream).to.equal("string");

      const parsedStream = parseSseStream(sseStructured.stream);
      const statusStreamEvent = parsedStream.find((entry) => entry.event === "STATUS");
      expect(statusStreamEvent, "SSE payload should tag STATUS records with the STATUS event type").to.not.equal(
        undefined,
      );
      const aggregateStreamEvent = parsedStream.find((entry) => entry.event === "AGGREGATE");
      expect(aggregateStreamEvent, "SSE payload should tag AGGREGATE records with the AGGREGATE event type").to.not.equal(
        undefined,
      );

      const decodedEvents = parsedStream.flatMap((entry) =>
        entry.data.map((chunk) => JSON.parse(chunk) as {
          kind: string;
          job_id: string | null;
          run_id: string | null;
          op_id: string | null;
          graph_id: string | null;
          node_id: string | null;
          child_id: string | null;
        }),
      );

      const sseStatus = decodedEvents.find((event) => event.kind === "STATUS");
      expect(sseStatus, "SSE STATUS event should carry correlation hints").to.not.equal(undefined);
      expect(sseStatus?.job_id).to.equal(jobId);
      expect(sseStatus?.run_id).to.equal(runId);
      expect(sseStatus?.op_id).to.equal(opId);
      expect(sseStatus?.graph_id).to.equal(graphId);
      expect(sseStatus?.node_id).to.equal(nodeId);
      expect(sseStatus?.child_id).to.equal(parentChildId);

      const sseAggregate = decodedEvents.find((event) => event.kind === "AGGREGATE");
      expect(sseAggregate, "SSE AGGREGATE event should carry correlation hints").to.not.equal(undefined);
      expect(sseAggregate?.job_id).to.equal(jobId);
      expect(sseAggregate?.run_id).to.equal(runId);
      expect(sseAggregate?.op_id).to.equal(opId);
      expect(sseAggregate?.graph_id).to.equal(graphId);
      expect(sseAggregate?.node_id).to.equal(nodeId);
      expect(sseAggregate?.child_id).to.equal(parentChildId);
    } finally {
      collectStub.restore();
      waitStub.restore();
      configureRuntimeFeatures(baselineFeatures);
      childSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
