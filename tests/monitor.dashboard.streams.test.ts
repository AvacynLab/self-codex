import { describe, it } from "mocha";
import { expect } from "chai";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { GraphState } from "../src/graphState.js";
import { EventStore } from "../src/eventStore.js";
import { StructuredLogger } from "../src/logger.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ContractNetWatcherTelemetryRecorder } from "../src/coord/contractNetWatchers.js";
import { BehaviorTreeStatusRegistry } from "../src/monitor/btStatusRegistry.js";
import type { SupervisorSchedulerSnapshot } from "../src/agents/supervisor.js";
import {
  DashboardSnapshot,
  createDashboardRouter,
} from "../src/monitor/dashboard.js";

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
class StreamResponse {
  public statusCode: number | null = null;
  public headersSent = false;
  public finished = false;
  public readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  private readonly closeListeners: Array<() => void> = [];

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
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        // Ignore close listener failures in tests to keep assertions focused on SSE output.
      }
    }
  }

  on(event: string, listener: () => void): this {
    if (event === "close") {
      this.closeListeners.push(listener);
    }
    return this;
  }

  /** Returns the concatenated SSE body for convenience. */
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  /** Extracts the JSON payloads emitted through `data:` SSE lines. */
  get dataEvents(): string[] {
    return this.body
      .split("\n\n")
      .filter((entry) => entry.startsWith("data: "))
      .map((entry) => entry.slice("data: ".length));
  }
}

/** Builds a mocked HTTP request accepted by the dashboard router. */
function createRequest(method: string, path: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(payload);
  const request = stream as unknown as IncomingMessage;
  request.method = method;
  request.url = path;
  request.headers = {
    host: "dashboard.test",
    "content-type": "application/json",
  } as Record<string, string>;
  return request;
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
      await router.handleRequest(createRequest("GET", "/stream"), response as unknown as ServerResponse);

      expect(response.statusCode).to.equal(200);
      expect(response.headers["content-type"]).to.equal("text/event-stream");

      const initialEvents = response.dataEvents;
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
      const afterBroadcast = response.dataEvents;
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
      await router.handleRequest(createRequest("GET", "/stream"), response as unknown as ServerResponse);

      const events = response.dataEvents;
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
});
