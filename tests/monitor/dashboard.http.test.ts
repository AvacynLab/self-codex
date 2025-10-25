import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import type { IncomingMessage } from "node:http";

import { setTimeout as delay } from "node:timers/promises";

import { GraphState } from "../../src/graph/state.js";
import { EventStore } from "../../src/eventStore.js";
import { StructuredLogger } from "../../src/logger.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";
import { BehaviorTreeStatusRegistry } from "../../src/monitor/btStatusRegistry.js";
import { createDashboardRouter } from "../../src/monitor/dashboard.js";
import type { OrchestratorSupervisorContract } from "../../src/agents/supervisor.js";
import { createHttpRequest, MemoryHttpResponse } from "../helpers/http.js";
import { StreamResponse, waitForSseEvents } from "./helpers/streamResponse.js";

class NoopSupervisor implements Pick<OrchestratorSupervisorContract, "cancel"> {
  async cancel(): Promise<void> {
    /* noop */
  }
}

class CapturingLogger extends StructuredLogger {
  public warnings: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];

  override warn(event: string, data?: Record<string, unknown>): void {
    this.warnings.push({ event, data });
  }

  override debug(): void {
    /* muted for tests */
  }

  override info(): void {
    /* muted for tests */
  }

  override error(): void {
    /* muted for tests */
  }
}

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

describe("monitor/dashboard http", () => {
  let originalMaxBuffer: string | undefined;
  let originalDashboardInterval: string | undefined;
  let originalKeepAlive: string | undefined;

  beforeEach(() => {
    originalMaxBuffer = process.env.MCP_SSE_MAX_BUFFER;
    originalDashboardInterval = process.env.MCP_DASHBOARD_INTERVAL_MS;
    originalKeepAlive = process.env.MCP_SSE_KEEPALIVE_MS;
    delete process.env.MCP_DASHBOARD_INTERVAL_MS;
    delete process.env.MCP_SSE_KEEPALIVE_MS;
  });

  afterEach(() => {
    if (originalMaxBuffer === undefined) {
      delete process.env.MCP_SSE_MAX_BUFFER;
    } else {
      process.env.MCP_SSE_MAX_BUFFER = originalMaxBuffer;
    }
    if (originalDashboardInterval === undefined) {
      delete process.env.MCP_DASHBOARD_INTERVAL_MS;
    } else {
      process.env.MCP_DASHBOARD_INTERVAL_MS = originalDashboardInterval;
    }
    if (originalKeepAlive === undefined) {
      delete process.env.MCP_SSE_KEEPALIVE_MS;
    } else {
      process.env.MCP_SSE_KEEPALIVE_MS = originalKeepAlive;
    }
  });

  it("serves health and metrics endpoints", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 10, logger });
    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new NoopSupervisor(),
      logger,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      autoBroadcast: false,
    });

    try {
      const healthResponse = new MemoryHttpResponse();
      await router.handleRequest(createRequest("GET", "/health"), healthResponse);
      expect(healthResponse.statusCode).to.equal(200);
      expect(JSON.parse(healthResponse.body)).to.deep.equal({ status: "ok" });

      graphState.createJob("demo", { goal: "observe", state: "running" });
      const metricsResponse = new MemoryHttpResponse();
      await router.handleRequest(createRequest("GET", "/metrics"), metricsResponse);
      expect(metricsResponse.statusCode).to.equal(200);
      const metricsPayload = JSON.parse(metricsResponse.body) as { metrics: unknown };
      expect(metricsPayload).to.have.property("metrics");
    } finally {
      await router.close();
    }
  });

  it("configures SSE headers and emits the initial snapshot", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new NoopSupervisor(),
      logger,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      autoBroadcast: false,
      streamIntervalMs: 500,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);

      expect(response.statusCode).to.equal(200);
      expect(response.headers["content-type"]).to.equal("text/event-stream; charset=utf-8");
      expect(response.headers["cache-control"]).to.equal("no-store");
      expect(response.headers["connection"]).to.equal("keep-alive");
      expect(response.headers["x-accel-buffering"]).to.equal("no");
      expect(response.headers["keep-alive"]).to.equal("timeout=1");

      const events = await waitForSseEvents(response, 1);
      expect(events.length).to.be.greaterThan(0);
    } finally {
      await router.close();
    }
  });

  it("derives the stream interval from the environment when no override is supplied", async () => {
    process.env.MCP_DASHBOARD_INTERVAL_MS = "1500";
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new NoopSupervisor(),
      logger,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      autoBroadcast: false,
    });

    try {
      expect(router.streamIntervalMs).to.equal(1_500);
    } finally {
      await router.close();
    }
  });

  it("drops buffered frames when the client backpressure persists", async () => {
    process.env.MCP_SSE_MAX_BUFFER = "128";
    const logger = new CapturingLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new NoopSupervisor(),
      logger,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      autoBroadcast: false,
      streamIntervalMs: 200,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);
      response.triggerBackpressure(5);

      for (let i = 0; i < 8; i += 1) {
        router.broadcast();
      }

      expect(logger.warnings.some((entry) => entry.event === "resources_sse_buffer_overflow")).to.equal(true);

      response.emitDrain();
      await waitForSseEvents(response, 1);
    } finally {
      await router.close();
    }
  });

  it("emits keep-alive comments while the stream stays idle", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new NoopSupervisor(),
      logger,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      autoBroadcast: false,
      streamIntervalMs: 5_000,
      // The router clamps explicit keep-alive overrides to 1s. Providing a value below the
      // floor documents the clamp behaviour while keeping the test focused on the timer.
      keepAliveIntervalMs: 250,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);

      const deadline = Date.now() + 1_500;
      let keepAliveDetected = false;
      while (Date.now() < deadline) {
        if (response.body.includes(": keep-alive")) {
          keepAliveDetected = true;
          break;
        }
        await delay(10);
      }

      expect(keepAliveDetected).to.equal(true, "keep-alive comment was not emitted");
    } finally {
      await router.close();
    }
  });

  it("cleans up keep-alive timers when the client disconnects", async () => {
    const logger = new StructuredLogger();
    const graphState = new GraphState();
    const eventStore = new EventStore({ maxHistory: 5, logger });
    const router = createDashboardRouter({
      graphState,
      eventStore,
      supervisor: new NoopSupervisor(),
      logger,
      stigmergy: new StigmergyField(),
      btStatusRegistry: new BehaviorTreeStatusRegistry(),
      autoBroadcast: false,
      streamIntervalMs: 5_000,
      keepAliveIntervalMs: 400,
    });

    try {
      const response = new StreamResponse();
      await router.handleRequest(createRequest("GET", "/stream"), response);

      // Wait for the first keep-alive frame to ensure the timer is active.
      const firstDeadline = Date.now() + 1_500;
      while (!response.body.includes(": keep-alive") && Date.now() < firstDeadline) {
        await delay(25);
      }

      const lengthBeforeClose = response.body.length;
      response.end();

      await delay(100);
      expect(response.body.length).to.equal(lengthBeforeClose);
    } finally {
      await router.close();
    }
  });
});
