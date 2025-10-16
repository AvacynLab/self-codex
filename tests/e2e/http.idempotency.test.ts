import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __httpServerInternals, startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";
import { FileIdempotencyStore } from "../../src/infra/idempotencyStore.file.js";

interface TxBeginRequestPayload {
  graph_id: string;
  graph: {
    graph_id: string;
    graph_version: number;
    name: string;
    nodes: Array<{ id: string; label: string; attributes: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; label: string; attributes: Record<string, unknown> }>;
    metadata: Record<string, unknown>;
  };
  owner: string;
  note?: string;
}

/**
 * Posts a JSON-RPC request to the HTTP endpoint with an optional idempotency
 * key. The response body is returned as-is so callers can compare payloads.
 */
interface TxBeginResultPayload {
  tx_id: string;
  graph_id: string;
  base_version: number;
  idempotent: boolean;
  idempotency_key: string | null;
}

interface TxBeginEnvelope {
  jsonrpc: "2.0";
  id: string | null;
  result?: TxBeginResultPayload;
  error?: { code: number; message: string };
}

interface TxBeginInvocation {
  status: number;
  body: TxBeginEnvelope;
  headers: Record<string, string>;
}

async function invokeWithIdempotency(
  url: string,
  payload: TxBeginRequestPayload,
  idempotencyKey?: string,
): Promise<TxBeginInvocation> {
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
      // Propagate the idempotency key inside the payload as well so the server
      // can flag the descriptor accordingly.
      params: idempotencyKey ? { ...payload, idempotency_key: idempotencyKey } : payload,
    }),
  });
  const body = (await response.json()) as TxBeginEnvelope;
  const responseHeaders = Object.fromEntries(response.headers.entries());
  return { status: response.status, body, headers: responseHeaders };
}

describe("http idempotency propagation", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle;
  let baseUrl: string;
  let originalFeatures: FeatureToggles;
  let originalLimiter: { disabled: boolean; rps: number; burst: number };
  let sandboxDir: string;
  let idempotencyStore: FileIdempotencyStore | null = null;
  let allowSnapshot: string | undefined;

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...originalFeatures,
      enableTx: true,
      enableIdempotency: true,
    });
    delete process.env.MCP_HTTP_TOKEN;
    allowSnapshot = process.env.MCP_HTTP_ALLOW_NOAUTH;
    process.env.MCP_HTTP_ALLOW_NOAUTH = "1";
    originalLimiter = { ...__httpServerInternals.getRateLimiterConfig() };
    __httpServerInternals.configureRateLimiter({ disabled: true });

    sandboxDir = await mkdtemp(join(tmpdir(), "http-idempotency-e2e-"));
    idempotencyStore = await FileIdempotencyStore.create({ directory: sandboxDir });

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
      { idempotency: { store: idempotencyStore, ttlMs: 10_000 } },
    );
    baseUrl = `http://127.0.0.1:${handle.port}/mcp`;
  });

  after(async () => {
    if (!handle) {
      return;
    }
    await handle.close();
    configureRuntimeFeatures(originalFeatures);
    __httpServerInternals.configureRateLimiter(originalLimiter);
    if (sandboxDir) {
      await rm(sandboxDir, { recursive: true, force: true });
    }
    if (allowSnapshot === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = allowSnapshot;
    }
  });
  it("returns identical payloads when the idempotency key is reused", async () => {
    const key = "http-idem-key";

    const payload = makeTxBeginPayload("http-idem-same-key");
    const first = await invokeWithIdempotency(baseUrl, payload, key);
    const second = await invokeWithIdempotency(baseUrl, payload, key);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    const firstResult = first.body.result;
    const secondResult = second.body.result;
    expect(firstResult).to.not.equal(undefined);
    expect(secondResult).to.not.equal(undefined);
    if (!firstResult || !secondResult) {
      throw new Error("tx_begin did not return a payload");
    }
    expect(firstResult.tx_id).to.equal(secondResult.tx_id);
    expect(firstResult.idempotency_key).to.equal(key);
    expect(secondResult.idempotent).to.equal(firstResult.idempotent);
    expect(second.headers["x-idempotency-cache"]).to.equal("hit");
  });

  it("emits different payloads when the idempotency key changes", async () => {
    const first = await invokeWithIdempotency(baseUrl, makeTxBeginPayload(`http-idem-${randomUUID()}`), "key-one");
    const second = await invokeWithIdempotency(baseUrl, makeTxBeginPayload(`http-idem-${randomUUID()}`), "key-two");

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    const firstResult = first.body.result;
    const secondResult = second.body.result;
    expect(firstResult).to.not.equal(undefined);
    expect(secondResult).to.not.equal(undefined);
    if (!firstResult || !secondResult) {
      throw new Error("tx_begin did not return a payload");
    }
    expect(firstResult.idempotency_key).to.equal("key-one");
    expect(secondResult.idempotency_key).to.equal("key-two");
    expect(firstResult.tx_id).to.not.equal(secondResult.tx_id);
    expect(first.headers["x-idempotency-cache"]).to.equal(undefined);
    expect(second.headers["x-idempotency-cache"]).to.equal(undefined);
  });
});

function makeTxBeginPayload(graphId: string): TxBeginRequestPayload {
  return {
    graph_id: graphId,
    graph: {
      graph_id: graphId,
      graph_version: 1,
      name: "Idempotency Test Graph",
      nodes: [
        { id: "ingest", label: "Ingest", attributes: {} },
        { id: "process", label: "Process", attributes: {} },
      ],
      edges: [{ from: "ingest", to: "process", label: "flow", attributes: {} }],
      metadata: { owner: "idempotency-suite" },
    },
    owner: "idempotency-suite",
    note: "seed idempotency graph",
  };
}
