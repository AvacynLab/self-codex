import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { MemoryHttpResponse, createHttpRequest, createJsonRpcRequest } from "../helpers/http.js";

describe("http server helpers", () => {
  const logger = new StructuredLogger();

  describe("enforceBearerToken", () => {
    beforeEach(() => {
      process.env.MCP_HTTP_TOKEN = "secret";
    });

    afterEach(() => {
      delete process.env.MCP_HTTP_TOKEN;
    });

    it("rejects requests that omit the bearer token", () => {
      const request = createHttpRequest("GET", "/health", {});
      const response = new MemoryHttpResponse();

      const allowed = __httpServerInternals.enforceBearerToken(request, response, logger, "reject-missing");

      expect(allowed).to.equal(false);
      expect(response.statusCode).to.equal(401);
      expect(response.headers["content-type"]).to.equal("application/json");
      expect(response.body).to.contain("E-MCP-AUTH");
    });

    it("accepts matching bearer tokens", () => {
      const request = createHttpRequest("GET", "/health", { authorization: "Bearer secret" });
      const response = new MemoryHttpResponse();

      const allowed = __httpServerInternals.enforceBearerToken(request, response, logger, "accept-matching");

      expect(allowed).to.equal(true);
      expect(response.headersSent).to.equal(false);
    });
  });

  describe("tryHandleJsonRpc", () => {
    it("delegates JSON-RPC requests with propagated context", async () => {
      const childLimits = { cpuMs: 250 };
      const body = { jsonrpc: "2.0", id: "test", method: "noop", params: {} };
      const request = createJsonRpcRequest(body, {
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer secret",
        "x-child-id": "child-http",
        "x-child-limits": Buffer.from(JSON.stringify(childLimits), "utf8").toString("base64"),
        "idempotency-key": "http-key",
      });
      const response = new MemoryHttpResponse();

      let capturedContext: unknown;
      const delegate = async (payload: any, context?: unknown) => {
        capturedContext = context;
        return { jsonrpc: "2.0", id: payload.id, result: { ok: true } };
      };

      const handled = await __httpServerInternals.tryHandleJsonRpc(request, response, logger, delegate);

      expect(handled).to.equal(true);
      expect(response.statusCode).to.equal(200);
      expect(JSON.parse(response.body)).to.deep.equal({ jsonrpc: "2.0", id: "test", result: { ok: true } });
      expect(capturedContext).to.deep.include({
        transport: "http",
        childId: "child-http",
        idempotencyKey: "http-key",
      });
      expect((capturedContext as { childLimits?: unknown }).childLimits).to.deep.equal(childLimits);
    });
  });
});

