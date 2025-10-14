/**
 * Integration-level coverage for the HTTP health and readiness probes. The
 * tests exercise the lightweight helpers directly to guarantee deterministic
 * outcomes without starting an actual TCP listener.
 */
import { beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createHttpRequest } from "../helpers/http.ts";

// `/healthz` considers the event loop healthy when the synthetic delay stays within 100ms.
const HEALTH_DELAY_BUDGET_MS = 100;

const noopLogger = new Proxy(
  {},
  {
    get() {
      return () => {};
    },
  },
);

describe("ops probes", () => {
  let httpInternals: Awaited<ReturnType<typeof loadHttpServerInternals>>;

  async function loadHttpServerInternals() {
    return (await import("../../src/httpServer.js")).__httpServerInternals;
  }

  beforeEach(() => {
    resetRateLimitBuckets();
  });

  afterEach(() => {
    resetRateLimitBuckets();
    delete process.env.MCP_HTTP_TOKEN;
  });

  before(async () => {
    httpInternals = await loadHttpServerInternals();
  });

  it("exposes a healthy status without requiring authentication", async () => {
    const request = createHttpRequest("GET", "/healthz");
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    await httpInternals.handleHealthCheck(request as any, response as any, noopLogger as any, "rid");

    expect(response.statusCode).to.equal(200);
    const payload = JSON.parse(response.body) as { ok?: boolean };
    expect(payload.ok).to.equal(true);
  });

  it("reports an unhealthy status when the event loop is delayed", async () => {
    const request = createHttpRequest("GET", "/healthz");
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    const originalSetImmediate = setImmediate;
    const simulatedDelayMs = 200;
    // Simulate an event-loop delay by wrapping setImmediate with a delayed callback.
    (globalThis as any).setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      return originalSetImmediate((...cbArgs: unknown[]) => {
        setTimeout(() => callback(...cbArgs), simulatedDelayMs);
      }, ...args);
    }) as typeof setImmediate;

    try {
      await httpInternals.handleHealthCheck(request as any, response as any, noopLogger as any, "rid");
    } finally {
      (globalThis as any).setImmediate = originalSetImmediate;
    }

    const payload = JSON.parse(response.body) as { ok?: boolean; event_loop_delay_ms?: number };
    expect(response.statusCode).to.equal(503);
    expect(payload.ok).to.equal(false);
    expect(payload.event_loop_delay_ms ?? 0).to.be.greaterThan(HEALTH_DELAY_BUDGET_MS);
  });

  it("reports readiness success when all dependencies pass", async () => {
    process.env.MCP_HTTP_TOKEN = "test-token";
    const request = createHttpRequest("GET", "/readyz", {
      authorization: "Bearer test-token",
    });
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    const readiness = {
      async check() {
        return {
          ok: true,
          components: {
            graphForge: { ok: true },
            idempotency: { ok: true },
            eventQueue: { ok: true, usage: 1, capacity: 10 },
          },
        } as const;
      },
    };

    await httpInternals.handleReadyCheck(
      request as any,
      response as any,
      noopLogger as any,
      "rid",
      readiness,
    );

    expect(response.statusCode).to.equal(200);
    const payload = JSON.parse(response.body) as { ok?: boolean };
    expect(payload.ok).to.equal(true);
  });

  it("fails readiness when a dependency is unhealthy", async () => {
    process.env.MCP_HTTP_TOKEN = "test-token";
    const request = createHttpRequest("GET", "/readyz", {
      authorization: "Bearer test-token",
    });
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    const readiness = {
      async check() {
        return {
          ok: false,
          components: {
            graphForge: { ok: false, message: "maintenance" },
            idempotency: { ok: true },
            eventQueue: { ok: true, usage: 5, capacity: 10 },
          },
        } as const;
      },
    };

    await httpInternals.handleReadyCheck(
      request as any,
      response as any,
      noopLogger as any,
      "rid",
      readiness,
    );

    expect(response.statusCode).to.equal(503);
    const payload = JSON.parse(response.body) as { ok?: boolean };
    expect(payload.ok).to.equal(false);
  });
});
