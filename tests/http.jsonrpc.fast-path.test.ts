/**
 * Integration-style tests ensuring the lightweight HTTP JSON-RPC fast-path
 * remains operational. The checks complement the FS bridge coverage by
 * asserting that `mcp_info` returns a successful response and that delegated
 * tool calls are correctly routed through the server dispatcher.
 */
import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { z, type ZodTypeAny } from "zod";

import { __httpServerInternals } from "../src/httpServer.js";
import {
  configureRuntimeFeatures,
  getRuntimeFeatures,
  handleJsonRpc,
  server as mcpServer,
} from "../src/server.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "./helpers/http.js";
import { RecordingLogger } from "./helpers/recordingLogger.js";
import type { FeatureToggles } from "../src/serverOptions.js";
import { RPC_METHOD_SCHEMAS } from "../src/rpc/schemas.js";
import {
  getMutableJsonRpcRequestHandlerRegistry,
  type InternalJsonRpcHandler,
} from "../src/mcp/jsonRpcInternals.js";

/** JSON response helper mirroring the shape returned by tool handlers. */
type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> | null;
};

describe("http json-rpc fast path", () => {
  let originalFeatures: FeatureToggles;
  let handlers: Map<string, InternalJsonRpcHandler> | null = null;
  let originalToolsCall: InternalJsonRpcHandler | undefined;
  let originalToolSchema: ZodTypeAny | undefined;

  before(() => {
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableMcpIntrospection: true });
    handlers = getMutableJsonRpcRequestHandlerRegistry(mcpServer);
    originalToolsCall = handlers.get("tools/call");
    originalToolSchema = RPC_METHOD_SCHEMAS["diagnostics/echo"];
    // The JSON-RPC middleware validates tool arguments against the central
    // schema registry before delegating to handlers. Register a minimal schema
    // for the synthetic `diagnostics/echo` tool used in the assertions so the
    // middleware accepts the payload and exercises the happy-path plumbing.
    RPC_METHOD_SCHEMAS["diagnostics/echo"] = z
      .object({ payload: z.string().min(1, "payload must be provided for echo tests") })
      .strict();
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
    if (originalToolSchema) {
      RPC_METHOD_SCHEMAS["diagnostics/echo"] = originalToolSchema;
    } else {
      delete RPC_METHOD_SCHEMAS["diagnostics/echo"];
    }
  });

  it("returns a 200 response for mcp_info over HTTP", async () => {
    const request = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "info-http",
        method: "mcp_info",
        params: {},
      },
      {
        "content-type": "application/json",
        accept: "application/json",
      },
    );
    const response = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      request,
      response,
      new RecordingLogger(),
      async (payload, context) => handleJsonRpc(payload, context),
    );

    expect(handled, "request should be processed by the JSON fast-path").to.equal(true);
    expect(response.statusCode, "HTTP status").to.equal(200);
    const contentType = response.headers["content-type"] ?? response.headers["Content-Type"];
    expect(contentType, "content type").to.equal("application/json");

    const body = JSON.parse(response.body) as {
      result?: { server?: { name?: string; version?: string } };
      error?: unknown;
    };

    expect(body.error, "JSON-RPC error payload").to.equal(undefined);
    expect(body.result?.server?.name, "server name").to.be.a("string");
  }).timeout(10_000);

  it("hydrates mcp_info metadata for HTTP clients when introspection is disabled", async () => {
    const featuresBefore = getRuntimeFeatures();
    configureRuntimeFeatures({ ...featuresBefore, enableMcpIntrospection: false });

    try {
      const request = createJsonRpcRequest(
        {
          jsonrpc: "2.0",
          id: "info-http-disabled",
          method: "mcp_info",
          params: {},
        },
        {
          "content-type": "application/json",
          accept: "application/json",
        },
      );
      const response = new MemoryHttpResponse();

      const handled = await __httpServerInternals.tryHandleJsonRpc(
        request,
        response,
        new RecordingLogger(),
        async (payload, context) => handleJsonRpc(payload, context),
      );

      expect(handled, "request should be processed by the JSON fast-path").to.equal(true);
      expect(response.statusCode, "HTTP status").to.equal(200);

      const body = JSON.parse(response.body) as {
        result?: { server?: { name?: string; version?: string } };
      };

      expect(body.result?.server?.name, "server name").to.be.a("string");
      expect(body.result?.server?.version, "server version").to.be.a("string");
    } finally {
      configureRuntimeFeatures({ ...featuresBefore, enableMcpIntrospection: true });
    }
  }).timeout(10_000);

  it("delegates tool calls through the JSON fast-path", async () => {
    if (!handlers) {
      throw new Error("Handlers map not initialised");
    }

    const stubResult: ToolCallResult = {
      content: [{ type: "text", text: "stub tool response" }],
      structuredContent: { echoed: true },
    };
    handlers.set("tools/call", async (request) => {
      // Record the incoming arguments to guarantee the request propagation works end to end.
      if (!request?.params || typeof request.params !== "object") {
        throw new Error("expected params to be provided");
      }
      return stubResult;
    });

    const request = createJsonRpcRequest(
      {
        jsonrpc: "2.0",
        id: "tool-http",
        method: "tools/call",
        params: {
          name: "diagnostics/echo",
          arguments: { payload: "ping" },
        },
      },
      {
        "content-type": "application/json",
        accept: "application/json",
      },
    );
    const response = new MemoryHttpResponse();

    const handled = await __httpServerInternals.tryHandleJsonRpc(
      request,
      response,
      new RecordingLogger(),
      async (payload, context) => handleJsonRpc(payload, context),
    );

    expect(handled, "tool call should be processed").to.equal(true);
    expect(response.statusCode, "HTTP status").to.equal(200);

    const body = JSON.parse(response.body) as {
      result?: ToolCallResult;
      error?: unknown;
    };

    expect(body.error, "JSON-RPC error payload").to.equal(undefined);
    expect(body.result?.content?.[0]?.text, "tool response body").to.equal("stub tool response");
    expect(body.result?.structuredContent).to.deep.equal(stubResult.structuredContent);
  }).timeout(10_000);
});
