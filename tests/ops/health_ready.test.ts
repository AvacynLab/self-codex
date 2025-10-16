/**
 * Integration-level coverage for the HTTP health and readiness probes. The
 * tests exercise the lightweight helpers directly to guarantee deterministic
 * outcomes without starting an actual TCP listener.
 */
import { before, after, beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

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
  let registerStub: sinon.SinonStub | undefined;
  let originalAllow: string | undefined;

  async function loadHttpServerInternals() {
    return (await import("../../src/httpServer.js")).__httpServerInternals;
  }

  before(async () => {
    const mcpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const prototype = mcpModule.McpServer.prototype as typeof mcpModule.McpServer.prototype & {
      registerTool: (...args: unknown[]) => unknown;
    };
    const originalRegister = prototype.registerTool;
    registerStub = sinon
      .stub(prototype, "registerTool")
      .callsFake(function registerToolSafe(this: unknown, ...args: unknown[]) {
        try {
          return originalRegister.apply(this, args as never);
        } catch (error) {
          if (error instanceof Error && /already registered/i.test(error.message)) {
            return this;
          }
          throw error;
        }
      });
    httpInternals = await loadHttpServerInternals();
  });

  after(() => {
    registerStub?.restore();
  });

  beforeEach(() => {
    resetRateLimitBuckets();
    originalAllow = process.env.MCP_HTTP_ALLOW_NOAUTH;
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;
  });

  afterEach(() => {
    resetRateLimitBuckets();
    delete process.env.MCP_HTTP_TOKEN;
    if (originalAllow === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = originalAllow;
    }
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

  it("authenticates `/readyz` callers before touching the rate limiter", async () => {
    process.env.MCP_HTTP_TOKEN = "test-token";
    const key = "127.0.0.1:/readyz";
    // Pre-consume 19 out of 20 tokens to leave a single slot in the bucket. If the
    // readiness handler invoked the limiter before the auth guard it would spend the
    // last token and the assertion below would fail.
    for (let attempt = 0; attempt < 19; attempt += 1) {
      const ok = httpInternals.enforceRateLimit(
        key,
        new MemoryHttpResponse() as any,
        noopLogger as any,
        `rid-${attempt}`,
      );
      expect(ok, `pre-flight attempt ${attempt} should succeed`).to.equal(true);
    }

    const readinessInvoked: { called: boolean } = { called: false };
    const request = createHttpRequest("GET", "/readyz");
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    await httpInternals.handleReadyCheck(
      request as any,
      response as any,
      noopLogger as any,
      "rid-final",
      {
        async check() {
          readinessInvoked.called = true;
          return {
            ok: true,
            components: {
              graphForge: { ok: true },
              idempotency: { ok: true },
              eventQueue: { ok: true, usage: 0, capacity: 10 },
            },
          } as const;
        },
      },
    );

    expect(readinessInvoked.called, "readiness probe should not run when auth fails").to.equal(false);
    expect(response.statusCode).to.equal(401);
    const payload = JSON.parse(response.body) as { error?: { data?: { category?: string } } };
    expect(payload.error?.data?.category).to.equal("AUTH_REQUIRED");

    const bucketIntact = httpInternals.enforceRateLimit(
      key,
      new MemoryHttpResponse() as any,
      noopLogger as any,
      "rid-post",
    );
    expect(bucketIntact, "last token should remain available").to.equal(true);
  });
});
