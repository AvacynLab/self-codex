import { describe, it } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childSupervisor,
  getRuntimeFeatures,
  configureRuntimeFeatures,
} from "../src/server.js";
import {
  registerCancellation,
  requestCancellation,
  resetCancellationRegistry,
} from "../src/executor/cancel.js";
import { parseSseStream } from "./helpers/sse.js";

/**
 * Integration coverage asserting that the SSE variant of `events_subscribe`
 * keeps `data:` lines single-line even when cancellation reasons include raw
 * carriage returns or Unicode line separators. The scenario seeds a cancellation
 * handle directly so the emitted bus event contains the crafted reason and then
 * fetches the SSE stream to verify both the transport encoding and payload
 * fidelity.
 */
describe("events subscribe SSE escaping", () => {
  it("keeps SSE data lines single-line while preserving cancellation payloads", async () => {
    const baselineGraph = graphState.serialize();
    const baselineChildren = childSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-sse-escaping-test", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true, enableCancellation: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "events-subscribe-sse" } });
      childSupervisor.childrenIndex.restore({});
      resetCancellationRegistry();

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const opId = "cancel-sse-op";
      const runId = "cancel-sse-run";
      const jobId = "cancel-sse-job";
      registerCancellation(opId, { runId, jobId, graphId: "cancel-sse-graph", nodeId: "cancel-sse-node" });

      const reason = "line\r\nseparator\u2028mix\u2029end";
      const outcome = requestCancellation(opId, { reason, at: Date.now() });
      expect(outcome).to.equal("requested");

      // Allow the event bus microtask queue to settle before querying the stream.
      await new Promise((resolve) => setImmediate(resolve));

      const response = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["cancel"],
          format: "sse",
        },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        stream: string;
        events: Array<{
          data?: { reason?: string | null } | null;
        }>;
      };

      const cancelEvents = structured.events.filter((event) => event.data?.reason === reason);
      expect(cancelEvents.length).to.be.greaterThan(0);

      expect(structured.stream.includes("\u2028"), "stream should escape U+2028").to.equal(false);
      expect(structured.stream.includes("\u2029"), "stream should escape U+2029").to.equal(false);

      // Parse the SSE stream as an EventSource client would so we can assert the
      // record-level framing in addition to inspecting raw `data:` lines.
      const parsedStream = parseSseStream(structured.stream);
      expect(parsedStream.length).to.be.greaterThan(0);

      let decodedReasonCount = 0;
      for (const event of parsedStream) {
        expect(event.data.length).to.be.greaterThan(0);
        for (const payload of event.data) {
          expect(payload).to.not.include("\r");
          expect(payload).to.not.include("\n");
          expect(payload).to.not.include("\u2028");
          expect(payload).to.not.include("\u2029");

          const decoded = JSON.parse(payload) as { data?: { reason?: string | null } };
          if (decoded.data?.reason === reason) {
            decodedReasonCount += 1;
          }
        }
      }
      expect(decodedReasonCount, "decoded payload should retain the original reason").to.be.greaterThan(0);
    } finally {
      resetCancellationRegistry();
      configureRuntimeFeatures(baselineFeatures);
      childSupervisor.childrenIndex.restore(baselineChildren);
      graphState.resetFromSnapshot(baselineGraph);
      await childSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
