/**
 * Boundary tests covering the new HTTP guards: payload size enforcement and the
 * lightweight token-bucket rate limiter. Using the JSON fast-path helpers keeps
 * the assertions quick while providing deterministic behaviour.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { resetRateLimitBuckets } from "../../src/http/rateLimit.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";

describe("http limits", () => {
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
});
