import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import {
  childSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  server,
  routeJsonRpcRequest,
} from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/**
 * End-to-end coverage ensuring `child_spawn_codex` provisions logical HTTP children
 * and that repeated attachments remain idempotent. The tests operate through the
 * public JSON-RPC surface so they mirror the expectations baked into the MCP
 * validation checklist.
 */
describe("child_spawn_codex + child_attach (http loopback)", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle | undefined;
  let originalFeatures: FeatureToggles;
  const originalEnv: Record<string, string | undefined> = {};

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard) {
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
    process.env.MCP_HTTP_TOKEN = "loop-secret";
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
    await childSupervisor.disposeAll();
  });

  it("creates HTTP descriptors and keeps attachments idempotent", async () => {
    const prompt = {
      system: ["Test child"],
    };

    const spawn = (await routeJsonRpcRequest("child_spawn_codex", {
      prompt,
      metadata: { source: "test" },
    })) as { endpoint: { url: string; headers: Record<string, string> } | null; child_id: string };

    expect(spawn.endpoint).to.not.equal(null);
    expect(spawn.endpoint?.url).to.equal(`http://127.0.0.1:${handle?.port}/mcp`);
    expect(spawn.endpoint?.headers).to.include({
      "x-child-id": spawn.child_id,
      authorization: "Bearer loop-secret",
    });

    const attachOnce = (await routeJsonRpcRequest("child_attach", {
      child_id: spawn.child_id,
      manifest_extras: { tag: "first" },
    })) as { attached_at: number | null; index_snapshot: { attachedAt: number | null } };

    const attachTwice = (await routeJsonRpcRequest("child_attach", {
      child_id: spawn.child_id,
      manifest_extras: { tag: "second" },
    })) as { attached_at: number | null; index_snapshot: { attachedAt: number | null } };

    expect(attachTwice.attached_at).to.equal(attachOnce.attached_at);
    expect(attachTwice.index_snapshot.attachedAt).to.equal(attachOnce.index_snapshot.attachedAt);
  });
});
