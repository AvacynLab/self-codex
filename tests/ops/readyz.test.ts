/**
 * Readiness endpoint regression tests. They verify authentication requirements
 * and the structured payload returned by the orchestrator-provided probe.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import { __httpServerInternals, type HttpReadinessReport } from "../../src/httpServer.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createHttpRequest } from "../helpers/http.js";

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("http readyz", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    resetRateLimitBuckets();
    originalToken = process.env.MCP_HTTP_TOKEN;
    process.env.MCP_HTTP_TOKEN = "unit-test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalToken;
    }
  });

  it("returns component diagnostics when the probe passes", async () => {
    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      async check() {
        return {
          ok: true,
          components: {
            graphForge: { ok: true, message: "loaded" },
            idempotency: { ok: true, message: "store" },
            eventQueue: { ok: true, usage: 5, capacity: 5000 },
          },
        };
      },
    };

    const request = createHttpRequest("GET", "/readyz", {
      authorization: "Bearer unit-test-token",
    });
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleReadyCheck(request as any, response as any, createLogger() as any, "req-ready", readiness);

    expect(response.statusCode).to.equal(200);
    const payload = JSON.parse(response.body) as HttpReadinessReport;
    expect(payload.ok).to.equal(true);
    expect(payload.components.eventQueue.usage).to.equal(5);
  }).timeout(10_000);

  it("requires authentication before invoking the readiness probe", async () => {
    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      async check() {
        throw new Error("should not be reached");
      },
    };
    const request = createHttpRequest("GET", "/readyz");
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleReadyCheck(request as any, response as any, createLogger() as any, "req-ready", readiness);

    expect(response.statusCode).to.equal(401);
    expect(() => JSON.parse(response.body)).to.not.throw();
  }).timeout(10_000);

  it("propagates readiness failures", async () => {
    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      async check() {
        return {
          ok: false,
          components: {
            graphForge: { ok: false, message: "dsl not compiled" },
            idempotency: { ok: true, message: "store" },
            eventQueue: { ok: false, usage: 4999, capacity: 5000 },
          },
        };
      },
    };
    const request = createHttpRequest("GET", "/readyz", {
      authorization: "Bearer unit-test-token",
    });
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleReadyCheck(request as any, response as any, createLogger() as any, "req-ready", readiness);

    expect(response.statusCode).to.equal(503);
    const payload = JSON.parse(response.body) as HttpReadinessReport;
    expect(payload.ok).to.equal(false);
    expect(payload.components.graphForge.ok).to.equal(false);
  }).timeout(10_000);
});
