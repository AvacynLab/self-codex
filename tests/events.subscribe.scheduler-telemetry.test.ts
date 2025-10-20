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
import { parseSseStream } from "./helpers/sse.js";

/**
 * Integration coverage ensuring that the unified MCP event bus exposes
 * scheduler telemetry emitted by the reactive plan runner. The scenario runs a
 * trivial reactive plan, tails the `events_subscribe` tool for `SCHEDULER`
 * entries and verifies that both JSON Lines and SSE variants surface the
 * enriched correlation hints propagated by the telemetry hook.
 */
describe("events subscribe scheduler telemetry", () => {
  it("streams correlated scheduler events across JSON Lines and SSE", async function () {
    this.timeout(15000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-scheduler", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enableReactiveScheduler: true,
        enablePlanLifecycle: true,
        enableBT: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "scheduler-telemetry" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const runId = "scheduler-telemetry-run";
      const opId = "scheduler-telemetry-op";
      const jobId = "scheduler-telemetry-job";
      const graphId = "scheduler-telemetry-graph";
      const nodeId = "scheduler-telemetry-node";

      const reactiveResponse = await client.callTool({
        name: "plan_run_reactive",
        arguments: {
          tree: {
            id: "scheduler-telemetry-tree",
            root: { type: "task", id: "root", node_id: "root", tool: "noop", input_key: "payload" },
          },
          variables: { payload: { ping: "scheduler" } },
          tick_ms: 10,
          timeout_ms: 250,
          run_id: runId,
          op_id: opId,
          job_id: jobId,
          graph_id: graphId,
          node_id: nodeId,
        },
      });
      expect(reactiveResponse.isError ?? false).to.equal(false);

      const jsonlinesResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["scheduler"],
          run_id: runId,
          format: "jsonlines",
        },
      });
      expect(jsonlinesResponse.isError ?? false).to.equal(false);
      const jsonlinesStructured = jsonlinesResponse.structuredContent as {
        events: Array<{
          kind: string;
          run_id: string | null;
          op_id: string | null;
          job_id: string | null;
          graph_id: string | null;
          node_id: string | null;
          child_id: string | null;
          data?: Record<string, unknown> | null;
        }>;
      };

      const schedulerEvents = jsonlinesStructured.events.filter((event) => event.kind === "SCHEDULER");
      expect(schedulerEvents.length, "Scheduler telemetry should be exposed via JSON Lines").to.be.greaterThan(1);
      for (const event of schedulerEvents) {
        expect(event.run_id).to.equal(runId);
        expect(event.op_id).to.equal(opId);
        expect(event.job_id).to.equal(jobId);
        expect(event.graph_id).to.equal(graphId);
        expect(event.node_id).to.equal(nodeId);
      }

      const enqueuedEvent = schedulerEvents.find((event) => {
        const payload = (event.data ?? {}) as { event_type?: string };
        return payload.event_type === "taskReady";
      });
      expect(enqueuedEvent, "scheduler_event_enqueued payload should be present").to.not.equal(undefined);
      // JSON Lines payload must mirror the queue telemetry exposed to SSE
      // subscribers. The scheduler now surfaces both queue depths directly, so
      // these assertions confirm the instrumentation propagates the explicit
      // `pending_before` snapshot alongside the post-enqueue depth.
      const enqueuedPayload = (enqueuedEvent?.data ?? {}) as {
        event_type?: unknown;
        msg?: unknown;
        pending?: unknown;
        pending_before?: unknown;
        pending_after?: unknown;
        base_priority?: unknown;
        batch_index?: unknown;
        duration_ms?: unknown;
        sequence?: unknown;
        ticks_in_batch?: unknown;
      };
      expect(enqueuedPayload.event_type).to.equal("taskReady");
      expect(enqueuedPayload.msg).to.equal("scheduler_event_enqueued");
      expect(typeof enqueuedPayload.pending).to.equal("number");
      expect(typeof enqueuedPayload.pending_before).to.equal("number");
      expect(typeof enqueuedPayload.pending_after).to.equal("number");
      if (typeof enqueuedPayload.pending === "number" && typeof enqueuedPayload.pending_before === "number") {
        expect(enqueuedPayload.pending_before).to.equal(
          Math.max(0, enqueuedPayload.pending - 1),
        );
      }
      if (
        typeof enqueuedPayload.pending === "number" &&
        typeof enqueuedPayload.pending_after === "number"
      ) {
        // The post-enqueue depth mirrors the `pending` counter exposed to
        // streaming clients, so parity requires both fields to match exactly.
        expect(enqueuedPayload.pending_after).to.equal(enqueuedPayload.pending);
      }
      expect(typeof enqueuedPayload.base_priority).to.equal("number");
      expect(enqueuedPayload.batch_index).to.equal(null);
      expect(enqueuedPayload.duration_ms).to.equal(null);
      expect(typeof enqueuedPayload.sequence).to.equal("number");
      expect(enqueuedPayload.ticks_in_batch).to.equal(null);
      const enqueuedPending = enqueuedPayload.pending as number;
      const enqueuedPendingBefore = enqueuedPayload.pending_before as number;
      const enqueuedPendingAfter = enqueuedPayload.pending_after as number;
      const enqueuedBasePriority = enqueuedPayload.base_priority as number;
      const enqueuedSequence = enqueuedPayload.sequence as number;

      const tickResultEvent = schedulerEvents.find((event) => {
        const payload = (event.data ?? {}) as { status?: string };
        return payload.status === "success";
      });
      expect(tickResultEvent, "scheduler_tick_result payload should be present").to.not.equal(undefined);
      // The tick result telemetry carries aggregated metrics describing the
      // scheduler batch execution. Ensuring JSON Lines includes the "after"
      // queue depth and `ticks_in_batch` count prevents future regressions when
      // SSE clients rely on these fields for parity with the streaming view.
      const tickPayload = (tickResultEvent?.data ?? {}) as {
        msg?: unknown;
        event_type?: unknown;
        duration_ms?: unknown;
        batch_index?: unknown;
        pending?: unknown;
        pending_before?: unknown;
        pending_after?: unknown;
        base_priority?: unknown;
        sequence?: unknown;
        ticks_in_batch?: unknown;
      };
      expect(tickPayload.msg).to.equal("scheduler_tick_result");
      expect(tickPayload.event_type).to.equal("tick_result");
      expect(typeof tickPayload.duration_ms).to.equal("number");
      expect(typeof tickPayload.batch_index).to.equal("number");
      expect(typeof tickPayload.pending).to.equal("number");
      expect(typeof tickPayload.pending_before).to.equal("number");
      expect(typeof tickPayload.pending_after).to.equal("number");
      expect(typeof tickPayload.base_priority).to.equal("number");
      expect(typeof tickPayload.sequence).to.equal("number");
      expect(typeof tickPayload.ticks_in_batch).to.equal("number");
      const tickPending = tickPayload.pending as number;
      const tickPendingBefore = tickPayload.pending_before as number;
      const tickPendingAfter = tickPayload.pending_after as number;
      const tickBasePriority = tickPayload.base_priority as number;
      const tickSequence = tickPayload.sequence as number;
      const tickBatchIndex = tickPayload.batch_index as number;
      const tickTicksInBatch = tickPayload.ticks_in_batch as number;

      const sseResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["scheduler"],
          run_id: runId,
          format: "sse",
        },
      });
      expect(sseResponse.isError ?? false).to.equal(false);
      const sseStructured = sseResponse.structuredContent as { stream: string };
      expect(typeof sseStructured.stream).to.equal("string");

      // Parse the SSE framing so the assertions can validate both the transport-level
      // event name (`event:`) and the JSON payload delivered to streaming clients.
      const parsedStream = parseSseStream(sseStructured.stream);
      const schedulerStreamEvents = parsedStream.filter((entry) => entry.event === "SCHEDULER");
      expect(
        schedulerStreamEvents.length,
        "Scheduler SSE payload should expose the SCHEDULER event type",
      ).to.be.greaterThan(0);

      const decodedSseEvents = schedulerStreamEvents.flatMap((entry) =>
        entry.data.map((chunk) =>
          JSON.parse(chunk) as {
            kind: string;
            run_id: string | null;
            op_id: string | null;
            job_id: string | null;
            graph_id: string | null;
            node_id: string | null;
            data?: Record<string, unknown> | null;
          },
        ),
      );

      const correlatedSseEvents = decodedSseEvents.filter((event) => event.kind === "SCHEDULER");
      expect(
        correlatedSseEvents.length,
        "Scheduler SSE events should carry the SCHEDULER kind in the payload",
      ).to.be.greaterThan(0);
      for (const event of correlatedSseEvents) {
        expect(event.run_id).to.equal(runId);
        expect(event.op_id).to.equal(opId);
        expect(event.job_id).to.equal(jobId);
        expect(event.graph_id).to.equal(graphId);
        expect(event.node_id).to.equal(nodeId);
      }

      const sseEnqueuedEvent = correlatedSseEvents.find((event) => {
        const payload = (event.data ?? {}) as { msg?: string | null };
        return payload.msg === "scheduler_event_enqueued";
      });
      expect(sseEnqueuedEvent, "SSE stream should include the enqueue telemetry").to.not.equal(undefined);
      const sseEnqueuedPayload = (sseEnqueuedEvent?.data ?? {}) as {
        event_type?: unknown;
        msg?: unknown;
        pending?: unknown;
        pending_before?: unknown;
        pending_after?: unknown;
        base_priority?: unknown;
        sequence?: unknown;
        batch_index?: unknown;
        duration_ms?: unknown;
        ticks_in_batch?: unknown;
      };
      expect(sseEnqueuedPayload.event_type).to.equal("taskReady");
      expect(sseEnqueuedPayload.msg).to.equal("scheduler_event_enqueued");
      expect(typeof sseEnqueuedPayload.pending).to.equal("number");
      expect(typeof sseEnqueuedPayload.pending_before).to.equal("number");
      expect(typeof sseEnqueuedPayload.pending_after).to.equal("number");
      if (
        typeof sseEnqueuedPayload.pending === "number" &&
        typeof sseEnqueuedPayload.pending_before === "number"
      ) {
        expect(sseEnqueuedPayload.pending_before).to.equal(
          Math.max(0, sseEnqueuedPayload.pending - 1),
        );
      }
      if (
        typeof sseEnqueuedPayload.pending === "number" &&
        typeof sseEnqueuedPayload.pending_after === "number"
      ) {
        // SSE consumers must observe the same queue depth snapshot as JSON
        // Lines clients, so `pending_after` mirrors the emitted `pending`
        // counter for the enqueue telemetry.
        expect(sseEnqueuedPayload.pending_after).to.equal(sseEnqueuedPayload.pending);
      }
      expect(typeof sseEnqueuedPayload.base_priority).to.equal("number");
      expect(sseEnqueuedPayload.batch_index).to.equal(null);
      expect(sseEnqueuedPayload.duration_ms).to.equal(null);
      expect(typeof sseEnqueuedPayload.sequence).to.equal("number");
      expect(sseEnqueuedPayload.ticks_in_batch).to.equal(null);
      const sseEnqueuedPending = sseEnqueuedPayload.pending as number;
      const sseEnqueuedPendingBefore = sseEnqueuedPayload.pending_before as number;
      const sseEnqueuedPendingAfter = sseEnqueuedPayload.pending_after as number;
      const sseEnqueuedBasePriority = sseEnqueuedPayload.base_priority as number;
      const sseEnqueuedSequence = sseEnqueuedPayload.sequence as number;

      const sseTickResultEvent = correlatedSseEvents.find((event) => {
        const payload = (event.data ?? {}) as { msg?: string | null };
        return payload.msg === "scheduler_tick_result";
      });
      expect(sseTickResultEvent, "SSE stream should include the tick telemetry").to.not.equal(undefined);
      const sseTickPayload = (sseTickResultEvent?.data ?? {}) as {
        status?: unknown;
        msg?: unknown;
        event_type?: unknown;
        duration_ms?: unknown;
        pending?: unknown;
        pending_before?: unknown;
        pending_after?: unknown;
        base_priority?: unknown;
        batch_index?: unknown;
        ticks_in_batch?: unknown;
        sequence?: unknown;
      };
      expect(sseTickPayload.status).to.equal("success");
      expect(sseTickPayload.msg).to.equal("scheduler_tick_result");
      expect(sseTickPayload.event_type).to.equal("tick_result");
      expect(typeof sseTickPayload.duration_ms).to.equal("number");
      expect(typeof sseTickPayload.pending).to.equal("number");
      expect(typeof sseTickPayload.pending_before).to.equal("number");
      expect(typeof sseTickPayload.pending_after).to.equal("number");
      expect(typeof sseTickPayload.base_priority).to.equal("number");
      expect(typeof sseTickPayload.batch_index).to.equal("number");
      expect(typeof sseTickPayload.ticks_in_batch).to.equal("number");
      expect(typeof sseTickPayload.sequence).to.equal("number");
      const sseTickPending = sseTickPayload.pending as number;
      const sseTickPendingBefore = sseTickPayload.pending_before as number;
      const sseTickPendingAfter = sseTickPayload.pending_after as number;
      const sseTickBasePriority = sseTickPayload.base_priority as number;
      const sseTickSequence = sseTickPayload.sequence as number;
      const sseTickBatchIndex = sseTickPayload.batch_index as number;
      const sseTickTicksInBatch = sseTickPayload.ticks_in_batch as number;

      // Assert transport parity: the JSON Lines and SSE payloads must expose the
      // exact same scheduler metrics so downstream observers can rely on either
      // transport interchangeably.
      expect(sseEnqueuedPending).to.equal(enqueuedPending);
      expect(sseEnqueuedPendingBefore).to.equal(enqueuedPendingBefore);
      expect(sseEnqueuedPendingAfter).to.equal(enqueuedPendingAfter);
      expect(sseEnqueuedBasePriority).to.equal(enqueuedBasePriority);
      expect(sseEnqueuedSequence).to.equal(enqueuedSequence);

      expect(sseTickPending).to.equal(tickPending);
      expect(sseTickPendingBefore).to.equal(tickPendingBefore);
      expect(sseTickPendingAfter).to.equal(tickPendingAfter);
      expect(sseTickBasePriority).to.equal(tickBasePriority);
      expect(sseTickSequence).to.equal(tickSequence);
      expect(sseTickBatchIndex).to.equal(tickBatchIndex);
      expect(sseTickTicksInBatch).to.equal(tickTicksInBatch);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
