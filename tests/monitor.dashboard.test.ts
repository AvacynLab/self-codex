import { describe, it } from "mocha";
import { expect } from "chai";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { EventStore } from "../src/eventStore.js";
import { GraphState } from "../src/graph/state.js";
import { StructuredLogger, type LogEntry } from "../src/logger.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ContractNetWatcherTelemetryRecorder } from "../src/coord/contractNetWatchers.js";
import { BehaviorTreeStatusRegistry } from "../src/monitor/btStatusRegistry.js";
import {
  createDashboardRouter,
  computeDashboardHeatmap,
  summariseRuntimeCosts,
  type DashboardSnapshot,
} from "../src/monitor/dashboard.js";
import {
  buildLessonsPromptPayload,
  normalisePromptBlueprint,
  normalisePromptMessages,
} from "../src/learning/lessonPromptDiff.js";
import { LogJournal } from "../src/monitor/log.js";
import type { ChildShutdownResult } from "../src/childRuntime.js";
import type { ChildSupervisor } from "../src/children/supervisor.js";

/**
 * Minimal supervisor stub satisfying the dashboard router contract. The class
 * records every cancelled child so assertions can verify the control endpoints.
 */
class StubSupervisor implements Pick<ChildSupervisor, "cancel"> {
  public readonly cancelled: string[] = [];

  async cancel(childId: string): Promise<ChildShutdownResult> {
    this.cancelled.push(childId);
    return { code: 0, signal: null, forced: false, durationMs: 0 };
  }
}

/**
 * Lightweight mock of Node's {@link ServerResponse}. The helper stores response
 * payloads and headers so the tests can inspect the dashboard output without
 * performing real network operations (forbidden by the offline guard).
 */
class MockResponse {
  public statusCode: number | null = null;
  public headersSent = false;
  public finished = false;
  public readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private readonly closeHandlers: Array<() => void> = [];

  writeHead(status: number, headers?: Record<string, string | number>): ServerResponse {
    this.statusCode = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = String(value);
      }
    }
    this.headersSent = true;
    return this as unknown as ServerResponse;
  }

  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  write(chunk: string | Uint8Array): boolean {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.chunks.push(buffer);
    this.headersSent = true;
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk) {
      this.write(chunk);
    }
    this.finished = true;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // Listener failures must not break the harness assertions.
      }
    }
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  on(event: string, listener: () => void): this {
    if (event === "close") {
      this.closeHandlers.push(listener);
    }
    return this;
  }
}

/**
 * Create a mock {@link IncomingMessage} optionally pre-populated with a JSON
 * payload. The helper mirrors the HTTP requests issued by the dashboard UI.
 */
function createMockRequest(method: string, path: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(payload);
  const request = stream as IncomingMessage;
  request.method = method;
  request.url = path;
  request.headers = {
    host: "dashboard.test",
    "content-type": "application/json",
  };
  return request;
}

/**
 * Integration coverage ensuring the dashboard helpers continue to expose the
 * state required by operators. The suite focuses on pure computations and the
 * HTTP router, keeping each scenario self-contained for reproducibility.
 */
describe("monitor/dashboard", function () {
  this.timeout(10_000);

  it("computes heatmaps based on graph activity and recorded events", () => {
    const graphState = new GraphState();
    graphState.createJob("job-1", { goal: "demo", createdAt: Date.now() - 10_000, state: "running" });
    graphState.createChild(
      "job-1",
      "child-1",
      { name: "alpha", runtime: "codex" },
      { createdAt: Date.now() - 5_000 },
    );
    graphState.patchChild("child-1", { lastTs: Date.now() - 2_000 });

    const eventStore = new EventStore({ maxHistory: 100, logger: new StructuredLogger() });
    eventStore.emit({
      kind: "REPLY",
      level: "info",
      source: "child",
      childId: "child-1",
      payload: { tokens: 42, elapsed_ms: 75 },
    });
    eventStore.emit({ kind: "ERROR", level: "error", source: "child", childId: "child-1" });

    const stigmergy = new StigmergyField();
    stigmergy.mark("child-1", "load", 3);

    const heatmap = computeDashboardHeatmap(graphState, eventStore, stigmergy);

    expect(heatmap.idle).to.have.length(1);
    expect(heatmap.errors[0]).to.deep.include({ childId: "child-1", value: 1 });
    expect(heatmap.tokens[0]).to.deep.include({ childId: "child-1", value: 42 });
    expect(heatmap.latency[0]).to.deep.include({ childId: "child-1", value: 75 });
    expect(heatmap.pheromones[0]).to.deep.include({ childId: "child-1" });
    expect(heatmap.bounds).to.not.equal(null);
    expect(heatmap.boundsTooltip).to.be.a("string");
  });

  it("aggregates runtime costs and latencies for dashboard summaries", () => {
    const graphState = new GraphState();
    const createdAt = Date.now() - 2_000;
    graphState.createJob("job-costs", { goal: "metrics", createdAt, state: "running" });
    graphState.createChild("job-costs", "child-a", { name: "alpha" }, { createdAt });
    graphState.createChild("job-costs", "child-b", { name: "beta" }, { createdAt });

    const eventStore = new EventStore({ maxHistory: 100, logger: new StructuredLogger() });
    eventStore.emit({
      kind: "INFO",
      level: "info",
      source: "child",
      childId: "child-a",
      payload: { tokens: { prompt: 20, completion: 30 }, elapsed_ms: 120 },
    });
    eventStore.emit({
      kind: "INFO",
      level: "info",
      source: "child",
      childId: "child-a",
      payload: { tokens: 10, durationMs: "80" },
    });
    eventStore.emit({
      kind: "INFO",
      level: "info",
      source: "child",
      childId: "child-b",
      payload: { metrics: { latencyMs: 60 }, tokens: 5 },
    });
    eventStore.emit({
      kind: "INFO",
      level: "info",
      source: "child",
      childId: "child-b",
      payload: { duration: 40 },
    });
    eventStore.emit({
      kind: "INFO",
      level: "info",
      source: "child",
      childId: "child-b",
      payload: { tokens: 3 },
    });
    eventStore.emit({ kind: "INFO", level: "info", source: "child", payload: { tokens: 99, elapsed_ms: 5 } });

    const summary = summariseRuntimeCosts(graphState, eventStore);

    expect(summary.totalTokens).to.equal(68);
    expect(summary.totalLatencyMs).to.equal(300);
    expect(summary.sampleCount).to.equal(4);
    expect(summary.avgLatencyMs).to.equal(75);
    expect(summary.maxLatencyMs).to.equal(120);
    expect(summary.topTokenConsumer?.childId).to.equal("child-a");
    expect(summary.topLatencyConsumer?.childId).to.equal("child-a");
    expect(summary.perChild).to.have.length(2);
    expect(summary.perChild[0]).to.include({ childId: "child-a", tokens: 60, latencyMs: 200, maxLatencyMs: 120 });
    expect(summary.perChild[1]).to.include({ childId: "child-b", tokens: 8, latencyMs: 100, maxLatencyMs: 60 });
  });

  it("exposes monitoring endpoints and sanitises the bootstrap HTML", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 100, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();
    const telemetryNow = 42;
    const contractNetWatcherTelemetry = new ContractNetWatcherTelemetryRecorder(() => telemetryNow);

    const maliciousLabel = "<script>alert('x')</script>";
    const maliciousSummary = "<script>alert('x')</script>\u2028next line\u2029paragraph";

    contractNetWatcherTelemetry.record({
      reason: "flush",
      receivedUpdates: 1,
      coalescedUpdates: 0,
      skippedRefreshes: 0,
      appliedRefreshes: 0,
      flushes: 1,
      lastBounds: { min_intensity: 0, max_intensity: null, normalisation_ceiling: 1 },
    });

    const createdAt = Date.now() - 1_000;
    graphState.createJob("job-1", { goal: "demo", createdAt, state: "running" });
    graphState.createChild("job-1", "child-1", { name: maliciousLabel, runtime: "codex" }, { createdAt });
    graphState.patchChild("child-1", { lastTs: createdAt + 500 });

    stigmergy.mark("child-1", "load", 2.5);

    eventStore.emit({
      kind: "STATUS",
      level: "info",
      source: "child",
      childId: "child-1",
      payload: { summary: maliciousSummary },
    });
    eventStore.emit({ kind: "REPLY", level: "info", source: "child", childId: "child-1", payload: { tokens: 0 } });

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
      const healthRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/health"), healthRes);
      expect(healthRes.statusCode).to.equal(200);
      expect(JSON.parse(healthRes.body)).to.deep.equal({ status: "ok" });

      const metricsRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/metrics"), metricsRes);
      const metrics = JSON.parse(metricsRes.body) as DashboardSnapshot;
      expect(metrics.children[0]).to.include({ id: "child-1" });
      expect(metrics.stigmergy.bounds).to.not.equal(null);
      expect(metrics.contractNetWatcherTelemetry).to.deep.include({ emissions: 1, lastEmittedAtMs: 42 });

      const uiRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/"), uiRes);
      expect(uiRes.statusCode).to.equal(200);
      expect(uiRes.headers["content-type"]).to.equal("text/html; charset=utf-8");
      expect(uiRes.body).to.contain("Contract-Net Watcher");
      expect(uiRes.body).to.contain("id=\"runtime-summary\"");
      expect(uiRes.body).to.contain("id=\"thought-heatmap\"");
      expect(uiRes.body).to.contain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
      expect(uiRes.body).to.contain("next line");
      expect(uiRes.body).to.contain("paragraph");
      const scriptPayload = uiRes.body.match(/const initialSnapshot = ([^;]+);/);
      expect(scriptPayload?.[1]).to.include("\\u003cscript");
      expect(scriptPayload?.[1]).to.include("next line paragraph");
      expect(scriptPayload?.[1] ?? "").to.not.include("\u2028");
      expect(scriptPayload?.[1] ?? "").to.not.include("\u2029");

      const streamRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/stream"), streamRes);
      expect(streamRes.statusCode).to.equal(200);
      expect(streamRes.body).to.contain("data:");
      router.broadcast();

      const logRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("POST", "/logs", {
          level: "warn",
          event: "dashboard_stream_parse_failure",
          context: {
            payload: "invalid",
            error: { name: "SyntaxError", message: "Unexpected token", stack: "stack-trace" },
          },
        }),
        logRes as unknown as ServerResponse,
      );
      expect(logRes.statusCode).to.equal(204);
      const lastEntry = entries.at(-1);
      expect(lastEntry?.message).to.equal("dashboard_client_log");
      expect((lastEntry?.payload as Record<string, unknown>)?.context).to.deep.equal({
        payload: "invalid",
        error: { name: "SyntaxError", message: "Unexpected token", stack: "stack-trace" },
      });

      const invalidLogRes = new MockResponse();
      const entryCountBeforeInvalid = entries.length;
      await router.handleRequest(
        createMockRequest("POST", "/logs", { level: "debug", event: "oops" }),
        invalidLogRes as unknown as ServerResponse,
      );
      expect(invalidLogRes.statusCode).to.equal(400);
      expect(entries.length).to.equal(entryCountBeforeInvalid);

      const pauseRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("POST", "/controls/pause", { childId: "child-1" }),
        pauseRes as unknown as ServerResponse,
      );
      expect(JSON.parse(pauseRes.body)).to.deep.equal({ status: "paused" });
      expect(graphState.getChild("child-1")?.state).to.equal("paused");

      const prioritiseRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("POST", "/controls/prioritise", { childId: "child-1", priority: 3 }),
        prioritiseRes as unknown as ServerResponse,
      );
      expect(JSON.parse(prioritiseRes.body)).to.deep.equal({ status: "prioritised", priority: 3 });
      expect(graphState.getChild("child-1")?.priority).to.equal(3);

      const cancelRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("POST", "/controls/cancel", { childId: "child-1" }),
        cancelRes as unknown as ServerResponse,
      );
      expect(JSON.parse(cancelRes.body)).to.deep.equal({ status: "cancelled" });
      expect(supervisor.cancelled).to.deep.equal(["child-1"]);
    } finally {
      await router.close();
    }
  });

  it("serves replay pages with lessons prompt diffs", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const createdAt = Date.now();
    graphState.createJob("job-replay", { goal: "replay", createdAt, state: "running" });
    graphState.createChild("job-replay", "child-99", { name: "chronicle" }, { createdAt });
    const eventStore = new EventStore({ maxHistory: 20, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();

    const beforeSnapshot = normalisePromptBlueprint({ system: "Audit" });
    const afterSnapshot = normalisePromptMessages([
      { role: "system", content: "Leçons: applique les checklists." },
      { role: "system", content: "Audit" },
    ]);
    const lessonsPayload = buildLessonsPromptPayload({
      source: "plan_fanout",
      before: beforeSnapshot,
      after: afterSnapshot,
      topics: ["audit"],
      tags: ["plan"],
      totalLessons: 1,
    });

    eventStore.emit({
      kind: "PROMPT",
      source: "orchestrator",
      level: "info",
      jobId: "job-replay",
      childId: "child-99",
      payload: { operation: "plan_fanout", lessons_prompt: lessonsPayload },
    });
    eventStore.emit({
      kind: "REPLY",
      source: "child",
      level: "info",
      jobId: "job-replay",
      childId: "child-99",
      payload: { tokens: 12 },
    });

    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor,
      logger,
      stigmergy,
      btStatusRegistry,
      autoBroadcast: false,
      streamIntervalMs: 200,
    });

    try {
      const pageOneRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("GET", "/replay?jobId=job-replay&limit=1"),
        pageOneRes as unknown as ServerResponse,
      );
      expect(pageOneRes.statusCode).to.equal(200);
      const pageOne = JSON.parse(pageOneRes.body) as {
        events: Array<{ kind: string; lessonsPrompt?: { operation: string; payload: { diff: { added: unknown[] } } } }>;
        nextCursor: number | null;
      };
      expect(pageOne.events).to.have.length(1);
      expect(pageOne.events[0]?.lessonsPrompt?.operation).to.equal("plan_fanout");
      expect(pageOne.events[0]?.lessonsPrompt?.payload.diff.added).to.have.length(1);
      expect(pageOne.nextCursor).to.be.a("number");

      const pageTwoRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("GET", `/replay?jobId=job-replay&cursor=${pageOne.nextCursor}`),
        pageTwoRes as unknown as ServerResponse,
      );
      expect(pageTwoRes.statusCode).to.equal(200);
      const pageTwo = JSON.parse(pageTwoRes.body) as { events: Array<{ kind: string }>; nextCursor: number | null };
      expect(pageTwo.events).to.have.length(1);
      expect(pageTwo.events[0]?.kind).to.equal("REPLY");
      expect(pageTwo.nextCursor).to.equal(null);
    } finally {
      await router.close();
    }
  });

  it("rejects replay requests with invalid query parameters", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();

    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor,
      logger,
      stigmergy,
      btStatusRegistry,
      autoBroadcast: false,
      streamIntervalMs: 200,
    });

    try {
      const missingJobRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/replay"), missingJobRes as unknown as ServerResponse);
      expect(missingJobRes.statusCode).to.equal(400);

      const badLimitRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("GET", "/replay?jobId=test&limit=zero"),
        badLimitRes as unknown as ServerResponse,
      );
      expect(badLimitRes.statusCode).to.equal(400);

      const badCursorRes = new MockResponse();
      await router.handleRequest(
        createMockRequest("GET", "/replay?jobId=test&cursor=-5"),
        badCursorRes as unknown as ServerResponse,
      );
      expect(badCursorRes.statusCode).to.equal(400);
    } finally {
      await router.close();
    }
  });

  it("exposes correlated log slices via GET /logs", async function () {
    this.timeout(5_000);

    const logRoot = await mkdtemp(join(tmpdir(), "dashboard-logs-"));
    const logJournal = new LogJournal({ rootDir: logRoot, maxEntriesPerBucket: 16 });
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 10, logger });

    const routerWithoutJournal = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new StubSupervisor(),
      logger,
      autoBroadcast: false,
      streamIntervalMs: 1_000,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
    });

    const missingRes = new MockResponse();
    await routerWithoutJournal.handleRequest(
      createMockRequest("GET", "/logs?stream=server"),
      missingRes as unknown as ServerResponse,
    );
    expect(missingRes.statusCode).to.equal(503);
    expect(JSON.parse(missingRes.body)).to.deep.equal({ error: "LOGS_UNAVAILABLE", message: "log journal not configured" });
    await routerWithoutJournal.close();

    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new StubSupervisor(),
      logger,
      autoBroadcast: false,
      streamIntervalMs: 1_000,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      logJournal,
    });

    try {
      const now = Date.now();
      logJournal.record({
        stream: "server",
        bucketId: "orchestrator",
        level: "error",
        message: "scheduler failed",
        ts: now,
        runId: "run-log-1",
        jobId: "job-log-1",
        component: "scheduler",
        stage: "scheduler_failed",
        elapsedMs: 123,
      });

      const response = new MockResponse();
      await router.handleRequest(
        createMockRequest("GET", "/logs?stream=server&levels=error&messageIncludes=failed"),
        response as unknown as ServerResponse,
      );

      expect(response.statusCode).to.equal(200);
      expect(response.headers["content-type"]).to.equal("application/json");
      const body = JSON.parse(response.body) as { entries: Array<{ message: string; component: string }> };
      expect(body.entries).to.have.length(1);
      expect(body.entries[0]).to.include({ message: "scheduler failed", component: "scheduler" });
    } finally {
      await router.close();
      await rm(logRoot, { recursive: true, force: true });
    }
  });
});
