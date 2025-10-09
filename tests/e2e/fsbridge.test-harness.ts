import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

type FsBridgeModule = typeof import("../../src/bridge/fsBridge.js");

const HOME = process.env.HOME ?? process.cwd();
const BASE_DIR = process.env.MCP_FS_IPC_DIR ?? join(HOME, ".codex", "ipc");

/**
 * Structure exposing the reusable directories and bridge module leveraged by
 * the FS bridge end-to-end tests. Each invocation prepares an isolated
 * directory tree so tests can write request/response artefacts without
 * interfering with each other.
 */
export interface FsBridgeHarness {
  /** Root directory hosting the IPC hierarchy for the current run. */
  baseDir: string;
  /** Directory where JSON-RPC requests must be dropped. */
  requestsDir: string;
  /** Directory inspected by tests to observe successful responses. */
  responsesDir: string;
  /** Directory inspected by tests to observe JSON-RPC errors. */
  errorsDir: string;
  /** Actual bridge module so callers can start/stop the watcher. */
  bridge: FsBridgeModule;
}

let sharedModule: FsBridgeModule | null = null;
/**
 * Ensures a dedicated IPC tree exists and returns the directories consumed by
 * FS bridge tests. The helper is idempotent across suites so each test can call
 * it from its own hooks without re-importing the bridge implementation.
 */
export async function createFsBridgeHarness(): Promise<FsBridgeHarness> {
  if (!sharedModule) {
    sharedModule = await import("../../src/bridge/fsBridge.js");
  }

  await sharedModule.stopFsBridgeWatcher().catch(() => undefined);
  await rm(BASE_DIR, { recursive: true, force: true });

  const requestsDir = join(BASE_DIR, "requests");
  const responsesDir = join(BASE_DIR, "responses");
  const errorsDir = join(BASE_DIR, "errors");
  await mkdir(requestsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });
  await mkdir(errorsDir, { recursive: true });

  return {
    baseDir: BASE_DIR,
    requestsDir,
    responsesDir,
    errorsDir,
    bridge: sharedModule,
  };
}

/**
 * Waits until a JSON artefact appears in the provided directory. Tests rely on
 * the helper to synchronise with the asynchronous polling loop implemented by
 * the FS bridge.
 */
export async function waitForJsonFile(directory: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const entries = await readdir(directory);
    const candidate = entries.find((entry) => entry.endsWith(".json"));
    if (candidate) {
      return join(directory, candidate);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for JSON artefact in ${directory}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Removes the shared IPC hierarchy and clears the environment variable so the
 * rest of the test suite is not affected by the FS bridge setup.
 */
export async function disposeFsBridgeHarness(): Promise<void> {
  if (sharedModule) {
    await sharedModule.stopFsBridgeWatcher().catch(() => undefined);
  }
  await rm(BASE_DIR, { recursive: true, force: true });
}
