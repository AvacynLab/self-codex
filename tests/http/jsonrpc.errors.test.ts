import { describe, it } from "mocha";
import { expect } from "chai";

import { Buffer } from "node:buffer";

import { __httpServerInternals } from "../../src/httpServer.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";
import { MemoryHttpResponse, createHttpRequest } from "../helpers/http.js";
import type { JsonRpcRequest } from "../../src/server.js";

/**
 * Narrows an unknown payload into a structured record for assertion purposes.
 * The helper keeps the expectations explicit while avoiding repetitive casts.
 */
function expectRecord(value: unknown): Record<string, unknown> {
  expect(value).to.not.equal(null);
  expect(value).to.be.an("object");
  return value as Record<string, unknown>;
}

describe("http jsonrpc error helper", () => {
  it("serialises validation failures into JSON-RPC responses", async () => {
    const response = new MemoryHttpResponse();
    const logger = new RecordingLogger();
    const startedAt = process.hrtime.bigint();

    const bytes = await __httpServerInternals.respondWithJsonRpcError(
      response,
      400,
      "VALIDATION_ERROR",
      "Invalid Request",
      logger,
      "req-1",
      {
        startedAt,
        bytesIn: 42,
        method: "mcp.ping",
        jsonrpcId: "abc", // Provide a JSON-RPC identifier so the helper can echo it back.
      },
      {
        code: -32600,
        hint: "invalid input",
      },
    );

    expect(response.statusCode).to.equal(400);
    expect(response.headers["content-type"]).to.equal("application/json");
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload).to.deep.equal({
      jsonrpc: "2.0",
      id: "abc",
      error: {
        code: -32600,
        message: "Invalid Request",
        data: {
          category: "VALIDATION_ERROR",
          request_id: "abc",
          hint: "invalid input",
          status: 400,
        },
      },
    });
    expect(bytes).to.equal(Buffer.byteLength(response.body));

    expect(logger.entries).to.have.lengthOf(1);
    const [entry] = logger.entries;
    expect(entry?.level).to.equal("warn");
    expect(entry?.message).to.equal("http_jsonrpc_completed");
    const logPayload = expectRecord(entry?.payload);
    expect(logPayload.status).to.equal(400);
    expect(logPayload.error_code).to.equal(-32600);
    expect(logPayload.method).to.equal("mcp.ping");
  });

  it("persists server errors when idempotency caching is enabled", async () => {
    const response = new MemoryHttpResponse();
    const logger = new RecordingLogger();
    const startedAt = process.hrtime.bigint();
    const persisted: Array<{ key: string; status: number; body: string; ttl: number }> = [];

    const bytes = await __httpServerInternals.respondWithJsonRpcError(
      response,
      500,
      "INTERNAL",
      "Internal error",
      logger,
      "req-2",
      {
        startedAt,
        bytesIn: 128,
        method: "mcp.fail",
      },
      {
        cacheKey: "cache-key",
        idempotency: {
          ttlMs: 60_000,
          store: {
            async set(key: string, status: number, body: string, ttl: number) {
              persisted.push({ key, status, body, ttl });
            },
          },
        },
      },
    );

    expect(response.statusCode).to.equal(500);
    expect(response.headers["content-type"]).to.equal("application/json");
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload).to.have.property("error");
    expect((payload.error as Record<string, unknown>).code).to.equal(-32000);
    expect(((payload.error as Record<string, unknown>).data as Record<string, unknown>).status).to.equal(500);
    expect(bytes).to.equal(Buffer.byteLength(response.body));

    expect(persisted).to.deep.equal([
      {
        key: "cache-key",
        status: 500,
        body: response.body,
        ttl: 60_000,
      },
    ]);

    expect(logger.entries).to.have.lengthOf(1);
    const [entry] = logger.entries;
    expect(entry?.level).to.equal("error");
    const loggedPayload = expectRecord(entry?.payload);
    expect(loggedPayload.cache_status).to.equal("miss");
    expect(loggedPayload.status).to.equal(500);
  });

  it("omits optional route context fields when headers are absent", () => {
    const request = createHttpRequest("POST", "/mcp", {
      "content-type": "application/json",
      accept: "application/json",
    });
    const rpcRequest = { id: "rpc-1", method: "mcp.ping" } as JsonRpcRequest;

    const context = __httpServerInternals.buildRouteContextFromHeaders(request, rpcRequest);

    expect(context.headers).to.deep.equal({
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(context.transport).to.equal("http");
    expect(context.requestId).to.equal("rpc-1");
    expect("childId" in context, "childId key should be omitted").to.equal(false);
    expect("childLimits" in context, "childLimits key should be omitted").to.equal(false);
    expect("idempotencyKey" in context, "idempotency key should be omitted").to.equal(false);
  });

  it("decodes optional headers without surfacing undefined placeholders", () => {
    const encodedLimits = Buffer.from(JSON.stringify({ cpuMs: 50, memMb: 128 })).toString("base64");
    const request = createHttpRequest("POST", "/mcp", {
      "content-type": "application/json",
      accept: "application/json",
      "x-child-id": " child-7 ",
      "x-child-limits": encodedLimits,
      "idempotency-key": "   req-42   ",
    });
    const rpcRequest = { id: 42, method: "mcp.run" } as JsonRpcRequest;

    const context = __httpServerInternals.buildRouteContextFromHeaders(request, rpcRequest);

    expect(context.childId).to.equal("child-7");
    expect(context.childLimits).to.deep.equal({ cpuMs: 50, memMb: 128 });
    expect(context.idempotencyKey).to.equal("req-42");
  });
});

