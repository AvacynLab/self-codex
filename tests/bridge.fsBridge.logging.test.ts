import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  configureFsBridgeLogger,
  startFsBridgeWatcher,
  stopFsBridgeWatcher,
  type FsBridgeFileSystem,
} from "../src/bridge/fsBridge.js";
import { StructuredLogger, type LogEntry } from "../src/logger.js";

/** Home directory fallback mirroring the bridge defaults. */
const HOME = process.env.HOME ?? process.cwd();
/** Root IPC directory used by the file-system bridge. */
const IPC_DIR = process.env.MCP_FS_IPC_DIR ?? join(HOME, ".codex", "ipc");
const REQ_DIR = join(IPC_DIR, "requests");
const RES_DIR = join(IPC_DIR, "responses");
const ERR_DIR = join(IPC_DIR, "errors");

/** Clears a directory by deleting all entries if it exists. */
async function clearDir(directory: string): Promise<void> {
  try {
    const entries = await fs.readdir(directory);
    await Promise.all(entries.map((entry) => fs.unlink(join(directory, entry)).catch(() => {})));
  } catch {
    // Ignore missing directories as the bridge lazily recreates them when needed.
  }
}

/** Builds a filesystem facade that injects a single failure on the watcher loop. */
function createFailingFileSystem(realFs: FsBridgeFileSystem): FsBridgeFileSystem {
  let callIndex = 0;
  return {
    mkdir: (...args) => realFs.mkdir(...args),
    writeFile: (...args) => realFs.writeFile(...args),
    unlink: (...args) => realFs.unlink(...args),
    readFile: (...args) => realFs.readFile(...args),
    async readdir(...args) {
      callIndex += 1;
      if (callIndex === 2) {
        throw new Error("fs_bridge_scan_failure_injected");
      }
      return realFs.readdir(...args);
    },
  };
}

describe("fs bridge logging", () => {
  const entries: LogEntry[] = [];

  beforeEach(async () => {
    entries.length = 0;
    await clearDir(REQ_DIR);
    await clearDir(RES_DIR);
    await clearDir(ERR_DIR);
  });

  afterEach(async () => {
    await stopFsBridgeWatcher();
    configureFsBridgeLogger(null);
    await clearDir(REQ_DIR);
    await clearDir(RES_DIR);
    await clearDir(ERR_DIR);
  });

  it("emits structured lifecycle events when the watcher starts and stops", async () => {
    const logger = new StructuredLogger({
      onEntry: (entry) => entries.push(entry),
    });

    await startFsBridgeWatcher({ logger, pollIntervalMs: 25 });
    expect(entries.map((entry) => entry.message)).to.include("fs_bridge_watcher_started");

    await stopFsBridgeWatcher();
    expect(entries.map((entry) => entry.message)).to.include("fs_bridge_watcher_stopped");
  });

  it("records structured error telemetry when directory scans fail", async () => {
    const logger = new StructuredLogger({
      onEntry: (entry) => entries.push(entry),
    });

    const failingFs = createFailingFileSystem({
      mkdir: (...args) => fs.mkdir(...args),
      writeFile: (...args) => fs.writeFile(...args),
      unlink: (...args) => fs.unlink(...args),
      readFile: (...args) => fs.readFile(...args),
      readdir: (...args) => fs.readdir(...args),
    });

    await startFsBridgeWatcher({ logger, pollIntervalMs: 20, fileSystem: failingFs });

    // Allow the polling loop to trigger the injected failure.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const errorEntries = entries.filter((entry) => entry.message === "fs_bridge_scan_failed");
    expect(errorEntries, "scan failure log entries").to.have.lengthOf.at.least(1);
    const payload = errorEntries[0].payload as Record<string, unknown>;
    expect(payload).to.have.property("error");
    const errorDetails = payload.error as Record<string, unknown>;
    expect(errorDetails).to.include({
      name: "Error",
      message: "fs_bridge_scan_failure_injected",
    });
  });
});

