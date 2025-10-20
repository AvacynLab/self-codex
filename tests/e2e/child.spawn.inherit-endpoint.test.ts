import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import {
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  routeJsonRpcRequest,
  server,
} from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/**
 * Ensures logical HTTP children reuse the parent endpoint descriptor (URL and
 * headers) when they spawn additional children. The scenario mirrors a
 * self-provider chain where a child orchestrator provisions a sibling and must
 * forward the same bearer token to keep subsequent tool calls authorised.
 */
describe("child_spawn_codex (nested http loopback)", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle | undefined;
  let originalFeatures: FeatureToggles;
  const originalEnv: Record<string, string | undefined> = {};
  const token = "loop-secret";

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }

    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableChildOpsFine: true });

    handle = await startHttpServer(
      server,
      { host: "127.0.0.1", port: 0, path: "/mcp", enableJson: true, stateless: true },
      logger,
    );

    originalEnv.MCP_HTTP_STATELESS = process.env.MCP_HTTP_STATELESS;
    originalEnv.MCP_HTTP_HOST = process.env.MCP_HTTP_HOST;
    originalEnv.MCP_HTTP_PORT = process.env.MCP_HTTP_PORT;
    originalEnv.MCP_HTTP_PATH = process.env.MCP_HTTP_PATH;
    originalEnv.MCP_HTTP_TOKEN = process.env.MCP_HTTP_TOKEN;

    process.env.MCP_HTTP_STATELESS = "yes";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = String(handle.port);
    process.env.MCP_HTTP_PATH = "/mcp";
    process.env.MCP_HTTP_TOKEN = token;
  });

  after(async () => {
    if (handle) {
      await handle.close();
    }
    configureRuntimeFeatures(originalFeatures);
    process.env.MCP_HTTP_STATELESS = originalEnv.MCP_HTTP_STATELESS;
    process.env.MCP_HTTP_HOST = originalEnv.MCP_HTTP_HOST;
    process.env.MCP_HTTP_PORT = originalEnv.MCP_HTTP_PORT;
    process.env.MCP_HTTP_PATH = originalEnv.MCP_HTTP_PATH;
    process.env.MCP_HTTP_TOKEN = originalEnv.MCP_HTTP_TOKEN;
  });

  afterEach(async () => {
    await childProcessSupervisor.disposeAll();
  });

  it("reuses the parent endpoint and token when spawning nested children", async () => {
    const parentSpawn = (await routeJsonRpcRequest("child_spawn_codex", {
      prompt: { system: ["Parent"] },
    })) as { child_id: string; endpoint: { url: string; headers: Record<string, string> } | null };

    expect(parentSpawn.endpoint, "missing parent endpoint").to.not.equal(null);
    const parentEndpoint = parentSpawn.endpoint!;

    const nestedLimits = { wallclock_ms: 1_750 };
    const rpcRequest = {
      jsonrpc: "2.0" as const,
      id: "nested",
      method: "child_spawn_codex",
      params: {
        prompt: { system: ["Nested"] },
        limits: nestedLimits,
      },
    };

    const response = await fetch(`http://127.0.0.1:${handle?.port}/mcp`, {
      method: "POST",
      headers: {
        ...parentEndpoint.headers,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(rpcRequest),
    });

    expect(response.ok, `unexpected status ${response.status}`).to.equal(true);
    const json = (await response.json()) as {
      result: { child_id: string; endpoint: { url: string; headers: Record<string, string> } | null };
    };

    const nested = json.result;
    expect(nested.endpoint, "nested child missing endpoint").to.not.equal(null);

    const nestedEndpoint = nested.endpoint!;
    expect(nestedEndpoint.url).to.equal(parentEndpoint.url);
    expect(nestedEndpoint.headers.authorization).to.equal(parentEndpoint.headers.authorization);
    expect(nestedEndpoint.headers["x-child-id"]).to.equal(nested.child_id);

    const encodedLimits = nestedEndpoint.headers["x-child-limits"];
    expect(encodedLimits, "nested limits header").to.be.a("string");
    const decodedLimits = JSON.parse(Buffer.from(encodedLimits!, "base64").toString("utf8"));
    expect(decodedLimits).to.deep.equal(nestedLimits);
  });
});
