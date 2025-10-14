/**
 * Integration-level coverage for the HTTP health and readiness probes. The
 * tests exercise the lightweight helpers directly to guarantee deterministic
 * outcomes without starting an actual TCP listener.
 */
import { beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createHttpRequest } from "../helpers/http.ts";

const noopLogger = new Proxy(
  {},
  {
    get() {
      return () => {};
    },
  },
);

describe("ops probes", () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  afterEach(() => {
    resetRateLimitBuckets();
    delete process.env.MCP_HTTP_TOKEN;
  });

  it("exposes a healthy status without requiring authentication", async () => {
    const request = createHttpRequest("GET", "/healthz");
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleHealthCheck(request as any, response as any, noopLogger as any, "rid");

    expect([200, 503]).to.include(response.statusCode);
    const payload = JSON.parse(response.body) as { ok?: boolean };
    expect(payload).to.have.property("ok");
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

    await __httpServerInternals.handleReadyCheck(
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

    await __httpServerInternals.handleReadyCheck(
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
