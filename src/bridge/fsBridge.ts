import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import process from "process";
import { runtimeTimers, type IntervalHandle } from "../runtime/timers.js";
import { pathToFileURL } from "url";

import { handleJsonRpc, type JsonRpcRequest, type JsonRpcResponse } from "../server.js";

/** Home directory used as a fallback when `MCP_FS_IPC_DIR` is not provided. */
const HOME = process.env.HOME ?? process.cwd();
/** Root directory hosting the file-system based IPC exchange. */
const IPC_DIR = process.env.MCP_FS_IPC_DIR ?? join(HOME, ".codex", "ipc");
/** Directory containing pending JSON-RPC requests. */
const REQ_DIR = join(IPC_DIR, "requests");
/** Directory receiving successful JSON-RPC responses. */
const RES_DIR = join(IPC_DIR, "responses");
/** Directory receiving error payloads when processing fails. */
const ERR_DIR = join(IPC_DIR, "errors");

/** Interval identifier used by the polling loop (null when stopped). */
let pollTimer: IntervalHandle | null = null;
/** Guards against overlapping scans so request processing stays sequential. */
let scanInFlight = false;

/** Ensures the IPC directory hierarchy exists before processing requests. */
async function ensureDirs(): Promise<void> {
  for (const directory of [IPC_DIR, REQ_DIR, RES_DIR, ERR_DIR]) {
    await fs.mkdir(directory, { recursive: true });
  }
}

/** Writes a JSON payload to the error channel while tolerating secondary failures. */
async function writeErrorFile(baseName: string, error: unknown): Promise<void> {
  const outName = baseName.replace(/\.json$/, "") + `.${randomUUID()}.json`;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await fs.writeFile(join(ERR_DIR, outName), JSON.stringify({ ok: false, error: message }), "utf8");
  } catch {
    // Suppress secondary failures to keep the bridge resilient even under I/O pressure.
  }
}

/**
 * Processes a single request file by delegating to {@link handleJsonRpc}. Upon
 * completion the original request is deleted and either a response or an error
 * payload is emitted in the appropriate directory.
 */
async function processReqFile(fileName: string): Promise<void> {
  const filePath = join(REQ_DIR, fileName);
  let payload: JsonRpcRequest;

  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRpcRequest;
  } catch (error) {
    await writeErrorFile(fileName, error);
    await fs.unlink(filePath).catch(() => {});
    return;
  }

  let response: JsonRpcResponse;
  try {
    // Delegate to the in-process JSON-RPC adapter while flagging the transport
    // so downstream handlers emit telemetry aligned with the FS bridge.
    response = await handleJsonRpc(payload, { transport: "fs" });
  } catch (error) {
    await writeErrorFile(fileName, error);
    await fs.unlink(filePath).catch(() => {});
    return;
  }

  const targetDir = response.error ? ERR_DIR : RES_DIR;
  const outName = fileName.replace(/\.json$/, "") + `.${randomUUID()}.json`;

  try {
    await fs.writeFile(join(targetDir, outName), JSON.stringify(response), "utf8");
  } catch (error) {
    // Fallback to an error artefact so upstream callers still observe a
    // terminal state even if the preferred channel was unavailable.
    await writeErrorFile(fileName, error);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

/** Executes a single scan of the request directory. */
async function scanOnce(): Promise<void> {
  const entries = await fs.readdir(REQ_DIR);
  const requests = entries.filter((entry: string) => entry.endsWith(".json") && !entry.endsWith(".json.part"));
  for (const request of requests) {
    await processReqFile(request);
  }
}

/** Starts the polling loop used by the FS bridge (idempotent). */
export async function startFsBridgeWatcher(): Promise<void> {
  if (pollTimer) {
    return;
  }

  await ensureDirs();
  await scanOnce();

  pollTimer = runtimeTimers.setInterval(async () => {
    if (scanInFlight) {
      return;
    }
    scanInFlight = true;
    try {
      await scanOnce();
    } catch (error) {
      // Logging via stderr keeps the bridge transparent while surfacing issues to operators.
      console.error("[fs-bridge] scan failed", error);
    } finally {
      scanInFlight = false;
    }
  }, 200);
}

/** Stops the polling loop so tests can tear down the bridge deterministically. */
export async function stopFsBridgeWatcher(): Promise<void> {
  if (pollTimer) {
    runtimeTimers.clearInterval(pollTimer);
    pollTimer = null;
  }
  scanInFlight = false;
}

/** Utility primarily used by tests to assert whether the watcher is active. */
export function isFsBridgeWatcherRunning(): boolean {
  return pollTimer !== null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startFsBridgeWatcher().catch((error) => {
    console.error("[fs-bridge] fatal", error);
    process.exit(1);
  });
}

