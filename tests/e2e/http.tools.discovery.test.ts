import { after, before, describe, it } from "mocha";
import { expect } from "chai";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/**
 * End-to-end regression tests verifying that the HTTP transport can exercise
 * the MCP tool discovery surface (`tools/list`) as well as invoke a tool via
 * the canonical `tools/call` entry point. The suite ensures our server exposes
 * the catalogue expected by clients and that introspection utilities keep
 * returning a usable descriptor.
 */
describe("http tool discovery", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle;
  let baseUrl: string;
  let originalFeatures: FeatureToggles;

  /**
   * Helper that posts a JSON-RPC payload to the ephemeral HTTP server started
   * for each test. Keeping the request boilerplate here allows the assertions
   * to focus solely on the payload semantics.
   */
  async function postJson(body: unknown) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, json };
  }

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard) {
      this.skip();
    }

    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableMcpIntrospection: true });

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
    if (!handle) {
      return;
    }
    await handle.close();
    configureRuntimeFeatures(originalFeatures);
  });

  it("lists the built-in MCP tools", async () => {
    const { status, json } = await postJson({
      jsonrpc: "2.0",
      id: "tool-list",
      method: "tools/list",
    });

    expect(status).to.equal(200);
    expect(json).to.have.property("result");
    const tools = (json as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
    const toolNames = tools.map((entry) => entry?.name).filter((name): name is string => typeof name === "string");
    expect(toolNames).to.include("mcp_info");
    expect(toolNames).to.include("mcp_capabilities");
  });

  it("invokes mcp_info via tools/call", async () => {
    const { status, json } = await postJson({
      jsonrpc: "2.0",
      id: "tool-call",
      method: "tools/call",
      params: {
        name: "mcp_info",
        arguments: {},
      },
    });

    expect(status).to.equal(200);
    expect(json).to.have.property("result");
    const descriptor = (json as { result?: { server?: { name?: string } } }).result;
    expect(descriptor?.server?.name).to.be.a("string");
  });
});
