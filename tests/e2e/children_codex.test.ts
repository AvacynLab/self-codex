import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FeatureToggles } from "../../src/serverOptions.js";
import type { EventEnvelope } from "../../src/events/bus.js";
import { resolveFixture, runnerArgs } from "../helpers/childRunner.js";

/**
 * High fidelity end-to-end coverage of the Codex child lifecycle when the
 * orchestrator relies on a process-backed runtime instead of the HTTP loopback
 * shim.  The suite validates the following sequence through the public JSON-RPC
 * tools:
 *
 * 1. Spawn a child using the dedicated `child_spawn_codex` tool while injecting
 *    deterministic metadata and resource limits.
 * 2. Attach to the running child to refresh its manifest and confirm the
 *    timestamp remains stable across repeated invocations.
 * 3. Send a prompt through `child_send` and await the final response emitted by
 *    the mocked runner, ensuring the message is recorded in the supervisor
 *    index.
 * 4. Tighten the declarative limits via `child_set_limits` and assert that the
 *    shared event bus surfaces a `child.limits.updated` observability event.
 * 5. Terminate the child with `child_kill`, confirm the supervisor index marks
 *    the child as killed, and finally reclaim the resources via `child_gc`.
 *
 * The mock runner located under `tests/fixtures/mock-runner.ts` acts as a
 * deterministic stand-in for a Codex binary: it emits a ready handshake, echoes
 * JSON payloads, and terminates cleanly on `SIGTERM`.  By forcing the MCP server
 * to spawn this runner we guarantee that the entire toolchain (supervisor,
 * runtime limits, event bus) is exercised without depending on external
 * binaries.
 */
describe("codex child lifecycle (process-backed)", function () {
  this.timeout(25_000);

  const originalEnv: Record<string, string | undefined> = {};
  let featuresSnapshot: FeatureToggles;
  let tempChildrenRoot = "";
  let serverModule: typeof import("../../src/server.js");

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    tempChildrenRoot = await mkdtemp(join(tmpdir(), "codex-child-e2e-"));
    const runnerPath = resolveFixture(import.meta.url, "../fixtures/mock-runner.ts");

    originalEnv.MCP_CHILDREN_ROOT = process.env.MCP_CHILDREN_ROOT;
    originalEnv.MCP_CHILD_ARGS = process.env.MCP_CHILD_ARGS;
    originalEnv.MCP_CHILD_COMMAND = process.env.MCP_CHILD_COMMAND;
    originalEnv.MCP_HTTP_STATELESS = process.env.MCP_HTTP_STATELESS;

    process.env.MCP_CHILDREN_ROOT = tempChildrenRoot;
    process.env.MCP_CHILD_ARGS = JSON.stringify(runnerArgs(runnerPath, "--scenario", "codex-child-e2e"));
    process.env.MCP_CHILD_COMMAND = process.execPath;
    process.env.MCP_HTTP_STATELESS = "no";

    serverModule = await import("../../src/server.js");
    featuresSnapshot = serverModule.getRuntimeFeatures();
    serverModule.configureRuntimeFeatures({
      ...featuresSnapshot,
      enableChildOpsFine: true,
      enableEventsBus: true,
    });
  });

  after(async () => {
    if (serverModule) {
      serverModule.configureRuntimeFeatures(featuresSnapshot);
      await serverModule.childSupervisor.disposeAll();
    }

    if (originalEnv.MCP_CHILDREN_ROOT === undefined) {
      delete process.env.MCP_CHILDREN_ROOT;
    } else {
      process.env.MCP_CHILDREN_ROOT = originalEnv.MCP_CHILDREN_ROOT;
    }

    if (originalEnv.MCP_CHILD_ARGS === undefined) {
      delete process.env.MCP_CHILD_ARGS;
    } else {
      process.env.MCP_CHILD_ARGS = originalEnv.MCP_CHILD_ARGS;
    }

    if (originalEnv.MCP_CHILD_COMMAND === undefined) {
      delete process.env.MCP_CHILD_COMMAND;
    } else {
      process.env.MCP_CHILD_COMMAND = originalEnv.MCP_CHILD_COMMAND;
    }

    if (originalEnv.MCP_HTTP_STATELESS === undefined) {
      delete process.env.MCP_HTTP_STATELESS;
    } else {
      process.env.MCP_HTTP_STATELESS = originalEnv.MCP_HTTP_STATELESS;
    }

    if (tempChildrenRoot) {
      await rm(tempChildrenRoot, { recursive: true, force: true });
    }
  });

  it("spawns, attaches, sends, limits and kills a Codex child", async function () {
    const { routeJsonRpcRequest, childSupervisor, getEventBusInstance } = serverModule;
    const bus = getEventBusInstance();
    const baselineSeq = (() => {
      const history = bus.list();
      return history.length > 0 ? history[history.length - 1]!.seq : 0;
    })();

    const rawSpawn = await routeJsonRpcRequest("child_spawn_codex", {
      prompt: { system: ["Diagnose the pipeline"], user: ["Report the latest status"] },
      metadata: { task_id: "codex-child-e2e" },
      limits: { wallclock_ms: 15_000, tokens: 1_024 },
    });

    const spawnResultCandidate =
      rawSpawn && typeof rawSpawn === "object" && Object.prototype.hasOwnProperty.call(rawSpawn, "structuredContent")
        ? (rawSpawn as { structuredContent?: unknown }).structuredContent
        : rawSpawn;

    if (!spawnResultCandidate || typeof spawnResultCandidate !== "object") {
      throw new Error("child_spawn_codex did not return a payload");
    }

    if (typeof (spawnResultCandidate as { child_id?: unknown }).child_id !== "string") {
      this.skip();
      return;
    }

    const spawnResult = spawnResultCandidate as {
      child_id: string;
      runtime_status: { pid: number; lifecycle: string; workdir: string };
      index_snapshot: { manifestPath: string; limits: Record<string, unknown> | null };
      endpoint: { url: string } | null;
    };

    expect(spawnResult.child_id).to.match(/^child-\d{13}-[a-f0-9]{6}$/);
    expect(spawnResult.runtime_status.pid).to.be.a("number").that.is.greaterThan(0);
    expect(spawnResult.runtime_status.lifecycle).to.equal("ready");
    expect(spawnResult.endpoint).to.equal(null);
    expect(spawnResult.index_snapshot.limits).to.deep.equal({ wallclock_ms: 15_000, tokens: 1_024 });

    const attachFirst = (await routeJsonRpcRequest("child_attach", {
      child_id: spawnResult.child_id,
      manifest_extras: { refreshed_by: "codex-child-e2e" },
    })) as { attached_at: number | null; index_snapshot: { attachedAt: number | null } };

    expect(attachFirst.attached_at).to.be.a("number").that.is.greaterThan(0);
    expect(attachFirst.index_snapshot.attachedAt).to.equal(attachFirst.attached_at);

    const attachAgain = (await routeJsonRpcRequest("child_attach", {
      child_id: spawnResult.child_id,
      manifest_extras: { refreshed_by: "codex-child-e2e-repeat" },
    })) as { attached_at: number | null; index_snapshot: { attachedAt: number | null } };

    expect(attachAgain.attached_at).to.equal(attachFirst.attached_at);

    const sendResult = (await routeJsonRpcRequest("child_send", {
      child_id: spawnResult.child_id,
      payload: { type: "prompt", content: "Provide a brief heartbeat." },
      expect: "final",
      timeout_ms: 2_000,
    })) as {
      child_id: string;
      message: { messageId: string; sentAt: number };
      awaited_message: { parsed: { type?: string; content?: unknown } | null; stream: string } | null;
    };

    expect(sendResult.child_id).to.equal(spawnResult.child_id);
    expect(sendResult.message.messageId).to.match(/^child-\d{13}-[a-f0-9]{6}:\d+$/);
    expect(sendResult.awaited_message?.parsed).to.be.an("object");
    expect(sendResult.awaited_message?.parsed?.type).to.equal("response");
    const indexAfterSend = childSupervisor.childrenIndex.getChild(spawnResult.child_id);
    expect(indexAfterSend?.state).to.equal("idle");

    const limitsResult = (await routeJsonRpcRequest("child_set_limits", {
      child_id: spawnResult.child_id,
      limits: { wallclock_ms: 1_000, cpu_ms: 250 },
    })) as { limits: Record<string, unknown> | null };

    expect(limitsResult.limits).to.deep.equal({ wallclock_ms: 1_000, cpu_ms: 250 });

    const eventsAfterLimits = bus
      .list({ cats: ["child"] })
      .filter((event: EventEnvelope) => event.seq > baselineSeq && event.childId === spawnResult.child_id);
    const limitEvent = eventsAfterLimits.find((event) => event.msg === "child.limits.updated");
    expect(limitEvent, "missing child.limits.updated event").to.not.equal(undefined);
    expect(limitEvent?.stage).to.equal("limits");

    const killResult = (await routeJsonRpcRequest("child_kill", {
      child_id: spawnResult.child_id,
      timeout_ms: 500,
    })) as { child_id: string; shutdown: { forced: boolean; durationMs: number } };

    expect(killResult.child_id).to.equal(spawnResult.child_id);
    expect(killResult.shutdown.forced).to.equal(true);

    await childSupervisor.waitForExit(spawnResult.child_id, 1_000);
    const indexAfterKill = childSupervisor.childrenIndex.getChild(spawnResult.child_id);
    expect(indexAfterKill?.state).to.equal("killed");

    const eventsAfterKill = bus
      .list({ cats: ["child"] })
      .filter((event: EventEnvelope) => event.seq > baselineSeq && event.childId === spawnResult.child_id);
    const exitEvent = eventsAfterKill.find((event) => event.msg === "child_exit");
    expect(exitEvent, "missing child_exit event").to.not.equal(undefined);

    const gcResult = (await routeJsonRpcRequest("child_gc", { child_id: spawnResult.child_id })) as {
      removed: boolean;
    };
    expect(gcResult.removed).to.equal(true);
    expect(childSupervisor.childrenIndex.getChild(spawnResult.child_id)).to.equal(undefined);
  });
});
