/**
 * Readiness endpoint regression tests. Besides verifying the authentication and
 * plumbing semantics, these checks exercise the concrete helper that probes the
 * underlying dependencies so the `/readyz` payload remains actionable for
 * operators.
 */
import { beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __httpServerInternals, type HttpReadinessReport } from "../../src/httpServer.js";
import { evaluateHttpReadiness } from "../../src/http/readiness.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createHttpRequest } from "../helpers/http.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";

function createLogger(): RecordingLogger {
  return new RecordingLogger();
}

describe("http readyz", () => {
  let originalToken: string | undefined;
  let originalAllow: string | undefined;

  beforeEach(() => {
    resetRateLimitBuckets();
    originalToken = process.env.MCP_HTTP_TOKEN;
    originalAllow = process.env.MCP_HTTP_ALLOW_NOAUTH;
    process.env.MCP_HTTP_TOKEN = "unit-test-token";
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;
  });

  afterEach(async () => {
    if (originalToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalToken;
    }
    if (originalAllow === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = originalAllow;
    }
  });

  it("returns component diagnostics when the probe passes", async () => {
    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      async check() {
        return {
          ok: true,
          components: {
            graphForge: { ok: true, message: "loaded" },
            runsDirectory: { ok: true, path: "/tmp/runs", message: "read/write verified" },
            idempotency: { ok: true, message: "store" },
            eventQueue: { ok: true, usage: 5, capacity: 5_000, message: "queue within capacity" },
          },
        };
      },
    };

    const request = createHttpRequest(
      "GET",
      "/readyz",
      { authorization: "Bearer unit-test-token" },
      undefined,
      { remoteAddress: "127.0.0.1" },
    );
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleReadyCheck(request, response, createLogger(), "req-ready", readiness);

    expect(response.statusCode).to.equal(200);
    const payload = JSON.parse(response.body) as HttpReadinessReport;
    expect(payload.ok).to.equal(true);
    expect(payload.components.eventQueue.usage).to.equal(5);
    expect(payload.components.runsDirectory.ok).to.equal(true);
  }).timeout(10_000);

  it("requires authentication before invoking the readiness probe", async () => {
    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      async check() {
        throw new Error("should not be reached");
      },
    };

    const request = createHttpRequest("GET", "/readyz", {}, undefined, { remoteAddress: "127.0.0.1" });
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleReadyCheck(request, response, createLogger(), "req-ready", readiness);

    expect(response.statusCode).to.equal(401);
    expect(() => JSON.parse(response.body)).to.not.throw();
  }).timeout(10_000);

  it("reports a degraded state when the runs directory is not writable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "readyz-"));
    const fileRoot = join(tempRoot, "file-root");
    await writeFile(fileRoot, "not-a-directory");

    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      check: () =>
        evaluateHttpReadiness({
          loadGraphForge: async () => {},
          runsRoot: fileRoot,
          idempotencyStore: { checkHealth: async () => {} },
          eventStore: {
            getEventCount: () => 0,
            getMaxHistory: () => 100,
          },
        }),
    };

    const request = createHttpRequest(
      "GET",
      "/readyz",
      { authorization: "Bearer unit-test-token" },
      undefined,
      { remoteAddress: "127.0.0.1" },
    );
    const response = new MemoryHttpResponse();

    try {
      await __httpServerInternals.handleReadyCheck(request, response, createLogger(), "req-ready", readiness);

      expect(response.statusCode).to.equal(503);
      const payload = JSON.parse(response.body) as HttpReadinessReport;
      expect(payload.ok).to.equal(false);
      expect(payload.components.runsDirectory.ok).to.equal(false);
      expect(payload.components.runsDirectory.message).to.be.a("string");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }).timeout(10_000);

  it("surfaces graph-forge preload failures in the readiness report", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "readyz-graphforge-"));
    let loadAttempts = 0;
    const expectedError = new Error("graph forge bundle missing");

    try {
      const report = await evaluateHttpReadiness({
        // The readiness probe must attempt to preload Graph Forge before claiming success.
        loadGraphForge: async () => {
          loadAttempts += 1;
          throw expectedError;
        },
        runsRoot: tempRoot,
        idempotencyStore: { checkHealth: async () => {} },
        eventStore: {
          getEventCount: () => 0,
          getMaxHistory: () => 10,
        },
      });

      expect(loadAttempts).to.equal(1);
      expect(report.ok).to.equal(false);
      expect(report.components.graphForge.ok).to.equal(false);
      expect(report.components.graphForge.message).to.equal(expectedError.message);
      expect(report.components.runsDirectory.ok).to.equal(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }).timeout(10_000);

  it("flags idempotency stores that fail their health check", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "readyz-idempotency-"));
    const expectedError = new Error("wal locked");

    try {
      const report = await evaluateHttpReadiness({
        loadGraphForge: async () => {},
        runsRoot: tempRoot,
        idempotencyStore: {
          async checkHealth() {
            throw expectedError;
          },
        },
        eventStore: {
          getEventCount: () => 0,
          getMaxHistory: () => 50,
        },
      });

      expect(report.ok).to.equal(false);
      expect(report.components.idempotency.ok).to.equal(false);
      expect(report.components.idempotency.message).to.equal(expectedError.message);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }).timeout(10_000);

  it("propagates readiness failures for other components", async () => {
    const readiness: { check: () => Promise<HttpReadinessReport> } = {
      async check() {
        return {
          ok: false,
          components: {
            graphForge: { ok: false, message: "dsl not compiled" },
            runsDirectory: { ok: true, path: "/tmp/runs", message: "read/write verified" },
            idempotency: { ok: true, message: "store" },
            eventQueue: { ok: false, usage: 4_999, capacity: 5_000, message: "event history near capacity" },
          },
        };
      },
    };

    const request = createHttpRequest(
      "GET",
      "/readyz",
      { authorization: "Bearer unit-test-token" },
      undefined,
      { remoteAddress: "127.0.0.1" },
    );
    const response = new MemoryHttpResponse();

    await __httpServerInternals.handleReadyCheck(request, response, createLogger(), "req-ready", readiness);

    expect(response.statusCode).to.equal(503);
    const payload = JSON.parse(response.body) as HttpReadinessReport;
    expect(payload.ok).to.equal(false);
    expect(payload.components.graphForge.ok).to.equal(false);
  }).timeout(10_000);
});
