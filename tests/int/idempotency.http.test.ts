/**
 * Integration test exercising the HTTP fast-path idempotency replay with the
 * new file-backed store. Two identical JSON-RPC requests are issued with the
 * same `Idempotency-Key` header, the second one must be replayed from disk
 * without invoking the delegate again.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __httpServerInternals, type HttpIdempotencyConfig } from "../../src/httpServer.js";
import { FileIdempotencyStore } from "../../src/infra/idempotencyStore.file.js";
import { buildIdempotencyCacheKey } from "../../src/infra/idempotency.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";
import type { JsonRpcRequest } from "../../src/server.js";
import { RecordingLogger } from "../helpers/recordingLogger.js";

describe("http idempotency persistence", () => {
  let sandboxRoot: string;
  let originalRunsRoot: string | undefined;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "http-idempotency-"));
    originalRunsRoot = process.env.MCP_RUNS_ROOT;
    process.env.MCP_RUNS_ROOT = join(sandboxRoot, "runs");
  });

  afterEach(async () => {
    if (originalRunsRoot === undefined) {
      delete process.env.MCP_RUNS_ROOT;
    } else {
      process.env.MCP_RUNS_ROOT = originalRunsRoot;
    }
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("replays the cached JSON-RPC response on subsequent retries", async () => {
    const store = await FileIdempotencyStore.create({ directory: sandboxRoot });
    const idempotency: HttpIdempotencyConfig = { store, ttlMs: 10_000 };
    let callCount = 0;

    const logger = new RecordingLogger();

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
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { jsonrpc: "2.0", id: request.id ?? null, result: { attempt: callCount } };
    };

    const firstStartedAt = process.hrtime.bigint();
    const handledFirst = await __httpServerInternals.tryHandleJsonRpc(
      firstRequest,
      firstResponse,
      logger,
      "rid-1",
      delegate,
      idempotency,
    );
    const firstElapsedMs = Number((process.hrtime.bigint() - firstStartedAt) / BigInt(1_000_000));

    expect(handledFirst, "fast-path should consume the first request").to.equal(true);
    expect(firstResponse.statusCode, "first status code").to.equal(200);
    const parsedFirst = JSON.parse(firstResponse.body) as { result?: { attempt?: number } };
    expect(parsedFirst.result?.attempt, "first attempt counter").to.equal(1);

    const walRoot = process.env.MCP_RUNS_ROOT ?? "";
    const walTopicDir = join(walRoot, "wal", "tx");
    const walFiles = await readdir(walTopicDir).catch(() => [] as string[]);
    expect(walFiles.length, "wal rotation").to.be.greaterThan(0);
    const walPath = join(walTopicDir, walFiles[0]!);
    const walContents = await readFile(walPath, "utf8");
    const walLines = walContents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(walLines, "wal entries after first call").to.have.length(1);
    const walEntry = JSON.parse(walLines[0]) as {
      topic: string;
      event: string;
      payload: { cache_key: string; idempotency_key: string; method: string };
    };
    expect(walEntry.topic, "wal topic").to.equal("tx");
    expect(walEntry.event, "wal event").to.equal("tx_begin");
    expect(walEntry.payload.idempotency_key, "wal idempotency key").to.equal("alpha");
    const expectedCacheKey = buildIdempotencyCacheKey(payload.method, "alpha", payload.params);
    expect(walEntry.payload.cache_key, "wal cache key").to.equal(expectedCacheKey);

    const secondRequest = createJsonRpcRequest(payload, {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": "alpha",
    });
    const secondResponse = new MemoryHttpResponse();

    const secondStartedAt = process.hrtime.bigint();
    const handledSecond = await __httpServerInternals.tryHandleJsonRpc(
      secondRequest,
      secondResponse,
      logger,
      "rid-2",
      delegate,
      idempotency,
    );
    const secondElapsedMs = Number((process.hrtime.bigint() - secondStartedAt) / BigInt(1_000_000));

    expect(handledSecond, "fast-path should handle the replay").to.equal(true);
    expect(callCount, "delegate should only run once").to.equal(1);
    expect(secondResponse.statusCode, "second status code").to.equal(200);
    expect(secondResponse.headers["x-idempotency-cache"], "cache marker header").to.equal("hit");
    expect(secondResponse.body, "replayed payload").to.equal(firstResponse.body);
    expect(secondElapsedMs, "cached response latency").to.be.lessThan(firstElapsedMs);

    const walAfterReplay = await readFile(walPath, "utf8");
    const walLinesAfterReplay = walAfterReplay
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(walLinesAfterReplay, "wal entries after replay").to.deep.equal(walLines);
  });

  it("returns a 409 conflict when the idempotency key is reused with divergent params", async () => {
    const store = await FileIdempotencyStore.create({ directory: sandboxRoot });
    const idempotency: HttpIdempotencyConfig = { store, ttlMs: 10_000 };

    const logger = new RecordingLogger();

    const payload = {
      jsonrpc: "2.0" as const,
      id: "conflict-1",
      method: "tx_begin",
      params: { graph_id: "g", idempotency_key: "body" },
    } satisfies JsonRpcRequest;

    const request = createJsonRpcRequest(payload, {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": "alpha",
    });
    const response = new MemoryHttpResponse();

    await __httpServerInternals.tryHandleJsonRpc(
      request,
      response,
      logger,
      "rid-conflict-1",
      async (req: JsonRpcRequest) => ({ jsonrpc: "2.0", id: req.id ?? null, result: { ok: true } }),
      idempotency,
    );

    const divergentPayload = {
      ...payload,
      id: "conflict-2",
      params: { graph_id: "g-different", idempotency_key: "body" },
    } satisfies JsonRpcRequest;
    const divergentRequest = createJsonRpcRequest(divergentPayload, {
      "content-type": "application/json",
      accept: "application/json",
      "idempotency-key": "alpha",
    });
    const divergentResponse = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      divergentRequest,
      divergentResponse,
      logger,
      "rid-conflict-2",
      async (req: JsonRpcRequest) => ({ jsonrpc: "2.0", id: req.id ?? null, result: { ok: true } }),
      idempotency,
    );

    expect(handled, "conflict should be handled by fast-path").to.equal(true);
    expect(divergentResponse.statusCode, "http conflict status").to.equal(409);
    const parsed = JSON.parse(divergentResponse.body) as { error?: { code?: number; message?: string } };
    expect(parsed.error?.code, "json-rpc error code").to.equal(-32080);
    expect(parsed.error?.message, "json-rpc error message").to.equal("Idempotency conflict");
  });
});
