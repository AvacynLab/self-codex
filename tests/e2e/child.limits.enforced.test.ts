import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import {
  childProcessSupervisor,
  configureRuntimeFeatures,
  getEventBusInstance,
  getRuntimeFeatures,
  routeJsonRpcRequest,
  server,
} from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";
import type { EventEnvelope } from "../../src/events/bus.js";
import { expectEventPayload } from "../helpers/assertions.js";

/**
 * Validates that declarative limit updates propagate to the shared index while
 * broadcasting a `child.limits.updated` event. The assertions guarantee the
 * orchestrator satisfies the observability expectations described in the
 * checklist.
 */
describe("child_set_limits (http loopback)", () => {
  const logger = new StructuredLogger();
  let handle: HttpServerHandle | undefined;
  let originalFeatures: FeatureToggles;
  const originalEnv: Record<string, string | undefined> = {};

  before(async function () {
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (offlineGuard && offlineGuard !== "loopback-only") {
      this.skip();
    }

    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableChildOpsFine: true, enableEventsBus: true });

    handle = await startHttpServer(
      server,
      { host: "127.0.0.1", port: 0, path: "/mcp", enableJson: true, stateless: true },
      logger,
    );

    originalEnv.MCP_HTTP_STATELESS = process.env.MCP_HTTP_STATELESS;
    originalEnv.MCP_HTTP_HOST = process.env.MCP_HTTP_HOST;
    originalEnv.MCP_HTTP_PORT = process.env.MCP_HTTP_PORT;
    originalEnv.MCP_HTTP_PATH = process.env.MCP_HTTP_PATH;

    process.env.MCP_HTTP_STATELESS = "yes";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = String(handle.port);
    process.env.MCP_HTTP_PATH = "/mcp";
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
  });

  afterEach(async () => {
    await childProcessSupervisor.disposeAll();
  });

  it("stores the new limits and emits an observability event", async () => {
    const spawn = (await routeJsonRpcRequest("child_spawn_codex", {
      prompt: { system: ["limits"] },
    })) as { child_id: string };

    const bus = getEventBusInstance();
    const lastSeq = (() => {
      const history = bus.list();
      return history.length > 0 ? history[history.length - 1]!.seq : 0;
    })();

    const result = (await routeJsonRpcRequest("child_set_limits", {
      child_id: spawn.child_id,
      limits: { wallclock_ms: 1200 },
    })) as { limits: Record<string, unknown> | null };

    expect(result.limits).to.be.an("object").that.has.property("wallclock_ms", 1200);

    const newEvents = bus
      .list({ cats: ["child"] })
      .filter((event: EventEnvelope) => event.seq > lastSeq && event.msg === "child.limits.updated");

    const matching = newEvents.find((event) => event.childId === spawn.child_id);
    expect(matching, "missing child.limits.updated event").to.not.equal(undefined);
    // Narrow the event payload through the shared helper to assert the structured
    // limits snapshot without falling back to casts.
    const payload = matching && expectEventPayload(matching, "child.limits.updated");
    expect(payload).to.deep.equal({ childId: spawn.child_id, limits: result.limits });
  });
});
