import { describe, it } from "mocha";
import { expect } from "chai";
import type { IncomingMessage } from "node:http";
import sinon from "sinon";

import { GraphState } from "../src/graph/state.js";
import { EventStore } from "../src/eventStore.js";
import { StructuredLogger } from "../src/logger.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ContractNetWatcherTelemetryRecorder } from "../src/coord/contractNetWatchers.js";
import { BehaviorTreeStatusRegistry } from "../src/monitor/btStatusRegistry.js";
import type { SupervisorSchedulerSnapshot } from "../src/agents/supervisor.js";
import {
  DashboardSnapshot,
  createDashboardRouter,
  __testing as dashboardTesting,
} from "../src/monitor/dashboard.js";
import { createHttpRequest } from "./helpers/http.js";
import { StreamResponse, waitForSseEvents } from "./monitor/helpers/streamResponse.js";

/**
 * Minimal supervisor stub exposing the cancellation contract exercised by the
 * dashboard router when handling control requests.
 */
class StubSupervisor {
  public cancellations: string[] = [];

  async cancel(childId: string): Promise<void> {
    this.cancellations.push(childId);
  }
}

class StubSupervisorAgent {
  public snapshot: (SupervisorSchedulerSnapshot & { updatedAt: number }) | null = null;

  getLastSchedulerSnapshot(): (SupervisorSchedulerSnapshot & { updatedAt: number }) | null {
    return this.snapshot;
  }
}

/** Lightweight response mock capturing SSE payloads for assertions. */
/** Builds a mocked HTTP request accepted by the dashboard router. */
function createRequest(method: string, path: string, body?: unknown): IncomingMessage {
  const headers = {
    host: "dashboard.test",
    "content-type": "application/json",
  };

  if (typeof body === "string" || body instanceof Uint8Array) {
    return createHttpRequest(method, path, headers, body);
  }

  if (body && typeof body === "object") {
    return createHttpRequest(method, path, headers, body as Record<string, unknown>);
  }

  return createHttpRequest(method, path, headers);
}

describe("monitor/dashboard streams", () => {
  it("streams deterministic snapshots over SSE", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 50, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();
    const supervisorAgent = new StubSupervisorAgent();

    const createdAt = Date.now() - 1_000;
    graphState.createJob("job-1", { goal: "demo", createdAt, state: "running" });
    graphState.createChild(
      "job-1",
      "child-1",
      { name: "alpha", runtime: "codex" },
      { createdAt },
    );
    graphState.patchChild("child-1", { lastTs: createdAt + 200, priority: 2 });
    stigmergy.mark("node-alpha", "progress", 5);
    btStatusRegistry.reset("tree-demo", createdAt);
    btStatusRegistry.record("tree-demo", "node-root", "running", createdAt + 100);
    supervisorAgent.snapshot = {
      schedulerTick: 2,
      backlog: 3,
      completed: 1,
      failed: 0,
      updatedAt: createdAt + 250,
    };

    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor,
      logger,
      streamIntervalMs: 250,
      autoBroadcast: false,
      stigmergy,
      btStatusRegistry,
      supervisorAgent,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);

      expect(response.statusCode).to.equal(200);
      expect(response.headers["content-type"]).to.equal("text/event-stream; charset=utf-8");

      const initialEvents = await waitForSseEvents(response, 1);
      expect(initialEvents).to.have.lengthOf.at.least(1);

      const firstSnapshot = JSON.parse(initialEvents[0]) as DashboardSnapshot;
      expect(firstSnapshot.children).to.have.length(1);
      expect(firstSnapshot.children[0]).to.include({ id: "child-1" });
      expect(firstSnapshot.scheduler.backlog).to.equal(3);
      expect(firstSnapshot.heatmap.pheromones[0]?.childId).to.equal("node-alpha");
      expect(firstSnapshot.heatmap.pheromones[0]?.normalised ?? 0).to.be.within(0, 1);
      expect(firstSnapshot.behaviorTrees[0]?.treeId).to.equal("tree-demo");
      expect(firstSnapshot.pheromoneBounds?.min_intensity).to.equal(0);
      expect(firstSnapshot.pheromoneBounds?.normalisation_ceiling ?? 0).to.be.greaterThan(0);
      expect(firstSnapshot.heatmap.boundsTooltip).to.be.a("string");
      expect(firstSnapshot.stigmergy.bounds).to.not.equal(null);
      expect(firstSnapshot.stigmergy.rows[0]?.value).to.not.equal("n/a");
      expect(firstSnapshot.runtimeCosts.totalTokens).to.equal(0);
      expect(firstSnapshot.runtimeCosts.perChild).to.be.an("array");

      graphState.patchChild("child-1", { state: "completed", lastTs: createdAt + 800 });
      eventStore.emit({
        kind: "REPLY",
        level: "info",
        childId: "child-1",
        payload: { tokens: 12, elapsed_ms: 45 },
      });
      stigmergy.mark("node-alpha", "progress", 2);
      btStatusRegistry.record("tree-demo", "node-root", "success", createdAt + 900);
      supervisorAgent.snapshot = {
        schedulerTick: 4,
        backlog: 1,
        completed: 2,
        failed: 0,
        updatedAt: createdAt + 950,
      };

      router.broadcast();
      const afterBroadcast = await waitForSseEvents(response, initialEvents.length + 1);
      expect(afterBroadcast.length).to.be.greaterThan(initialEvents.length);

      const latestSnapshot = JSON.parse(afterBroadcast[afterBroadcast.length - 1]) as DashboardSnapshot;
      expect(latestSnapshot.children[0].state).to.equal("completed");
      expect(latestSnapshot.heatmap.tokens[0]?.value ?? 0).to.be.greaterThan(0);
      expect(latestSnapshot.heatmap.latency[0]?.value ?? 0).to.be.greaterThan(0);
      expect(latestSnapshot.runtimeCosts.totalTokens).to.be.greaterThan(0);
      expect(latestSnapshot.runtimeCosts.totalLatencyMs).to.be.greaterThan(0);
      expect(latestSnapshot.scheduler.backlog).to.equal(1);
      expect(latestSnapshot.behaviorTrees[0]?.nodes[0]?.status).to.equal("success");
      expect(latestSnapshot.pheromoneBounds?.normalisation_ceiling ?? 0).to.be.greaterThan(0);
      expect(latestSnapshot.heatmap.boundsTooltip).to.be.a("string");
      expect(latestSnapshot.stigmergy.rows.find((row) => row.label === "Max intensity")?.value).to.not.equal("n/a");
      expect(latestSnapshot.timeline.events).to.be.an("array");
      expect(latestSnapshot.timeline.events.some((event) => event.kind === "REPLY")).to.equal(true);
      expect(latestSnapshot.timeline.filters.kinds).to.include("REPLY");
      expect(latestSnapshot.consensus.recent).to.be.an("array");
      expect(latestSnapshot.thoughtGraph).to.be.an("array");
    } finally {
      await router.close();
    }
  });

  it("debounces manual SSE broadcasts to protect clients", async () => {
    const clock = sinon.useFakeTimers({ now: 0 });
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 10, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();

    graphState.createJob("job-sse-debounce", { goal: "demo", createdAt: 0, state: "running" });
    graphState.createChild("job-sse-debounce", "child-sse-debounce", { name: "delta", runtime: "codex" }, { createdAt: 0 });

    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor,
      logger,
      streamIntervalMs: 400,
      autoBroadcast: false,
      stigmergy,
      btStatusRegistry,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);

      expect(response.dataEvents.length, "initial snapshot should be delivered immediately").to.be.greaterThan(0);

      const initialCount = response.dataEvents.length;

      router.broadcast();
      router.broadcast();
      router.broadcast();

      expect(response.dataEvents.length, "broadcasts should be debounced before the delay elapses").to.equal(initialCount);

      await clock.tickAsync(200);
      expect(response.dataEvents.length, "no flush should occur before the debounce window expires").to.equal(initialCount);

      await clock.tickAsync(250);
      await clock.tickAsync(0);
      expect(response.dataEvents.length, "a single snapshot should flush after the debounce window").to.equal(initialCount + 1);

      router.broadcast();
      await clock.tickAsync(100);
      expect(response.dataEvents.length, "subsequent broadcasts within the debounce window remain coalesced").to.equal(
        initialCount + 1,
      );

      await clock.tickAsync(300);
      await clock.tickAsync(0);
      expect(response.dataEvents.length, "a later broadcast emits another snapshot once the window passes").to.equal(
        initialCount + 2,
      );
    } finally {
      await router.close();
      clock.restore();
    }
  });

  it("keeps SSE payloads single-line even when telemetry reasons span multiple lines", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();
    const contractNetWatcherTelemetry = new ContractNetWatcherTelemetryRecorder(() => 1_234);

    // Include classic CR/LF pairs and Unicode separators to mimic verbose watcher reasons.
    const multiLineReason = "first line\nsecond line\rthird line\u2028separator\u2029closing";
    contractNetWatcherTelemetry.record({
      reason: multiLineReason,
      receivedUpdates: 3,
      coalescedUpdates: 1,
      skippedRefreshes: 1,
      appliedRefreshes: 2,
      flushes: 1,
      lastBounds: {
        min_intensity: 0,
        max_intensity: null,
        normalisation_ceiling: 1,
      },
    });

    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor,
      logger,
      streamIntervalMs: 200,
      autoBroadcast: false,
      stigmergy,
      btStatusRegistry,
      contractNetWatcherTelemetry,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);

      const events = await waitForSseEvents(response, 1);
      expect(events.length).to.be.greaterThan(0);

      const payload = events[0];
      expect(payload).to.not.include("\n");
      expect(payload).to.not.include("\r");
      const snapshot = JSON.parse(payload) as DashboardSnapshot;
      expect(snapshot.contractNetWatcherTelemetry?.lastSnapshot?.reason).to.equal(multiLineReason);

      expect(response.body).to.not.include(String.fromCharCode(0x2028));
      expect(response.body).to.not.include(String.fromCharCode(0x2029));
      expect(response.body.includes("\\u2028")).to.equal(true);
      expect(response.body.includes("\\u2029")).to.equal(true);
    } finally {
      await router.close();
    }
  });

  it("caps search domain summaries when many ingestion events are recorded", () => {
    const clock = sinon.useFakeTimers({ now: 0 });
    try {
      const logger = new StructuredLogger();
      const eventStore = new EventStore({ maxHistory: 4_096, logger });

      // Prime the running queue with a handful of jobs so the summary exposes
      // both running and recently completed counters for visual regressions.
      const startedJobs = 5;
      for (let jobIndex = 0; jobIndex < startedJobs; jobIndex += 1) {
        eventStore.emit({ kind: "search:job_started", jobId: `job-${jobIndex}` });
      }

      // Feed more than the top-20 domain limit to ensure trimming occurs. The
      // repetition count decreases progressively so ordering is deterministic
      // even when the map iteration order changes.
      const totalDomains = 25;
      for (let domainIndex = 0; domainIndex < totalDomains; domainIndex += 1) {
        const domain = `docs${domainIndex}.example.com`;
        const repetitions = 5 - (domainIndex % 5);
        for (let repeat = 0; repeat < repetitions; repeat += 1) {
          clock.tick(200);
          eventStore.emit({
            kind: "search:doc_ingested",
            jobId: `job-${domainIndex}-${repeat}`,
            payload: {
              url: `https://${domain}/resource-${repeat}.html`,
              mime_type: domainIndex % 2 === 0 ? "text/html" : "application/pdf",
              fetched_at: Date.now() - 100,
              graph_ingested: repeat % 2 === 0,
              vector_ingested: true,
            },
          });
        }
      }

      // Surface a mix of error stages to confirm aggregation stays stable under
      // load and that counters remain sorted by frequency.
      eventStore.emit({ kind: "search:error", payload: { stage: "fetch" } });
      eventStore.emit({ kind: "search:error", payload: { stage: "extract" } });
      eventStore.emit({ kind: "search:error", payload: { stage: "fetch" } });

      // Mark one job as completed so the running counter reflects the eviction
      // logic that removes identifiers from the active set.
      clock.tick(500);
      eventStore.emit({ kind: "search:job_completed", jobId: "job-0" });

      const summary = dashboardTesting.summariseSearchActivity(eventStore, Date.now());

      expect(summary.queue.running, "only unfinished jobs remain in the running counter").to.equal(
        startedJobs - 1,
      );
      expect(summary.queue.errorsByStage[0]?.stage).to.equal("fetch");
      expect(summary.queue.errorsByStage[0]?.count).to.equal(2);

      expect(summary.topDomains.length, "top domains list is trimmed to 20 entries").to.equal(20);
      const counts = summary.topDomains.map((entry) => entry.count);
      for (let index = 1; index < counts.length; index += 1) {
        expect(counts[index]).to.be.at.most(counts[index - 1]);
      }

      expect(summary.contentLatency.length, "latency buckets are populated").to.be.greaterThan(0);
      expect(summary.contentLatency.every((entry) => entry.averageMs >= 0)).to.equal(true);
    } finally {
      clock.restore();
    }
  });
});
