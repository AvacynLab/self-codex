import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "mocha";
import { expect } from "chai";

import {
  isFsBridgeWatcherRunning,
  startFsBridgeWatcher,
  stopFsBridgeWatcher,
} from "../../src/bridge/fsBridge.js";
import { configureRuntimeFeatures, getRuntimeFeatures } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/** Home directory fallback mirroring the bridge defaults. */
const HOME = process.env.HOME ?? process.cwd();
/** Root IPC directory used by the file-system bridge. */
const IPC_DIR = process.env.MCP_FS_IPC_DIR ?? join(HOME, ".codex", "ipc");
const REQ_DIR = join(IPC_DIR, "requests");
const RES_DIR = join(IPC_DIR, "responses");
const ERR_DIR = join(IPC_DIR, "errors");

async function clearDir(directory: string): Promise<void> {
  try {
    const entries = await fs.readdir(directory);
    await Promise.all(entries.map((entry) => fs.unlink(join(directory, entry)).catch(() => {})));
  } catch {
    // Ignore missing directories as the bridge lazily creates them.
  }
}

describe("fs bridge", () => {
  let originalFeatures: FeatureToggles;

  before(async () => {
    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({ ...originalFeatures, enableMcpIntrospection: true });
    const toggles = getRuntimeFeatures();
    expect(toggles.enableMcpIntrospection).to.equal(true);
    await clearDir(REQ_DIR);
    await clearDir(RES_DIR);
    await clearDir(ERR_DIR);
    await startFsBridgeWatcher();
    const featuresAfterStart = getRuntimeFeatures();
    expect(featuresAfterStart.enableMcpIntrospection).to.equal(true);
    expect(isFsBridgeWatcherRunning()).to.equal(true);
  });

  after(async () => {
    await stopFsBridgeWatcher();
    await clearDir(REQ_DIR);
    await clearDir(RES_DIR);
    await clearDir(ERR_DIR);
    configureRuntimeFeatures(originalFeatures);
  });

  it("processes mcp_info requests written on disk", async () => {
    await fs.mkdir(REQ_DIR, { recursive: true });
    await fs.mkdir(RES_DIR, { recursive: true });

    const requestId = randomUUID();
    const requestFile = join(REQ_DIR, `req-${requestId}.json`);
    const payload = { jsonrpc: "2.0" as const, id: requestId, method: "mcp_info", params: {} };
    await fs.writeFile(requestFile, JSON.stringify(payload), "utf8");

    const deadline = Date.now() + 5_000;
    let response: unknown;

    while (Date.now() < deadline) {
      const produced = await fs.readdir(RES_DIR).catch(() => [] as string[]);
      const match = produced.find((entry) => entry.startsWith(`req-${requestId}.`));
      if (match) {
        const raw = await fs.readFile(join(RES_DIR, match), "utf8");
        response = JSON.parse(raw);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(response, "JSON-RPC response").to.be.an("object");
    const typed = response as {
      result?: { server?: { name?: string } } & { error?: string; tool?: string };
    };
    if (typed.result?.server?.name) {
      expect(typed.result.server.name).to.be.a("string");
    } else {
      expect(typed.result).to.include({ error: "MCP_INTROSPECTION_DISABLED", tool: "mcp_info" });
    }

    const errorEntries = await fs.readdir(ERR_DIR).catch(() => [] as string[]);
    expect(errorEntries, "bridge error directory").to.be.empty;
  }).timeout(10_000);
});

