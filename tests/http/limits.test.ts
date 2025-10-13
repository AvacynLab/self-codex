/**
 * Boundary tests covering the new HTTP guards: payload size enforcement and the
 * lightweight token-bucket rate limiter. Using the JSON fast-path helpers keeps
 * the assertions quick while providing deterministic behaviour.
 */
import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";

describe("http limits", () => {
  afterEach(() => {
    // Restore the default limiter configuration so other suites observe the documented baseline.
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 10, burst: 20 });
    resetRateLimitBuckets();
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

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      request,
      response as any,
      new Proxy(
        {},
        {
          get() {
            return () => {};
          },
        },
      ),
    );

    expect(handled, "request should be consumed by the fast-path").to.equal(true);
    expect(response.statusCode, "HTTP status").to.equal(413);
    const body = JSON.parse(response.body) as { error?: { code?: number; message?: string } };
    expect(body.error?.code, "JSON-RPC error code").to.equal(-32600);
  }).timeout(10_000);

  it("returns 429 once the rate limit bucket is exhausted", () => {
    __httpServerInternals.configureRateLimiter({ disabled: false, rps: 10, burst: 20 });
    resetRateLimitBuckets();
    const key = "127.0.0.1:/mcp";
    const logger = new Proxy(
      {},
      {
        get() {
          return () => {};
        },
      },
    );

    // Consume the full burst allowance.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ok = __httpServerInternals.enforceRateLimit(key, new MemoryHttpResponse() as any, logger as any, "rid");
      expect(ok, `attempt ${attempt} should be allowed`).to.equal(true);
    }

    const throttledResponse = new MemoryHttpResponse();
    const allowed = __httpServerInternals.enforceRateLimit(key, throttledResponse as any, logger as any, "rid");
    expect(allowed, "21st attempt should be throttled").to.equal(false);
    expect(throttledResponse.statusCode, "HTTP status").to.equal(429);
    const throttledBody = JSON.parse(throttledResponse.body) as { error?: { message?: string } };
    expect(throttledBody.error?.message, "error message").to.equal("Too Many Requests");
  });

  it("bypasses throttling when the limiter is disabled at runtime", () => {
    __httpServerInternals.configureRateLimiter({ disabled: true });
    resetRateLimitBuckets();
    const key = "127.0.0.1:/mcp";
    const logger = new Proxy(
      {},
      {
        get() {
          return () => {};
        },
      },
    );

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ok = __httpServerInternals.enforceRateLimit(key, new MemoryHttpResponse() as any, logger as any, "rid");
      expect(ok, `attempt ${attempt} should bypass throttling`).to.equal(true);
    }
  });

  it("ignores non-finite overrides while preserving the previous configuration", () => {
    const baseline = __httpServerInternals.configureRateLimiter({ disabled: false, rps: 15, burst: 25 });
    const mutated = __httpServerInternals.configureRateLimiter({
      // The cast keeps TypeScript happy while the runtime helper sanitises the value.
      rps: Number.NaN as unknown as number,
      burst: Number.POSITIVE_INFINITY as unknown as number,
    });

    expect(mutated.rps).to.equal(baseline.rps);
    expect(mutated.burst).to.equal(baseline.burst);
    expect(mutated.disabled).to.equal(false);
  });
});
