import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/**
 * Minimal JSON-RPC envelope returned by the HTTP transport. Responses always
 * include the `jsonrpc` version and the original `id` together with either a
 * result payload or an error descriptor.
 */
interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: string | null;
  result?: T;
  error?: { code: number; message: string };
}

/** Descriptor returned by the `tx_begin` tool when transactions are enabled. */
interface TxBeginResult {
  op_id: string;
  tx_id: string;
  graph_id: string;
  base_version: number;
  idempotent: boolean;
  idempotency_key: string | null;
}

/** Shape of the JSON response returned by {@link issueTxBegin}. */
interface TxBeginResponse {
  status: number;
  body: JsonRpcEnvelope<TxBeginResult>;
}

/**
 * Issues a `tx_begin` JSON-RPC call against the provided endpoint while
 * propagating the optional idempotency key via both the header and the payload.
 * The helper keeps the graph descriptor intentionally small so the test stays
 * deterministic and easy to reason about.
 */
async function issueTxBegin(url: string, idempotencyKey?: string): Promise<TxBeginResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }

  const graphId = "idempotency-graph";
  const descriptor = {
    name: "idempotency-baseline",
    graph_id: graphId,
    graph_version: 1,
    nodes: [
      { id: "seed", label: "Seed" },
      { id: "expand", label: "Expand" },
    ],
    edges: [{ from: "seed", to: "expand", label: "flow" }],
    metadata: { owner: "idempotency-suite" },
  } as const;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tx_begin",
      params: {
        graph_id: graphId,
        owner: "idempotency-suite",
        ttl_ms: 2_000,
        note: "idempotency-check",
        idempotency_key: idempotencyKey,
        graph: descriptor,
      },
    }),
  });

  const body = (await response.json()) as JsonRpcEnvelope<TxBeginResult>;
  return { status: response.status, body };
}

/**
 * Exercices the transaction idempotency behaviour exposed by the HTTP server.
 * The suite ensures that replaying the same idempotency key does not create new
 * transactions while distinct keys keep producing independent descriptors.
 */
describe("transaction idempotency over HTTP", function () {
  this.timeout(15_000);

  const logger = new StructuredLogger();
  let handle: HttpServerHandle | null = null;
  let baseUrl = "";
  let originalFeatures: FeatureToggles;
  let originalToken: string | undefined;

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    originalToken = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...originalFeatures,
      enableTx: true,
      enableLocks: true,
      enableIdempotency: true,
    });

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
  });

  after(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    configureRuntimeFeatures(originalFeatures);
    if (originalToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalToken;
    }
  });

  it("replays the transaction descriptor when the idempotency key is reused", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }
    const key = "API_KEY=idempotent-token";
    const first = await issueTxBegin(baseUrl, key);
    const second = await issueTxBegin(baseUrl, key);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    expect(first.body.error).to.equal(undefined);
    expect(second.body.error).to.equal(undefined);

    const firstResult = first.body.result;
    const secondResult = second.body.result;
    expect(firstResult).to.not.equal(undefined);
    expect(secondResult).to.not.equal(undefined);
    expect(secondResult?.tx_id).to.equal(firstResult?.tx_id);
    expect(secondResult?.graph_id).to.equal(firstResult?.graph_id);
    expect(secondResult?.idempotency_key).to.equal(key);
    expect(secondResult?.idempotent).to.equal(true);
  });

  it("creates fresh transactions when the idempotency key changes", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }
    const first = await issueTxBegin(baseUrl, "first-key");
    const second = await issueTxBegin(baseUrl, "second-key");

    const firstResult = first.body.result;
    const secondResult = second.body.result;
    expect(firstResult?.tx_id).to.not.equal(secondResult?.tx_id);
    expect(firstResult?.idempotent).to.equal(false);
    expect(secondResult?.idempotent).to.equal(false);
  });

  it("creates fresh transactions when the idempotency key is omitted", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }
    const first = await issueTxBegin(baseUrl);
    const second = await issueTxBegin(baseUrl);

    const firstResult = first.body.result;
    const secondResult = second.body.result;
    expect(firstResult?.tx_id).to.not.equal(secondResult?.tx_id);
    expect(firstResult?.idempotency_key).to.equal(null);
    expect(secondResult?.idempotency_key).to.equal(null);
  });
});
