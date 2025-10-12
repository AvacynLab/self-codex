import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/** Simple descriptor returned by the stubbed `tools/call` handler. */
interface IdempotentResult {
  token: string;
}

type ToolsCallHandler = (request: any, extra: any) => Promise<unknown> | unknown;

/**
 * Posts a JSON-RPC request to the HTTP endpoint with an optional idempotency
 * key. The response body is returned as-is so callers can compare payloads.
 */
async function invokeWithIdempotency(
  url: string,
  idempotencyKey?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tx_begin",
      params: {},
    }),
  });
  return { status: response.status, json: await response.json() };
}

describe("http idempotency propagation", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle;
  let baseUrl: string;
  let originalFeatures: FeatureToggles;
  let handlers: Map<string, ToolsCallHandler> | undefined;
  let originalToolsCall: ToolsCallHandler | undefined;

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableTransactions: true });
    delete process.env.MCP_HTTP_TOKEN;

    handle = await startHttpServer(
      mcpServer,
      {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        enableJson: true,
        stateless: true,
      },
      logger,
    );
    baseUrl = `http://127.0.0.1:${handle.port}/mcp`;

    const internal = mcpServer.server as unknown as {
      _requestHandlers?: Map<string, ToolsCallHandler>;
    };
    handlers = internal._requestHandlers;
    if (!handlers) {
      throw new Error("MCP handlers map not initialised");
    }
    originalToolsCall = handlers.get("tools/call");
    handlers.set("tools/call", async (request) => {
      const params = request?.params ?? {};
      const args =
        typeof params === "object" && params !== null
          ? ((params as { arguments?: Record<string, unknown> }).arguments ?? {})
          : {};
      const token = typeof (args as { idempotency_key?: unknown }).idempotency_key === "string"
        ? (args as { idempotency_key: string }).idempotency_key
        : randomUUID();
      const result: IdempotentResult = { token };
      return { content: [], structuredContent: result };
    });
  });

  after(async () => {
    if (!handle) {
      return;
    }
    await handle.close();
    if (handlers) {
      if (originalToolsCall) {
        handlers.set("tools/call", originalToolsCall);
      } else {
        handlers.delete("tools/call");
      }
    }
    configureRuntimeFeatures(originalFeatures);
  });
  it("returns identical payloads when the idempotency key is reused", async () => {
    const key = "http-idem-key";

    const first = await invokeWithIdempotency(baseUrl, key);
    const second = await invokeWithIdempotency(baseUrl, key);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    const firstResult = (first.json as { result?: IdempotentResult }).result;
    const secondResult = (second.json as { result?: IdempotentResult }).result;
    expect(firstResult).to.deep.equal(secondResult);
    expect(firstResult?.token).to.equal(key);
  });

  it("emits different payloads when the idempotency key changes", async () => {
    const first = await invokeWithIdempotency(baseUrl, "key-one");
    const second = await invokeWithIdempotency(baseUrl, "key-two");

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    const firstResult = (first.json as { result?: IdempotentResult }).result;
    const secondResult = (second.json as { result?: IdempotentResult }).result;
    expect(firstResult).to.not.deep.equal(secondResult);
  });
});
