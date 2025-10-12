import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";

import { StructuredLogger } from "../../src/logger.js";
import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

interface ChildSnapshot {
  child_id: string;
  idempotent: boolean;
  idempotency_key: string | null;
  endpoint: { url: string; headers: Record<string, string> } | null;
}

interface JsonRpcResponseBody<T> {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: { code: number; message: string };
}

type JsonValue = Record<string, unknown>;

async function postJson(
  url: string,
  method: string,
  params: JsonValue,
  idempotencyKey?: string,
): Promise<{ status: number; body: JsonRpcResponseBody<JsonValue> }> {
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
      method,
      params,
    }),
  });

  const body = (await response.json()) as JsonRpcResponseBody<JsonValue>;
  return { status: response.status, body };
}

describe("http idempotency endpoints", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle;
  let baseUrl: string;
  let originalFeatures: FeatureToggles;

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }

    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...originalFeatures,
      enableTx: true,
      enableLocks: true,
      enableBulk: true,
      enableChildOpsFine: true,
      enableIdempotency: true,
      enableResources: true,
    });

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
  });

  after(async () => {
    if (handle) {
      await handle.close();
    }
    configureRuntimeFeatures(originalFeatures);
  });

  it("replays tx_begin payloads when the idempotency key is reused", async () => {
    const key = "http-tx-batch";
    const params = {
      graph_id: "http-idem-graph",
      owner: "tester",
      ttl_ms: 1_000,
      idempotency_key: key,
    } satisfies JsonValue;

    const first = await postJson(baseUrl, "tx_begin", params, key);
    const second = await postJson(baseUrl, "tx_begin", params, key);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    expect(first.body.error).to.equal(undefined);
    expect(second.body.error).to.equal(undefined);
    expect(second.body.result).to.deep.equal(first.body.result);
  });

  it("replays child_batch_create payloads when all entries expose idempotency keys", async () => {
    const payload = {
      entries: [
        {
          prompt: { system: "Tu es un copilote.", user: ["Analyse"] },
          role: "planner",
          idempotency_key: "batch-entry-one",
        },
        {
          prompt: { system: "Tu es un copilote.", user: ["Synthèse"] },
          role: "reviewer",
          idempotency_key: "batch-entry-two",
        },
      ],
    } satisfies JsonValue;

    const headerKey = "child-batch-http";
    const first = await postJson(baseUrl, "child_batch_create", payload, headerKey);
    const second = await postJson(baseUrl, "child_batch_create", payload, headerKey);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    expect(first.body.error).to.equal(undefined);
    expect(second.body.error).to.equal(undefined);

    const firstResult = first.body.result as
      | { children?: ChildSnapshot[]; created?: number; idempotent_entries?: number }
      | undefined;
    const secondResult = second.body.result as
      | { children?: ChildSnapshot[]; created?: number; idempotent_entries?: number }
      | undefined;

    expect(firstResult, "missing first batch response").to.not.equal(undefined);
    expect(secondResult, "missing second batch response").to.not.equal(undefined);
    if (!firstResult || !secondResult) {
      throw new Error("child_batch_create did not return payloads");
    }

    const firstChildren = (firstResult.children ?? []) as ChildSnapshot[];
    const secondChildren = (secondResult.children ?? []) as ChildSnapshot[];

    expect(firstChildren).to.have.lengthOf(payload.entries.length);
    expect(secondChildren).to.have.lengthOf(payload.entries.length);

    const firstIds = firstChildren.map((child) => child.child_id);
    const secondIds = secondChildren.map((child) => child.child_id);

    expect(firstResult.created).to.equal(payload.entries.length);
    expect(firstResult.idempotent_entries).to.equal(0);
    for (const child of firstChildren) {
      expect(child.idempotent).to.equal(false);
      expect(child.endpoint?.url).to.match(/^http:\/\/(127\.0\.0\.1|0\.0\.0\.0):\d+\/mcp$/);
      expect(child.idempotency_key).to.be.a("string");
    }

    expect(secondResult.created).to.equal(0);
    expect(secondResult.idempotent_entries).to.equal(payload.entries.length);
    expect(secondIds).to.deep.equal(firstIds);
    for (const child of secondChildren) {
      expect(child.idempotent).to.equal(true);
      expect(child.idempotency_key).to.be.a("string");
    }
  });
});
