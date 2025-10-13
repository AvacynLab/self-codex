/**
 * Health endpoint tests exercising the lightweight GET handler without spinning
 * up the full HTTP transport. The probe should report a healthy status whenever
 * the event loop remains responsive and the GC hook is exposed.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createHttpRequest } from "../helpers/http.js";

/**
 * Minimal structured logger collecting the events emitted by the handler so the
 * assertions can verify the call flow without relying on console output.
 */
function createLogger() {
  const entries: Array<{ level: string; event: string; details: unknown }> = [];
  return {
    info(event: string, details?: unknown) {
      entries.push({ level: "info", event, details: details ?? null });
    },
    warn(event: string, details?: unknown) {
      entries.push({ level: "warn", event, details: details ?? null });
    },
    error(event: string, details?: unknown) {
      entries.push({ level: "error", event, details: details ?? null });
    },
    entries,
  };
}

describe("http healthz", () => {
  let originalGc: (() => void) | undefined;

  beforeEach(() => {
    resetRateLimitBuckets();
    originalGc = (globalThis as { gc?: () => void }).gc;
    // Ensure the GC hook is available so the probe can report a healthy status.
    (globalThis as { gc?: () => void }).gc = () => {};
  });

  afterEach(() => {
    (globalThis as { gc?: (() => void) | undefined }).gc = originalGc;
  });

  it("reports a healthy status when the GC hook is available", async () => {
    const request = createHttpRequest("GET", "/healthz");
    (request as any).socket = { remoteAddress: "127.0.0.1" };
    const response = new MemoryHttpResponse();
    const logger = createLogger();

    await __httpServerInternals.handleHealthCheck(request as any, response as any, logger as any, "req-health");

    expect(response.statusCode).to.equal(200);
    const payload = JSON.parse(response.body) as { ok: boolean; event_loop_delay_ms: number; gc_available: boolean };
    expect(payload.ok).to.equal(true);
    expect(payload.gc_available).to.equal(true);
    expect(payload.event_loop_delay_ms).to.be.a("number");
    expect(logger.entries.some((entry) => entry.event === "http_healthz" && entry.level === "info")).to.equal(true);
  }).timeout(10_000);
});
