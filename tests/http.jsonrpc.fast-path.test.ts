/**
 * Integration-style tests ensuring the lightweight HTTP JSON-RPC fast-path
 * remains operational. The checks complement the FS bridge coverage by
 * asserting that `mcp_info` returns a successful response and that delegated
 * tool calls are correctly routed through the server dispatcher.
 */
import { after, before, describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../src/httpServer.js";
import {
  configureRuntimeFeatures,
  getRuntimeFeatures,
  handleJsonRpc,
  server as mcpServer,
} from "../src/server.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "./helpers/http.js";
import type { FeatureToggles } from "../src/serverOptions.js";

/** JSON response helper mirroring the shape returned by tool handlers. */
type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> | null;
};

describe("http json-rpc fast path", () => {
  let originalFeatures: FeatureToggles;
  let handlers:
    | Map<string, (request: any, extra: any) => Promise<unknown> | unknown>
    | undefined;
  let originalToolsCall:
    | ((
        request: { jsonrpc: "2.0"; id: string | number | null; method: string; params?: unknown },
        extra: unknown,
      ) => Promise<unknown> | unknown)
    | undefined;

  before(() => {
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableMcpIntrospection: true });
    const internal = mcpServer.server as unknown as {
      _requestHandlers?: Map<string, (request: any, extra: any) => Promise<unknown> | unknown>;
    };
    handlers = internal._requestHandlers;
    if (!handlers) {
      throw new Error("MCP server handlers map not initialised");
    }
    originalToolsCall = handlers.get("tools/call");
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
      response as any,
      new Proxy(
        {},
        {
          get() {
            // The logger interface is not required for the happy path; return no-ops.
            return () => {};
          },
        },
      ),
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
        response as any,
        new Proxy(
          {},
          {
            get() {
              return () => {};
            },
          },
        ),
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
    handlers.set("tools/call", async (request: any) => {
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
      response as any,
      new Proxy(
        {},
        {
          get() {
            return () => {};
          },
        },
      ),
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
