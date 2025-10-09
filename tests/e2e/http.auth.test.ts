import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/**
 * Thin wrapper around {@link fetch} that always targets the HTTP MCP endpoint
 * started by the tests below. Using a helper keeps the assertions focused on
 * authentication semantics rather than URL manipulation.
 */
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

describe("http json-rpc authentication", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle;
  let baseUrl: string;
  let originalFeatures: FeatureToggles;

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard) {
      this.skip();
    }
    // Enable MCP introspection so the mcp_info call used in tests stays valid
    // even when the default configuration disables optional tools.
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

  afterEach(() => {
    delete process.env.MCP_HTTP_TOKEN;
  });

  it("returns 401 when the bearer token is missing", async () => {
    process.env.MCP_HTTP_TOKEN = "top-secret";

    const { status, json } = await postJson(baseUrl, {
      jsonrpc: "2.0",
      id: "auth-1",
      method: "mcp_info",
      params: {},
    });

    expect(status).to.equal(401);
    expect(json).to.deep.equal({ jsonrpc: "2.0", id: null, error: { code: 401, message: "E-MCP-AUTH" } });
  });

  it("accepts valid bearer tokens", async () => {
    process.env.MCP_HTTP_TOKEN = "valid";

    const { status, json } = await postJson(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: "auth-2",
        method: "mcp_info",
        params: {},
      },
      { authorization: "Bearer valid" },
    );

    expect(status).to.equal(200);
    expect(json).to.have.property("result").that.is.an("object");
  });
});
