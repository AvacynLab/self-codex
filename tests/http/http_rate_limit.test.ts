/**
 * Integration-style tests verifying the rate limiter wiring inside the HTTP
 * fast-path. The suite exercises the same guard ordering as the production
 * server (authentication → throttling → JSON-RPC handling) to guarantee we
 * return structured JSON errors when the bucket is exhausted while still
 * serving steady traffic once tokens have been replenished.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { __httpServerInternals } from "../../src/httpServer.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { createHttpRequest, MemoryHttpResponse } from "../helpers/http.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";

const CLIENT_IP = "192.0.2.42";
const ROUTE = "/mcp";

/**
 * Builds a JSON-RPC request mirroring the lightweight HTTP transport used by
 * clients. The helper ensures authentication headers and payload shape match
 * the production contract so the guards exercise the same branches as the
 * orchestrator.
 */
function buildJsonRpcRequest(id: string) {
  return createHttpRequest(
    "POST",
    ROUTE,
    {
      authorization: "Bearer test-secret",
      accept: "application/json",
      "content-type": "application/json",
    },
    {
      jsonrpc: "2.0",
      id,
      method: "noop",
      params: {},
    },
    { remoteAddress: CLIENT_IP },
  );
}

describe("http rate limit integration", () => {
  const previousToken = process.env.MCP_HTTP_TOKEN;
  const previousAllow = process.env.MCP_HTTP_ALLOW_NOAUTH;
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    process.env.MCP_HTTP_TOKEN = "test-secret";
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    clock = sinon.useFakeTimers({ now: 0 });
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 1, burst: 2 });
    resetRateLimitBuckets();
    __httpServerInternals.resetNoAuthBypassWarning();
  });

  afterEach(() => {
    clock.restore();
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 10, burst: 20 });
    resetRateLimitBuckets();
    __httpServerInternals.resetNoAuthBypassWarning();
    if (previousToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = previousToken;
    }
    if (previousAllow === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = previousAllow;
    }
  });

  it("returns 429 when a burst exhausts the bucket and recovers after refill", async () => {
    const logger = new RecordingLogger();
    const delegate = async (request: { id: string | number | null }) => ({
      jsonrpc: "2.0" as const,
      id: request.id ?? null,
      result: { ok: true },
    });
    const limiterKey = `${CLIENT_IP}:${ROUTE}`;

    for (const attempt of ["first", "second"]) {
      const response = new MemoryHttpResponse();
      const allowed = __httpServerInternals.enforceRateLimit(limiterKey, response, logger, attempt);
      expect(allowed, `${attempt} request should bypass throttling`).to.equal(true);

      const handled = await __httpServerInternals.tryHandleJsonRpc(
        buildJsonRpcRequest(attempt),
        response,
        logger,
        attempt,
        delegate,
      );

      expect(handled, "JSON-RPC handler must service the request").to.equal(true);
      expect(response.statusCode, "HTTP status").to.equal(200);
      const payload = JSON.parse(response.body) as { result?: unknown };
      expect(payload.result).to.deep.equal({ ok: true });
    }

    const throttled = new MemoryHttpResponse();
    const allowed = __httpServerInternals.enforceRateLimit(limiterKey, throttled, logger, "third");
    expect(allowed, "burst should exhaust the bucket").to.equal(false);
    expect(throttled.statusCode, "HTTP status").to.equal(429);
    const throttledPayload = JSON.parse(throttled.body) as { error?: { message?: string; data?: { hint?: string } } };
    expect(throttledPayload.error?.message).to.equal("Rate limit exceeded");
    expect(throttledPayload.error?.data?.hint).to.match(/rate limit/i);

    clock.tick(1_000);

    const recovered = new MemoryHttpResponse();
    const recoveredAllowed = __httpServerInternals.enforceRateLimit(limiterKey, recovered, logger, "recovered");
    expect(recoveredAllowed, "token bucket should refill after waiting").to.equal(true);

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      buildJsonRpcRequest("recovered"),
      recovered,
      logger,
      "recovered",
      delegate,
    );

    expect(handled, "JSON-RPC handler must run after refill").to.equal(true);
    expect(recovered.statusCode, "HTTP status").to.equal(200);
  });
});
