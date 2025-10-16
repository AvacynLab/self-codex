/**
 * Unit tests covering the hardened token comparison helper. The checks focus on
 * verifying the rejection paths alongside the happy path to ensure callers can
 * safely rely on the constant-time primitive when enforcing the HTTP bearer
 * token.
 */
import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { checkToken, resolveHttpAuthToken } from "../../src/http/auth.js";
import { __httpServerInternals } from "../../src/httpServer.js";
import { createHttpRequest, createJsonRpcRequest, MemoryHttpResponse } from "../helpers/http.js";

describe("http auth token", () => {
  it("accepts matching tokens", () => {
    const result = checkToken("abc123", "abc123");
    expect(result, "matching tokens should validate").to.equal(true);
  });

  it("rejects missing tokens", () => {
    const result = checkToken(undefined, "expected");
    expect(result, "missing header must fail").to.equal(false);
  });

  it("rejects tokens with different length despite common prefix", () => {
    const result = checkToken("secret", "secret-extended");
    expect(result, "length mismatch must fail").to.equal(false);
  });

  it("rejects tokens with same length but different content", () => {
    const result = checkToken("abcdef", "abcdeg");
    expect(result, "different payloads must fail").to.equal(false);
  });

  it("refuses to authenticate when the expected secret is empty", () => {
    const result = checkToken("whatever", "");
    expect(result, "empty reference secret must fail").to.equal(false);
  });
});

/**
 * Regression tests covering the header parsing helper so transports other than
 * the JSON-RPC fast path can safely reuse the normalised token extraction
 * logic.
 */
type HeadersLike = Record<string, string | string[] | undefined>;

describe("resolveHttpAuthToken", () => {
  it("extracts the bearer token from the Authorization header", () => {
    const headers = { authorization: "Bearer   abc123" } as Record<string, string>;
    expect(resolveHttpAuthToken(headers), "bearer token must be parsed").to.equal("abc123");
  });

  it("falls back to the X-MCP-Token header when Authorization is missing", () => {
    const headers = { "x-mcp-token": "  from-fallback  " } as Record<string, string>;
    expect(resolveHttpAuthToken(headers), "fallback header must be honoured").to.equal("from-fallback");
  });

  it("returns undefined when neither header provides a usable token", () => {
    const headers = { authorization: "  " } as Record<string, string>;
    expect(resolveHttpAuthToken(headers), "missing payload should return undefined").to.equal(undefined);
  });

  it("ignores empty entries in multi-valued Authorization headers", () => {
    const headers = {
      authorization: ["   ", "Bearer  second-token  "],
    } as HeadersLike;

    expect(
      resolveHttpAuthToken(headers),
      "second header element should be considered when the first one is blank",
    ).to.equal("second-token");
  });

  it("prefers bearer tokens over other schemes when both are provided", () => {
    const headers = {
      authorization: ["Custom abc", "Bearer winner"],
    } as HeadersLike;

    expect(resolveHttpAuthToken(headers), "bearer token should take precedence").to.equal("winner");
  });

  it("parses comma-separated Authorization headers emitted by proxies", () => {
    const headers = {
      authorization: "Bearer  from-proxy  , Basic other",
    } as HeadersLike;

    expect(
      resolveHttpAuthToken(headers),
      "bearer token should be extracted even when the proxy concatenates credentials",
    ).to.equal("from-proxy");
  });

  it("extracts bearer tokens that follow custom schemes within the same header", () => {
    const headers = {
      authorization: "Custom foo, Bearer chained",
    } as HeadersLike;

    expect(
      resolveHttpAuthToken(headers),
      "bearer token must be prioritised even when it is appended after another scheme",
    ).to.equal("chained");
  });

  it("keeps unusual bearer tokens containing commas when no other scheme is present", () => {
    const headers = {
      authorization: "Bearer token,with,comma",
    } as HeadersLike;

    expect(
      resolveHttpAuthToken(headers),
      "the parser must not truncate uncommon but valid bearer tokens containing commas",
    ).to.equal("token,with,comma");
  });

  it("honours fallback headers that arrive as arrays", () => {
    const headers = {
      authorization: undefined,
      "x-mcp-token": ["  ", "  via-array  "],
    } as HeadersLike;

    expect(
      resolveHttpAuthToken(headers),
      "array-based fallback header should be normalised",
    ).to.equal("via-array");
  });
});

/**
 * Behavioural tests covering the HTTP guard wiring around the constant-time
 * comparison helper. The suite validates that the server rejects tokens with
 * the correct length but different payload while keeping the log output free
 * from sensitive material.
 */
describe("http bearer guard", () => {
  const previousToken = process.env.MCP_HTTP_TOKEN;
  const previousAllow = process.env.MCP_HTTP_ALLOW_NOAUTH;

  afterEach(() => {
    // Restore the expected token so unrelated tests continue observing the
    // configuration they anticipated when the process booted.
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
    __httpServerInternals.resetNoAuthBypassWarning();
  });

  it("fails closed when the server token is not configured", () => {
    delete process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;

    const request = createHttpRequest("GET", "/mcp");
    const response = new MemoryHttpResponse();
    const warnings: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      warn(event: string, payload: Record<string, unknown>) {
        warnings.push({ event, payload });
      },
      info() {},
      error() {},
    };

    const allowed = __httpServerInternals.enforceBearerToken(
      request as any,
      response as any,
      logger as any,
      "no-token",
    );

    expect(allowed, "guard must reject unauthenticated calls when no token is configured").to.equal(false);
    expect(response.statusCode, "HTTP status").to.equal(401);
    expect(warnings.some(({ payload }) => payload.reason === "token_not_configured")).to.equal(true);
  });

  it("allows unauthenticated calls when the development override is enabled", () => {
    delete process.env.MCP_HTTP_TOKEN;
    process.env.MCP_HTTP_ALLOW_NOAUTH = "1";

    const request = createHttpRequest("GET", "/mcp");
    const response = new MemoryHttpResponse();
    let bypassWarnings = 0;
    const logger = {
      warn(event: string) {
        if (event === "http_auth_bypassed") {
          bypassWarnings += 1;
        }
      },
      info() {},
      error() {},
    };

    const allowed = __httpServerInternals.enforceBearerToken(
      request as any,
      response as any,
      logger as any,
      "dev-override",
    );

    expect(allowed, "guard must honour the no-auth development override").to.equal(true);
    expect(response.statusCode, "guard should not mutate the response when bypassing").to.equal(0);
    expect(bypassWarnings, "override should be logged once for operator visibility").to.equal(1);
  });

  it("rejects same-length bearer tokens with a 401 response", () => {
    process.env.MCP_HTTP_TOKEN = "right";
    const request = createHttpRequest("GET", "/mcp", {
      authorization: "Bearer wrong",
    });
    const response = new MemoryHttpResponse();
    const warnings: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      warn(event: string, payload: Record<string, unknown>) {
        warnings.push({ event, payload });
      },
      info() {},
      error() {},
    };

    const allowed = __httpServerInternals.enforceBearerToken(
      request as any,
      response as any,
      logger as any,
      "test-request",
    );

    expect(allowed, "guard must reject mismatched payloads").to.equal(false);
    expect(response.statusCode, "HTTP status").to.equal(401);
    const payload = JSON.parse(response.body) as {
      error?: { data?: { meta?: { code?: string } } };
    };
    expect(payload.error?.data?.meta?.code).to.equal("E-MCP-AUTH");
    expect(
      warnings.every(({ payload: meta }) => !JSON.stringify(meta).includes("wrong")),
      "logger output should not contain the presented token",
    ).to.equal(true);
  });

  it("accepts the expected bearer token and allows JSON-RPC handlers to reply with 200", async () => {
    process.env.MCP_HTTP_TOKEN = "right";
    const request = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "auth-ok",
        method: "noop",
        params: {},
      },
      {
        authorization: "Bearer right",
        accept: "application/json",
        "content-type": "application/json",
      },
    );
    const response = new MemoryHttpResponse();
    const logger = {
      warn() {
        throw new Error("guard should not emit warnings when the token matches");
      },
      info() {},
      error() {},
    };

    const allowed = __httpServerInternals.enforceBearerToken(
      request as any,
      response as any,
      logger as any,
      "test-request",
    );

    expect(allowed, "guard must accept the configured token").to.equal(true);
    const handled = await __httpServerInternals.tryHandleJsonRpc(
      request as any,
      response as any,
      logger as any,
      "test-request",
      async (rpcRequest) => ({
        jsonrpc: "2.0" as const,
        id: rpcRequest.id ?? null,
        result: { ok: true },
      }),
    );

    expect(handled, "JSON-RPC fast-path should service the request").to.equal(true);
    expect(response.statusCode, "HTTP status").to.equal(200);
    const parsed = JSON.parse(response.body) as { result?: unknown };
    expect(parsed.result).to.deep.equal({ ok: true });
  });

  it("accepts the fallback header when the token matches", () => {
    process.env.MCP_HTTP_TOKEN = "fallback";
    const request = createHttpRequest("GET", "/mcp", {
      "x-mcp-token": "fallback",
    });
    const response = new MemoryHttpResponse();
    const logger = { warn() {}, info() {}, error() {} };

    const allowed = __httpServerInternals.enforceBearerToken(
      request as any,
      response as any,
      logger as any,
      "test-request",
    );

    expect(allowed, "fallback header should allow the request").to.equal(true);
    expect(response.statusCode === 0 || response.statusCode === 200).to.equal(true);
  });

  it("rejects mismatched fallback tokens with a 401 response", () => {
    process.env.MCP_HTTP_TOKEN = "expected";
    const request = createHttpRequest("GET", "/mcp", {
      "x-mcp-token": "incorrect",
    });
    const response = new MemoryHttpResponse();
    const warnings: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      warn(event: string, payload: Record<string, unknown>) {
        warnings.push({ event, payload });
      },
      info() {},
      error() {},
    };

    const allowed = __httpServerInternals.enforceBearerToken(
      request as any,
      response as any,
      logger as any,
      "test-request",
    );

    expect(allowed, "fallback mismatch must be rejected").to.equal(false);
    expect(response.statusCode, "HTTP status").to.equal(401);
    expect(warnings.some(({ event }) => event === "http_auth_rejected")).to.equal(true);
  });
});
