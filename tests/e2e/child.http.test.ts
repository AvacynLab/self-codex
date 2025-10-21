import { after, before, describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { configureRuntimeFeatures, getRuntimeFeatures, handleJsonRpc, server as mcpServer } from "../../src/server.js";
import { StructuredLogger } from "../../src/logger.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";
import type { FeatureToggles } from "../../src/serverOptions.js";
import {
  getMutableJsonRpcRequestHandlerRegistry,
  type InternalJsonRpcHandler,
} from "../../src/mcp/jsonRpcInternals.js";

/**
 * End-to-end checks covering child orchestration over the stateless HTTP bridge.
 *
 * The scenario mirrors the self-provider workflow: spawn a Codex child via
 * HTTP, then issue a follow-up tool call that must propagate the `X-Child-Id`
 * header for correlation.
 */
describe("http child orchestration", () => {
  const logger = new StructuredLogger();
  let originalFeatures: FeatureToggles;
  let originalToolsCall: InternalJsonRpcHandler | undefined;
  let handlers: Map<string, InternalJsonRpcHandler> | null = null;
  let capturedSpawnArgs: Record<string, unknown> | null = null;
  const stubChildId = "child-http-stub";

  before(() => {
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableChildOpsFine: true });
    handlers = getMutableJsonRpcRequestHandlerRegistry(mcpServer);
    originalToolsCall = handlers.get("tools/call");
    handlers.set("tools/call", async (request, extra) => {
      if (request?.params && typeof request.params === "object") {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> };
        if (params.name === "child_spawn_codex") {
          capturedSpawnArgs = { ...(params.arguments ?? {}) };
          return {
            content: [],
            structuredContent: {
              child_id: stubChildId,
              idempotency_key: capturedSpawnArgs.idempotency_key ?? null,
            },
          };
        }
        if (params.name === "child_status") {
          return {
            content: [],
            structuredContent: {
              child_id: params.arguments?.child_id ?? null,
              state: "ready",
            },
          };
        }
      }
      if (!originalToolsCall) {
        throw new Error("tools/call handler missing");
      }
      return originalToolsCall(request, extra);
    });
  });

  after(() => {
    configureRuntimeFeatures(originalFeatures);
    if (handlers) {
      if (originalToolsCall) {
        handlers.set("tools/call", originalToolsCall);
      } else {
        handlers.delete("tools/call");
      }
    }
    capturedSpawnArgs = null;
  });

  it("spawns a codex child and propagates X-Child-Id on follow-up calls", async () => {
    const idempotencyKey = "http-child-key";
    const spawnRequest = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "spawn-1",
        method: "child_spawn_codex",
        params: {
          prompt: { system: "You are a diagnostic helper." },
        },
      },
      {
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": idempotencyKey,
      },
    );
    const spawnResponse = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      spawnRequest,
      spawnResponse,
      logger,
      async (payload, context) => handleJsonRpc(payload, context),
    );
    expect(handled, "spawn request should be processed").to.equal(true);

    const spawnJson = JSON.parse(spawnResponse.body) as {
      result?: { child_id?: string; idempotency_key?: string | null };
      error?: unknown;
    };

    expect(spawnJson.error, "spawn error payload").to.equal(undefined);
    expect(spawnJson.result?.child_id, "child identifier").to.equal(stubChildId);
    expect(spawnJson.result?.idempotency_key, "idempotency propagation").to.equal(idempotencyKey);
    expect(capturedSpawnArgs?.idempotency_key, "delegated idempotency argument").to.equal(idempotencyKey);

    const statusRequest = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "status-1",
        method: "child_status",
        params: { child_id: stubChildId },
      },
      {
        "content-type": "application/json",
        accept: "application/json",
        "x-child-id": stubChildId,
      },
    );
    const statusResponse = new MemoryHttpResponse();
    let capturedContext: unknown;

    const statusHandled = await __httpServerInternals.tryHandleJsonRpc(
      statusRequest,
      statusResponse,
      logger,
      async (payload, context) => {
        capturedContext = context;
        return handleJsonRpc(payload, context);
      },
    );

    expect(statusHandled, "status request should be processed").to.equal(true);
    const statusJson = JSON.parse(statusResponse.body) as { result?: Record<string, unknown>; error?: unknown };
    expect(statusJson.error, "status error payload").to.equal(undefined);
    expect(statusJson.result, "status result payload").to.be.an("object");
    expect(capturedContext).to.deep.include({ childId: stubChildId });
  }).timeout(20_000);
});
