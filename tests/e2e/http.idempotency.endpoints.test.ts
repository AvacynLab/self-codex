import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { randomUUID } from "node:crypto";

import { StructuredLogger } from "../../src/logger.js";
import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import {
  childSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  server as mcpServer,
} from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";
import type { ChildRuntimeStatus } from "../../src/childRuntime.js";
import type { ChildRecordSnapshot } from "../../src/state/childrenIndex.js";

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

  afterEach(() => {
    sinon.restore();
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
    const now = Date.now();
    const statusOne: ChildRuntimeStatus = {
      childId: "child-http-1",
      pid: 42,
      command: "node",
      args: ["child.js"],
      workdir: "/tmp/child-http-1",
      startedAt: now,
      lastHeartbeatAt: null,
      lifecycle: "running",
      closed: false,
      exit: null,
      resourceUsage: null,
    };
    const statusTwo: ChildRuntimeStatus = {
      ...statusOne,
      childId: "child-http-2",
      workdir: "/tmp/child-http-2",
    };

    const snapshotOne: ChildRecordSnapshot = {
      childId: statusOne.childId,
      pid: statusOne.pid,
      workdir: statusOne.workdir,
      state: "running",
      startedAt: statusOne.startedAt,
      lastHeartbeatAt: null,
      retries: 0,
      metadata: { role: "planner" },
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      forcedTermination: false,
      stopReason: null,
      role: "planner",
      limits: null,
      attachedAt: statusOne.startedAt,
    };
    const snapshotTwo: ChildRecordSnapshot = {
      ...snapshotOne,
      childId: statusTwo.childId,
      workdir: statusTwo.workdir,
      metadata: { role: "reviewer" },
      role: "reviewer",
    };

    const createStub = sinon.stub(childSupervisor, "createChild");
    createStub
      .onCall(0)
      .resolves({
        childId: statusOne.childId,
        runtime: {
          manifestPath: `${statusOne.workdir}/manifest.json`,
          logPath: `${statusOne.workdir}/log.ndjson`,
          getStatus: () => statusOne,
        },
        index: snapshotOne,
        readyMessage: null,
      });
    createStub
      .onCall(1)
      .resolves({
        childId: statusTwo.childId,
        runtime: {
          manifestPath: `${statusTwo.workdir}/manifest.json`,
          logPath: `${statusTwo.workdir}/log.ndjson`,
          getStatus: () => statusTwo,
        },
        index: snapshotTwo,
        readyMessage: null,
      });

    sinon.stub(childSupervisor, "kill").resolves();
    sinon.stub(childSupervisor, "waitForExit").resolves();
    sinon.stub(childSupervisor, "gc").callsFake(() => undefined);

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
    expect(second.body.result).to.deep.equal(first.body.result);
    expect(createStub.callCount).to.equal(2);
  });
});
