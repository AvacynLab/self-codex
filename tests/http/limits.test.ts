/**
 * Boundary tests covering the new HTTP guards: payload size enforcement and the
 * lightweight token-bucket rate limiter. Using the JSON fast-path helpers keeps
 * the assertions quick while providing deterministic behaviour.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { __httpServerInternals } from "../../src/httpServer.js";
import {
  parseRateLimitEnvBoolean,
  parseRateLimitEnvNumber,
  rateLimitOk,
  resetRateLimitBuckets,
} from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";

describe("http limits", () => {
  const envKeys = [
    "MCP_HTTP_RATE_LIMIT_DISABLE",
    "MCP_HTTP_RATE_LIMIT_RPS",
    "MCP_HTTP_RATE_LIMIT_BURST",
  ] as const;
  const originalEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 10, burst: 20 });
    resetRateLimitBuckets();
  });

  afterEach(() => {
    // Restore the default limiter configuration so other suites observe the documented baseline.
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 10, burst: 20 });
    resetRateLimitBuckets();
    for (const key of envKeys) {
      if (typeof originalEnv[key] === "string") {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("rejects payloads larger than 1MiB with 413", async () => {
    const oversized = {
      jsonrpc: "2.0" as const,
      id: "big-payload",
      method: "mcp_info",
      params: { filler: "x".repeat(1_100_000) },
    };
    const request = createJsonRpcRequest(oversized, {
      "content-type": "application/json",
      accept: "application/json",
    });
    const response = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(request, response, new RecordingLogger());

    expect(handled, "request should be consumed by the fast-path").to.equal(true);
    expect(response.statusCode, "HTTP status").to.equal(413);
    const body = JSON.parse(response.body) as { error?: { code?: number; message?: string } };
    expect(body.error?.code, "JSON-RPC error code").to.equal(-32600);
  }).timeout(10_000);

  it("returns 429 once the rate limit bucket is exhausted", () => {
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 10, burst: 20 });
    resetRateLimitBuckets();
    const key = "127.0.0.1:/mcp";
    const logger = new RecordingLogger();

    // Consume the full burst allowance.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ok = __httpServerInternals.enforceRateLimit(key, new MemoryHttpResponse(), logger, "rid");
      expect(ok, `attempt ${attempt} should be allowed`).to.equal(true);
    }

    const throttledResponse = new MemoryHttpResponse();
    const allowed = __httpServerInternals.enforceRateLimit(key, throttledResponse, logger, "rid");
    expect(allowed, "21st attempt should be throttled").to.equal(false);
    expect(throttledResponse.statusCode, "HTTP status").to.equal(429);
    const throttledBody = JSON.parse(throttledResponse.body) as {
      error?: { message?: string; data?: { category?: string; hint?: string } };
    };
    expect(throttledBody.error?.message, "error message").to.equal("Rate limit exceeded");
    expect(throttledBody.error?.data?.category, "error category").to.equal("RATE_LIMITED");
    expect(throttledBody.error?.data?.hint, "error hint").to.match(/rate limit/i);
  });

  it("bypasses throttling when the limiter is disabled at runtime", () => {
    __httpServerInternals.configureRateLimiter({ disabled: true });
    resetRateLimitBuckets();
    const key = "127.0.0.1:/mcp";
    const logger = new RecordingLogger();

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ok = __httpServerInternals.enforceRateLimit(key, new MemoryHttpResponse(), logger, "rid");
      expect(ok, `attempt ${attempt} should bypass throttling`).to.equal(true);
    }
  });

  it("ignores non-finite overrides while preserving the previous configuration", () => {
    const baseline = __httpServerInternals.configureRateLimiter({ disabled: false, rps: 15, burst: 25 });
    const mutated = __httpServerInternals.configureRateLimiter({
      // Deliberately provide non-finite values so the helper exercises its sanitisation path.
      rps: Number.NaN,
      burst: Number.POSITIVE_INFINITY,
    });

    expect(mutated.rps).to.equal(baseline.rps);
    expect(mutated.burst).to.equal(baseline.burst);
    expect(mutated.disabled).to.equal(false);
  });

  it("refreshes the rate limiter configuration from environment variables", () => {
    process.env.MCP_HTTP_RATE_LIMIT_DISABLE = "true";
    process.env.MCP_HTTP_RATE_LIMIT_RPS = "7";
    process.env.MCP_HTTP_RATE_LIMIT_BURST = "13";

    const mutated = __httpServerInternals.refreshRateLimiterFromEnv();

    expect(mutated.disabled, "env disable flag").to.equal(true);
    expect(mutated.rps, "env RPS override").to.equal(7);
    expect(mutated.burst, "env burst override").to.equal(13);
  });

  it("re-enables the limiter when the disable flag is explicitly cleared", () => {
    process.env.MCP_HTTP_RATE_LIMIT_DISABLE = "false";
    __httpServerInternals.configureRateLimiter({ disabled: true, rps: 3, burst: 5 });

    const mutated = __httpServerInternals.refreshRateLimiterFromEnv();

    expect(mutated.disabled, "limiter should be re-enabled").to.equal(false);
    expect(mutated.rps, "baseline RPS fallback").to.equal(10);
    expect(mutated.burst, "baseline burst fallback").to.equal(20);
  });

  it("disables the limiter when zero or negative rates are supplied", () => {
    process.env.MCP_HTTP_RATE_LIMIT_DISABLE = "0";
    process.env.MCP_HTTP_RATE_LIMIT_RPS = "0";
    process.env.MCP_HTTP_RATE_LIMIT_BURST = "-5";

    const mutated = __httpServerInternals.refreshRateLimiterFromEnv();

    expect(mutated.disabled, "zero/negative settings should disable the limiter").to.equal(true);
  });

  it("parses boolean overrides using the documented helper", () => {
    process.env.MCP_HTTP_RATE_LIMIT_DISABLE = "YeS";
    expect(parseRateLimitEnvBoolean("MCP_HTTP_RATE_LIMIT_DISABLE")).to.equal(true);
    process.env.MCP_HTTP_RATE_LIMIT_DISABLE = "off";
    expect(parseRateLimitEnvBoolean("MCP_HTTP_RATE_LIMIT_DISABLE")).to.equal(false);
    process.env.MCP_HTTP_RATE_LIMIT_DISABLE = "garbage";
    expect(parseRateLimitEnvBoolean("MCP_HTTP_RATE_LIMIT_DISABLE")).to.equal(undefined);
  });

  it("parses numeric overrides while rejecting garbage", () => {
    process.env.MCP_HTTP_RATE_LIMIT_RPS = "25";
    process.env.MCP_HTTP_RATE_LIMIT_BURST = "12.5";
    expect(parseRateLimitEnvNumber("MCP_HTTP_RATE_LIMIT_RPS")).to.equal(25);
    expect(parseRateLimitEnvNumber("MCP_HTTP_RATE_LIMIT_BURST")).to.equal(12.5);

    process.env.MCP_HTTP_RATE_LIMIT_RPS = "not-a-number";
    expect(parseRateLimitEnvNumber("MCP_HTTP_RATE_LIMIT_RPS")).to.equal(undefined);
  });

  describe("token bucket mechanics", () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 0 });
      resetRateLimitBuckets();
    });

    afterEach(() => {
      clock.restore();
      resetRateLimitBuckets();
    });

    it("allows short bursts before throttling and refills over time", () => {
      const key = "127.0.0.1:/mcp";

      expect(rateLimitOk(key, 1, 2)).to.equal(true);
      expect(rateLimitOk(key, 1, 2)).to.equal(true);
      expect(rateLimitOk(key, 1, 2), "burst exhausted").to.equal(false);

      clock.tick(1_000);
      expect(rateLimitOk(key, 1, 2), "token refilled after one second").to.equal(true);
    });

    it("caps the bucket at the burst size even after a long idle period", () => {
      const key = "ratelimit:long-idle";

      expect(rateLimitOk(key, 5, 3)).to.equal(true);
      expect(rateLimitOk(key, 5, 3)).to.equal(true);
      expect(rateLimitOk(key, 5, 3)).to.equal(true);
      expect(rateLimitOk(key, 5, 3), "fourth request should require a refill").to.equal(false);

      clock.tick(60_000);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(rateLimitOk(key, 5, 3), `refilled attempt ${attempt}`).to.equal(true);
      }

      expect(rateLimitOk(key, 5, 3), "bucket should not exceed burst capacity").to.equal(false);
    });
  });
});
