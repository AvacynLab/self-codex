import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

type ToolsCallHandler = (request: any, extra: any) => Promise<unknown> | unknown;

interface CapturedInvocation {
  headers: Record<string, string>;
  args: Record<string, unknown> | null;
}

/** Posts a JSON-RPC payload to the stateless HTTP endpoint. */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/**
 * Issues a JSON-RPC call against the stateless HTTP endpoint while decorating
 * the request with the headers expected from Codex child sessions.
 */
async function invokeHttp(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  return postJson(url, {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name: "child_status", arguments: { child_id: "child-from-http" } },
  }, headers);
}

describe("http child context propagation", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle;
  let baseUrl: string;
  let originalFeatures: FeatureToggles;
  let originalToken: string | undefined;
  let handlers: Map<string, ToolsCallHandler> | undefined;
  let originalToolsCall: ToolsCallHandler | undefined;
  let captured: CapturedInvocation | null = null;

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }
    originalToken = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableChildOpsFine: true });

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
      _requestHandlers?: Map<string, (request: any, extra: any) => Promise<unknown> | unknown>;
    };
    handlers = internal._requestHandlers;
    if (!handlers) {
      throw new Error("MCP handlers map not initialised");
    }
    originalToolsCall = handlers.get("tools/call");
    handlers.set("tools/call", async (request, extra) => {
      const params = request?.params ?? {};
      const args = typeof params === "object" && params !== null ? (params as { arguments?: Record<string, unknown> }).arguments : null;
      captured = {
        headers: { ...(extra?.requestInfo?.headers ?? {}) },
        args: args ?? null,
      };
      return {
        content: [],
        structuredContent: {
          child_id: args?.child_id ?? null,
          observed_headers: captured.headers,
        },
      };
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
    if (originalToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalToken;
    }
  });

  afterEach(() => {
    captured = null;
  });

  it("lists the available tools over the stateless HTTP transport", async () => {
    const { status, json } = await postJson(baseUrl, {
      jsonrpc: "2.0",
      id: "stateless-tools",
      method: "tools/list",
    });

    expect(status).to.equal(200);
    const tools = (json as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
    const toolNames = tools
      .map((entry) => entry?.name)
      .filter((name): name is string => typeof name === "string");
    expect(toolNames).to.include("mcp_info");
    expect(toolNames).to.include("child_spawn_codex");
  });

  it("forwards child headers and limits to the underlying handler", async () => {
    const limits = { cpuMs: 250, wallMs: 5000 };
    const encodedLimits = Buffer.from(JSON.stringify(limits), "utf8").toString("base64");

    const { status, json } = await invokeHttp(baseUrl, {
      "x-child-id": "child-from-http",
      "x-child-limits": encodedLimits,
      "idempotency-key": "child-headers-test",
    });

    expect(status).to.equal(200);
    expect(captured).to.not.equal(null);
    expect(captured?.headers["x-child-id"]).to.equal("child-from-http");
    expect(captured?.headers["x-child-limits"]).to.equal(encodedLimits);
    expect(captured?.headers["idempotency-key"]).to.equal("child-headers-test");
    expect(captured?.headers["x-mcp-transport"]).to.equal("http");
    expect(json).to.be.an("object");
  });
});
