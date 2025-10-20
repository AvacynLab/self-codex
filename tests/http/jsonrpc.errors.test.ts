import { describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";
import { MemoryHttpResponse } from "../helpers/http.js";

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
      response as any,
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
      response as any,
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
});

