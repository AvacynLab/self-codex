/**
 * Integration test exercising the HTTP fast-path idempotency replay with the
 * new file-backed store. Two identical JSON-RPC requests are issued with the
 * same `Idempotency-Key` header, the second one must be replayed from disk
 * without invoking the delegate again.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __httpServerInternals, type HttpIdempotencyConfig } from "../../src/httpServer.js";
import { FileIdempotencyStore } from "../../src/infra/idempotencyStore.file.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";
import type { JsonRpcRequest } from "../../src/server.js";

describe("http idempotency persistence", () => {
  let sandboxRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "http-idempotency-"));
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("replays the cached JSON-RPC response on subsequent retries", async () => {
    const store = await FileIdempotencyStore.create({ directory: sandboxRoot });
    const idempotency: HttpIdempotencyConfig = { store, ttlMs: 10_000 };
    let callCount = 0;

    const logger = new Proxy(
      {},
      {
        get() {
          return () => {};
        },
      },
    );

    const payload = {
      jsonrpc: "2.0" as const,
      id: "req-42",
      method: "tx_begin",
      params: { graph_id: "g", idempotency_key: "body" },
    } satisfies JsonRpcRequest;

    const firstRequest = createJsonRpcRequest(payload, {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": "alpha",
    });
    const firstResponse = new MemoryHttpResponse();

    const delegate = async (request: JsonRpcRequest) => {
      callCount += 1;
      return { jsonrpc: "2.0", id: request.id ?? null, result: { attempt: callCount } };
    };

    const handledFirst = await __httpServerInternals.tryHandleJsonRpc(
      firstRequest as any,
      firstResponse as any,
      logger as any,
      "rid-1",
      delegate,
      idempotency,
    );

    expect(handledFirst, "fast-path should consume the first request").to.equal(true);
    expect(firstResponse.statusCode, "first status code").to.equal(200);
    const parsedFirst = JSON.parse(firstResponse.body) as { result?: { attempt?: number } };
    expect(parsedFirst.result?.attempt, "first attempt counter").to.equal(1);

    const secondRequest = createJsonRpcRequest(payload, {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": "alpha",
    });
    const secondResponse = new MemoryHttpResponse();

    const handledSecond = await __httpServerInternals.tryHandleJsonRpc(
      secondRequest as any,
      secondResponse as any,
      logger as any,
      "rid-2",
      delegate,
      idempotency,
    );

    expect(handledSecond, "fast-path should handle the replay").to.equal(true);
    expect(callCount, "delegate should only run once").to.equal(1);
    expect(secondResponse.statusCode, "second status code").to.equal(200);
    expect(secondResponse.headers["x-idempotency-cache"], "cache marker header").to.equal("hit");
    expect(secondResponse.body, "replayed payload").to.equal(firstResponse.body);
  });
});
