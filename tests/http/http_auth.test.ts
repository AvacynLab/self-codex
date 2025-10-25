import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { server as mcpServer } from "../../src/server.js";

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/**
 * End-to-end regression tests covering the HTTP authentication behaviour.  The
 * suite boots the production transport so the token guard, development bypass,
 * and JSON-RPC surface are exercised under realistic conditions.
 */
describe("http auth integration", function () {
  this.timeout(15000);

  let handle: HttpServerHandle | null = null;
  let baseUrl: string;
  const logger = new StructuredLogger();
  let tokenSnapshot: string | undefined;
  let allowSnapshot: string | undefined;

  beforeEach(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }

    tokenSnapshot = process.env.MCP_HTTP_TOKEN;
    allowSnapshot = process.env.MCP_HTTP_ALLOW_NOAUTH;
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    if (tokenSnapshot === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = tokenSnapshot;
    }
    if (allowSnapshot === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = allowSnapshot;
    }
  });

  async function startServer(): Promise<void> {
    const httpHandle = await startHttpServer(
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
    handle = httpHandle;
    baseUrl = `http://127.0.0.1:${handle.port}/mcp`;
  }

  async function postJson(body: unknown, headers: Record<string, string> = {}) {
    if (!handle) {
      throw new Error("HTTP server not started");
    }
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as JsonRpcEnvelope;
    return { response, json };
  }

  it("rejects requests that omit the bearer token", async () => {
    process.env.MCP_HTTP_TOKEN = "integration-secret";
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;

    await startServer();

    const { response, json } = await postJson({
      jsonrpc: "2.0",
      id: "missing-token",
      method: "mcp_ping",
      params: {},
    });

    expect(response.status).to.equal(401);
    expect(json.error?.data?.meta?.code).to.equal("E-MCP-AUTH");
  });

  it("rejects requests when the token is unset and no bypass flag is enabled", async () => {
    // Security regression: ensure the transport defaults to 401 when operators forget to
    // configure MCP_HTTP_TOKEN and do not explicitly opt into the local-only bypass.
    delete process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;

    await startServer();

    const { response, json } = await postJson({
      jsonrpc: "2.0",
      id: "token-not-configured",
      method: "mcp_ping",
      params: {},
    });

    expect(response.status).to.equal(401);
    expect(json.error?.message).to.equal("Authentication required");
  });

  it("continues to reject requests when MCP_HTTP_ALLOW_NOAUTH=0", async () => {
    // Guardrail: falsy values (0/false) must behave the same as the default configuration so
    // deployments cannot accidentally disable authentication with a typo.
    process.env.MCP_HTTP_TOKEN = "integration-secret";
    process.env.MCP_HTTP_ALLOW_NOAUTH = "0";

    await startServer();

    const { response } = await postJson({
      jsonrpc: "2.0",
      id: "noauth-disabled",
      method: "mcp_ping",
      params: {},
    });

    expect(response.status).to.equal(401);
  });

  it("accepts requests that provide the configured bearer token", async () => {
    process.env.MCP_HTTP_TOKEN = "integration-secret";
    delete process.env.MCP_HTTP_ALLOW_NOAUTH;

    await startServer();

    const { response, json } = await postJson(
      {
        jsonrpc: "2.0",
        id: "token-present",
        method: "mcp_info",
        params: {},
      },
      { authorization: "Bearer integration-secret" },
    );

    expect(response.status).to.equal(200);
    expect(json.result).to.be.an("object");
  });

  it("honours the no-auth override when explicitly enabled", async () => {
    delete process.env.MCP_HTTP_TOKEN;
    process.env.MCP_HTTP_ALLOW_NOAUTH = "1";

    await startServer();

    const { response, json } = await postJson({
      jsonrpc: "2.0",
      id: "noauth-override",
      method: "mcp_ping",
      params: {},
    });

    expect(response.status).to.equal(200);
    expect(json.result).to.deep.equal({ ok: true });
  });
});
