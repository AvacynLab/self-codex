import { describe, it } from "mocha";
import { expect } from "chai";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { EventStore } from "../src/eventStore.js";
import { GraphState } from "../src/graphState.js";
import { StructuredLogger } from "../src/logger.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ContractNetWatcherTelemetryRecorder } from "../src/coord/contractNetWatchers.js";
import { BehaviorTreeStatusRegistry } from "../src/monitor/btStatusRegistry.js";
import {
  createDashboardRouter,
  computeDashboardHeatmap,
  type DashboardSnapshot,
} from "../src/monitor/dashboard.js";
import { ChildShutdownResult } from "../src/childRuntime.js";

class StubSupervisor {
  public cancelled: string[] = [];

  async cancel(childId: string): Promise<ChildShutdownResult> {
    this.cancelled.push(childId);
    return {
      code: 0,
      signal: null,
      forced: false,
      durationMs: 0,
    };
  }
}

interface TestResponse {
  statusCode: number | null;
  headersSent: boolean;
  finished: boolean;
  body: string;
  headers: Record<string, string>;
}

class MockResponse implements TestResponse {
  public statusCode: number | null = null;
  public headersSent = false;
  public finished = false;
  public headers: Record<string, string> = {};
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
        // ignore listener failures in the test harness
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

function createMockRequest(method: string, path: string, body?: unknown): IncomingMessage {
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

describe("monitor/dashboard", function (this: Mocha.Suite) {
  this.timeout(10_000);

  it("computes heatmaps based on graph and events", () => {
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
    eventStore.emit({ kind: "REPLY", level: "info", source: "child", childId: "child-1", payload: { tokens: 42 } });
    eventStore.emit({ kind: "ERROR", level: "error", source: "child", childId: "child-1" });

    const stigmergy = new StigmergyField();
    stigmergy.mark("child-1", "load", 3);

    const heatmap = computeDashboardHeatmap(graphState, eventStore, stigmergy);

    expect(heatmap.idle).to.have.length(1);
    expect(heatmap.errors[0]).to.deep.include({ childId: "child-1", value: 1 });
    expect(heatmap.tokens[0]).to.deep.include({ childId: "child-1", value: 42 });
    expect(heatmap.pheromones[0]).to.deep.include({ childId: "child-1" });
    expect(heatmap.pheromones[0]?.normalised).to.be.greaterThan(0);
    expect(heatmap.bounds).to.not.equal(null);
    expect(heatmap.bounds?.normalisation_ceiling ?? 0).to.be.greaterThan(0);
    expect(heatmap.boundsTooltip).to.be.a("string");
    expect(heatmap.boundsTooltip).to.contain("Min");
    expect(heatmap.boundsTooltip).to.contain("Ceiling");
  });

  it("exposes HTTP endpoints for monitoring and control", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 100, logger });
    const supervisor = new StubSupervisor();
    const stigmergy = new StigmergyField();
    const btStatusRegistry = new BehaviorTreeStatusRegistry();
    let telemetryNow = 42;
    const contractNetWatcherTelemetry = new ContractNetWatcherTelemetryRecorder(() => telemetryNow);
    // Include HTML markup and Unicode line/paragraph separators to ensure the
    // dashboard bootstrap escapes characters that could otherwise terminate the
    // inline script prematurely when serialised into the HTML payload.
    const maliciousReason = "<script>alert('x')</script> next line paragraph";
    contractNetWatcherTelemetry.record({
      reason: maliciousReason,
      receivedUpdates: 1,
      coalescedUpdates: 0,
      skippedRefreshes: 0,
      appliedRefreshes: 0,
      flushes: 1,
      lastBounds: {
        min_intensity: 0,
        max_intensity: null,
        normalisation_ceiling: 1,
      },
    });

    const createdAt = Date.now() - 1000;
    graphState.createJob("job-1", { goal: "demo", createdAt, state: "running" });
    graphState.createChild(
      "job-1",
      "child-1",
      { name: "alpha", runtime: "codex" },
      { createdAt },
    );

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
      await router.handleRequest(createMockRequest("GET", "/health"), healthRes as unknown as ServerResponse);
      expect(healthRes.statusCode).to.equal(200);
      expect(JSON.parse(healthRes.body)).to.deep.equal({ status: "ok" });

      const metricsRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/metrics"), metricsRes as unknown as ServerResponse);
      const metrics = JSON.parse(metricsRes.body) as DashboardSnapshot;
      expect(metrics.children[0]).to.include({ id: "child-1" });
      expect(metrics.stigmergy.bounds).to.not.equal(null);
      expect(metrics.stigmergy.rows[0]?.value).to.not.equal("n/a");
      expect(metrics.stigmergy.rows.map((row) => row.label)).to.include("Normalisation ceiling");
      expect(metrics.contractNetWatcherTelemetry).to.deep.equal({
        emissions: 1,
        lastEmittedAtMs: 42,
        lastSnapshot: {
          reason: maliciousReason,
          receivedUpdates: 1,
          coalescedUpdates: 0,
          skippedRefreshes: 0,
          appliedRefreshes: 0,
          flushes: 1,
          lastBounds: {
            min_intensity: 0,
            max_intensity: null,
            normalisation_ceiling: 1,
          },
        },
      });

      const uiRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/"), uiRes as unknown as ServerResponse);
      expect(uiRes.statusCode).to.equal(200);
      expect(uiRes.headers["content-type"]).to.equal("text/html; charset=utf-8");
      expect(uiRes.body).to.contain("Contract-Net Watcher");
      expect(uiRes.body).to.contain("id=\"connection-status\"");
      expect(uiRes.body).to.contain("EventSource(\"stream\")");
      expect(uiRes.body).to.contain("Emissions");
      expect(uiRes.body).to.contain(">1<");
      expect(uiRes.body).to.contain("Notifications reçues");
      expect(uiRes.body).to.contain("Normalisation ceiling");
      expect(uiRes.body).to.contain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
      expect(uiRes.body).to.contain("next line");
      expect(uiRes.body).to.contain("paragraph");
      const scriptPayload = uiRes.body.match(/const initialSnapshot = ([^;]+);/);
      expect(scriptPayload?.[1]).to.include("\\u003cscript");
      expect(scriptPayload?.[1]).to.include("\\u2028next line");
      expect(scriptPayload?.[1]).to.include("\\u2029paragraph");

      const streamRes = new MockResponse();
      await router.handleRequest(createMockRequest("GET", "/stream"), streamRes as unknown as ServerResponse);
      expect(streamRes.statusCode).to.equal(200);
      expect(streamRes.body).to.contain("data:");
      router.broadcast();

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
});
