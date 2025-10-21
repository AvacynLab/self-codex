import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ChildCollectedOutputs, ChildRuntimeMessage } from "../src/childRuntime.js";
import { assertArray, assertPlainObject, isPlainObject } from "./helpers/assertions.js";

/**
 * Exercises the `child_collect` tool to ensure cognitive review/reflection events emitted by
 * the orchestrator are exposed through `events_subscribe` with full correlation metadata.
 * The scenario relies on a stubbed supervisor collection so the test can focus purely on the
 * event bus plumbing without spawning real child processes.
 */
describe("events subscribe cognitive correlation", () => {
  it("streams correlated cognitive review and reflection events", async function () {
    this.timeout(15000);

    // Use a dynamic import here so tsx keeps the module in ESM mode – bundling the server
    // with CommonJS output would choke on the top-level await initialisers we rely on in
    // production. This keeps the test portable while matching the real runtime behaviour.
    const {
      server,
      graphState,
      childProcessSupervisor,
      configureRuntimeFeatures,
      getRuntimeFeatures,
    } = await import("../src/server.js");

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-cognitive", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const collectStub = sinon.stub(childProcessSupervisor, "collect");

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "cognitive-events" } });
      childProcessSupervisor.childrenIndex.restore({});

      const now = Date.now();
      const jobId = "job_cognitive_events";
      const childId = "child_cognitive_events";
      const runId = "run_cognitive_events";
      const opId = "op_cognitive_events";
      const graphId = "graph_cognitive_events";
      const nodeId = "node_cognitive_events";

      graphState.createJob(jobId, { goal: "Validate cognitive event correlations", createdAt: now, state: "running" });
      graphState.createChild(jobId, childId, { name: "Analyst", runtime: "codex" }, { createdAt: now, ttlAt: null });
      childProcessSupervisor.childrenIndex.registerChild({
        childId,
        pid: 4242,
        workdir: "/tmp/child-cognitive",
        state: "ready",
        startedAt: now,
        metadata: {
          job_id: jobId,
          run_id: runId,
          op_id: opId,
          graph_id: graphId,
          node_id: nodeId,
        },
      });

      const recordedMessage: ChildRuntimeMessage = {
        raw: JSON.stringify({ role: "assistant", content: "Livraison du module avec tests." }),
        parsed: { role: "assistant", content: "Livraison du module avec tests." },
        stream: "stdout",
        receivedAt: now,
        sequence: 0,
      };

      const collectedOutputs: ChildCollectedOutputs = {
        childId,
        manifestPath: "/tmp/child-cognitive/outbox/manifest.json",
        logPath: "/tmp/child-cognitive/logs/out.log",
        messages: [recordedMessage],
        artifacts: [
          {
            path: "rapport.txt",
            size: 256,
            mimeType: "text/plain",
            sha256: "0".repeat(64),
          },
        ],
      };

      collectStub.resolves(collectedOutputs);

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const collectResponse = await client.callTool({ name: "child_collect", arguments: { child_id: childId } });
      expect(collectResponse.isError ?? false).to.equal(false);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["cognitive"],
          child_id: childId,
        },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);

      const structured = eventsResponse.structuredContent;
      assertPlainObject(structured, "cognitive events payload");
      const events = structured.events;
      assertArray(events, "cognitive events list");

      const reviewEvent = events.find(
        (event): event is Record<string, unknown> =>
          isPlainObject(event) && isPlainObject(event.data) && event.data.msg === "child_meta_review",
      );
      expect(reviewEvent, "child_meta_review event should be published").to.not.equal(undefined);
      if (!reviewEvent) {
        throw new Error("child_meta_review event should be published");
      }
      expect(reviewEvent.kind).to.equal("COGNITIVE");
      expect(reviewEvent.job_id).to.equal(jobId);
      expect(reviewEvent.run_id).to.equal(runId);
      expect(reviewEvent.op_id).to.equal(opId);
      expect(reviewEvent.graph_id).to.equal(graphId);
      expect(reviewEvent.node_id).to.equal(nodeId);
      expect(reviewEvent.child_id).to.equal(childId);

      const reflectionEvent = events.find(
        (event): event is Record<string, unknown> =>
          isPlainObject(event) && isPlainObject(event.data) && event.data.msg === "child_reflection",
      );
      expect(reflectionEvent, "child_reflection event should be published").to.not.equal(undefined);
      if (!reflectionEvent) {
        throw new Error("child_reflection event should be published");
      }
      expect(reflectionEvent.kind).to.equal("COGNITIVE");
      expect(reflectionEvent.job_id).to.equal(jobId);
      expect(reflectionEvent.run_id).to.equal(runId);
      expect(reflectionEvent.op_id).to.equal(opId);
      expect(reflectionEvent.graph_id).to.equal(graphId);
      expect(reflectionEvent.node_id).to.equal(nodeId);
      expect(reflectionEvent.child_id).to.equal(childId);
    } finally {
      collectStub.restore();
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
