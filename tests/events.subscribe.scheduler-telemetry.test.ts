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
import {
  assertArray,
  assertNumber,
  assertPlainObject,
  assertString,
  isPlainObject,
} from "./helpers/assertions.js";
import type { EventPayload } from "../src/events/types.js";

type SchedulerEventEnqueuedPayload = EventPayload<"scheduler_event_enqueued">;
type SchedulerTickResultPayload = EventPayload<"scheduler_tick_result">;
type SchedulerTelemetryPayload = SchedulerEventEnqueuedPayload | SchedulerTickResultPayload;

/**
 * Runtime guard narrowing arbitrary JSON objects to {@link SchedulerTelemetryPayload}. The helper
 * asserts numeric fields and correlation hints so arithmetic parity checks remain honest across
 * transports while still providing rich TypeScript narrowing for the assertions below.
 */
function assertSchedulerTelemetryPayload(
  value: unknown,
  description: string,
): asserts value is SchedulerTelemetryPayload {
  assertPlainObject(value, description);
  assertString(value.msg, `${description}.msg`);
  assertString(value.event_type, `${description}.event_type`);
  assertNumber(value.pending, `${description}.pending`);
  assertNumber(value.pending_before, `${description}.pending_before`);
  assertNumber(value.pending_after, `${description}.pending_after`);
  assertNumber(value.base_priority, `${description}.base_priority`);
  assertNumber(value.enqueued_at_ms, `${description}.enqueued_at_ms`);
  assertNumber(value.sequence, `${description}.sequence`);
  assertPlainObject(value.event_payload, `${description}.event_payload`);

  const correlationFields = ["run_id", "op_id", "job_id", "graph_id", "node_id", "child_id"] as const;
  for (const field of correlationFields) {
    expect(field in value, `${description}.${field} should be present`).to.equal(true);
    const fieldValue = (value as Record<string, unknown>)[field];
    expect(
      fieldValue === null || typeof fieldValue === "string",
      `${description}.${field} should be null or string`,
    ).to.equal(true);
  }

  if (value.msg === "scheduler_event_enqueued") {
    expect(value.duration_ms, `${description}.duration_ms`).to.equal(null);
    expect(value.batch_index, `${description}.batch_index`).to.equal(null);
    expect(value.ticks_in_batch, `${description}.ticks_in_batch`).to.equal(null);
    expect(value.priority, `${description}.priority`).to.equal(undefined);
    expect(value.status, `${description}.status`).to.equal(undefined);
    expect(value.source_event, `${description}.source_event`).to.equal(undefined);
    return;
  }

  assertNumber(value.duration_ms, `${description}.duration_ms`);
  assertNumber(value.batch_index, `${description}.batch_index`);
  assertNumber(value.ticks_in_batch, `${description}.ticks_in_batch`);
  assertNumber(value.priority, `${description}.priority`);
  assertString(value.status, `${description}.status`);
  assertString(value.source_event, `${description}.source_event`);
}

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
      const baselineContent = baselineResponse.structuredContent;
      assertPlainObject(baselineContent, "baseline events_subscribe content");
      const cursorCandidate = baselineContent.next_seq;
      const cursor = typeof cursorCandidate === "number" ? cursorCandidate : 0;

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
      const jsonlinesStructured = jsonlinesResponse.structuredContent;
      assertPlainObject(jsonlinesStructured, "scheduler JSON Lines response");
      const eventsValue = jsonlinesStructured.events;
      assertArray(eventsValue, "scheduler JSON Lines events");

      const schedulerEvents: Array<Record<string, unknown>> = [];
      for (const candidate of eventsValue) {
        if (!isPlainObject(candidate)) {
          continue;
        }
        if (candidate.kind !== "SCHEDULER") {
          continue;
        }
        schedulerEvents.push(candidate);
      }

      expect(schedulerEvents.length, "Scheduler telemetry should be exposed via JSON Lines").to.be.greaterThan(1);
      for (const event of schedulerEvents) {
        expect(event.run_id).to.equal(runId);
        expect(event.op_id).to.equal(opId);
        expect(event.job_id).to.equal(jobId);
        expect(event.graph_id).to.equal(graphId);
        expect(event.node_id).to.equal(nodeId);
      }

      const enqueuedEvent = schedulerEvents.find(
        (event) => isPlainObject(event.data) && event.data.msg === "scheduler_event_enqueued",
      );
      expect(enqueuedEvent, "scheduler_event_enqueued payload should be present").to.not.equal(undefined);
      if (!enqueuedEvent || !isPlainObject(enqueuedEvent.data)) {
        throw new Error("scheduler_event_enqueued payload should be present");
      }
      assertSchedulerTelemetryPayload(enqueuedEvent.data, "jsonlines scheduler_event_enqueued payload");
      const enqueuedPayload = enqueuedEvent.data;
      expect(enqueuedPayload.event_type).to.equal("taskReady");
      expect(enqueuedPayload.msg).to.equal("scheduler_event_enqueued");
      expect(enqueuedPayload.pending_before).to.equal(Math.max(0, enqueuedPayload.pending - 1));
      expect(enqueuedPayload.pending_after).to.equal(enqueuedPayload.pending);
      expect(enqueuedPayload.batch_index).to.equal(null);
      expect(enqueuedPayload.duration_ms).to.equal(null);
      expect(enqueuedPayload.ticks_in_batch).to.equal(null);
      const enqueuedPending = enqueuedPayload.pending;
      const enqueuedPendingBefore = enqueuedPayload.pending_before;
      const enqueuedPendingAfter = enqueuedPayload.pending_after;
      const enqueuedBasePriority = enqueuedPayload.base_priority;
      const enqueuedSequence = enqueuedPayload.sequence;

      const tickResultEvent = schedulerEvents.find(
        (event) => isPlainObject(event.data) && event.data.msg === "scheduler_tick_result",
      );
      expect(tickResultEvent, "scheduler_tick_result payload should be present").to.not.equal(undefined);
      if (!tickResultEvent || !isPlainObject(tickResultEvent.data)) {
        throw new Error("scheduler_tick_result payload should be present");
      }
      assertSchedulerTelemetryPayload(tickResultEvent.data, "jsonlines scheduler_tick_result payload");
      const tickPayload = tickResultEvent.data;
      expect(tickPayload.event_type).to.equal("tick_result");
      expect(tickPayload.duration_ms).to.not.equal(null);
      expect(tickPayload.batch_index).to.not.equal(null);
      expect(tickPayload.ticks_in_batch).to.not.equal(null);
      if (tickPayload.duration_ms === null || tickPayload.batch_index === null || tickPayload.ticks_in_batch === null) {
        throw new Error("scheduler_tick_result payload should expose duration and batch metrics");
      }
      const tickPending = tickPayload.pending;
      const tickPendingBefore = tickPayload.pending_before;
      const tickPendingAfter = tickPayload.pending_after;
      const tickBasePriority = tickPayload.base_priority;
      const tickSequence = tickPayload.sequence;
      const tickBatchIndex = tickPayload.batch_index;
      const tickTicksInBatch = tickPayload.ticks_in_batch;

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
      const sseStructured = sseResponse.structuredContent;
      assertPlainObject(sseStructured, "scheduler SSE response");
      assertString(sseStructured.stream, "scheduler SSE stream");

      // Parse the SSE framing so the assertions can validate both the transport-level
      // event name (`event:`) and the JSON payload delivered to streaming clients.
      const parsedStream = parseSseStream(sseStructured.stream);
      const schedulerStreamEvents = parsedStream.filter((entry) => entry.event === "SCHEDULER");
      expect(
        schedulerStreamEvents.length,
        "Scheduler SSE payload should expose the SCHEDULER event type",
      ).to.be.greaterThan(0);

      const decodedSseEvents = schedulerStreamEvents.flatMap((entry) => entry.data.map((chunk) => JSON.parse(chunk)));

      const correlatedSseEvents: Array<Record<string, unknown>> = [];
      for (const candidate of decodedSseEvents) {
        if (!isPlainObject(candidate)) {
          continue;
        }
        if (candidate.kind !== "SCHEDULER") {
          continue;
        }
        correlatedSseEvents.push(candidate);
      }
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

      const sseEnqueuedEvent = correlatedSseEvents.find(
        (event) => isPlainObject(event.data) && event.data.msg === "scheduler_event_enqueued",
      );
      expect(sseEnqueuedEvent, "SSE stream should include the enqueue telemetry").to.not.equal(undefined);
      if (!sseEnqueuedEvent || !isPlainObject(sseEnqueuedEvent.data)) {
        throw new Error("scheduler_event_enqueued SSE payload should be present");
      }
      assertSchedulerTelemetryPayload(sseEnqueuedEvent.data, "sse scheduler_event_enqueued payload");
      const sseEnqueuedPayload = sseEnqueuedEvent.data;
      expect(sseEnqueuedPayload.event_type).to.equal("taskReady");
      expect(sseEnqueuedPayload.msg).to.equal("scheduler_event_enqueued");
      expect(sseEnqueuedPayload.pending_before).to.equal(Math.max(0, sseEnqueuedPayload.pending - 1));
      expect(sseEnqueuedPayload.pending_after).to.equal(sseEnqueuedPayload.pending);
      expect(sseEnqueuedPayload.batch_index).to.equal(null);
      expect(sseEnqueuedPayload.duration_ms).to.equal(null);
      expect(sseEnqueuedPayload.ticks_in_batch).to.equal(null);
      const sseEnqueuedPending = sseEnqueuedPayload.pending;
      const sseEnqueuedPendingBefore = sseEnqueuedPayload.pending_before;
      const sseEnqueuedPendingAfter = sseEnqueuedPayload.pending_after;
      const sseEnqueuedBasePriority = sseEnqueuedPayload.base_priority;
      const sseEnqueuedSequence = sseEnqueuedPayload.sequence;

      const sseTickResultEvent = correlatedSseEvents.find(
        (event) => isPlainObject(event.data) && event.data.msg === "scheduler_tick_result",
      );
      expect(sseTickResultEvent, "SSE stream should include the tick telemetry").to.not.equal(undefined);
      if (!sseTickResultEvent || !isPlainObject(sseTickResultEvent.data)) {
        throw new Error("scheduler_tick_result SSE payload should be present");
      }
      assertSchedulerTelemetryPayload(sseTickResultEvent.data, "sse scheduler_tick_result payload");
      const sseTickPayload = sseTickResultEvent.data;
      expect(sseTickPayload.msg).to.equal("scheduler_tick_result");
      expect(sseTickPayload.event_type).to.equal("tick_result");
      expect(sseTickPayload.status).to.equal("success");
      expect(sseTickPayload.duration_ms).to.not.equal(null);
      expect(sseTickPayload.batch_index).to.not.equal(null);
      expect(sseTickPayload.ticks_in_batch).to.not.equal(null);
      if (sseTickPayload.duration_ms === null || sseTickPayload.batch_index === null || sseTickPayload.ticks_in_batch === null) {
        throw new Error("scheduler_tick_result SSE payload should expose duration and batch metrics");
      }
      const sseTickPending = sseTickPayload.pending;
      const sseTickPendingBefore = sseTickPayload.pending_before;
      const sseTickPendingAfter = sseTickPayload.pending_after;
      const sseTickBasePriority = sseTickPayload.base_priority;
      const sseTickSequence = sseTickPayload.sequence;
      const sseTickBatchIndex = sseTickPayload.batch_index;
      const sseTickTicksInBatch = sseTickPayload.ticks_in_batch;

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
