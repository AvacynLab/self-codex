import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { runtimeTimers, type IntervalHandle } from "../runtime/timers.js";
import { pathToFileURL } from "node:url";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { handleJsonRpc, type JsonRpcRequest, type JsonRpcResponse } from "../server.js";
import { StructuredLogger } from "../logger.js";

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

/**
 * Subset of the Node.js `fs/promises` module leveraged by the bridge. Allowing
 * tests to override the implementation keeps the watcher deterministic and
 * enables failure injection without patching globals.
 */
export type FsBridgeFileSystem = Pick<
  typeof nodeFs,
  "mkdir" | "readdir" | "readFile" | "writeFile" | "unlink"
>;

/** Default polling cadence for the watcher in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 200;

/** Active structured logger used to emit telemetry about bridge activity. */
let bridgeLogger: StructuredLogger = new StructuredLogger();
/** Current filesystem facade leveraged by the bridge implementation. */
let fileSystem: FsBridgeFileSystem = nodeFs;
/** Interval identifier used by the polling loop (null when stopped). */
let pollTimer: IntervalHandle | null = null;
/** Guards against overlapping scans so request processing stays sequential. */
let scanInFlight = false;

/**
 * Serialises unknown error objects into a shape safe for structured logging.
 * The helper preserves the most relevant properties (name/message/stack)
 * without leaking class instances or circular references.
 */
function serialiseError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  const message = typeof error === "string" ? error : JSON.stringify(error);
  return { name: "Error", message };
}

/**
 * Options accepted by {@link startFsBridgeWatcher} to customise the runtime
 * behaviour in a test-friendly manner.
 */
export interface FsBridgeWatcherOptions {
  /** Optional structured logger receiving lifecycle and failure events. */
  readonly logger?: StructuredLogger;
  /** Optional filesystem implementation used instead of Node's primitives. */
  readonly fileSystem?: FsBridgeFileSystem;
  /** Polling cadence override in milliseconds. */
  readonly pollIntervalMs?: number;
}

/**
 * Updates the logger used by the bridge. When `null` or `undefined` is
 * provided, the helper reinstates a fresh logger instance so subsequent calls
 * continue to emit structured telemetry.
 */
export function configureFsBridgeLogger(logger: StructuredLogger | null | undefined): void {
  bridgeLogger = logger ?? new StructuredLogger();
}

/** Ensures the IPC directory hierarchy exists before processing requests. */
async function ensureDirs(): Promise<void> {
  for (const directory of [IPC_DIR, REQ_DIR, RES_DIR, ERR_DIR]) {
    await fileSystem.mkdir(directory, { recursive: true });
  }
}

/** Writes a JSON payload to the error channel while tolerating secondary failures. */
async function writeErrorFile(baseName: string, error: unknown): Promise<void> {
  const outName = baseName.replace(/\.json$/, "") + `.${randomUUID()}.json`;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await fileSystem.writeFile(join(ERR_DIR, outName), JSON.stringify({ ok: false, error: message }), "utf8");
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
    payload = JSON.parse(await fileSystem.readFile(filePath, "utf8")) as JsonRpcRequest;
  } catch (error) {
    await writeErrorFile(fileName, error);
    await fileSystem.unlink(filePath).catch(() => {});
    return;
  }

  let response: JsonRpcResponse;
  try {
    // Delegate to the in-process JSON-RPC adapter while flagging the transport
    // so downstream handlers emit telemetry aligned with the FS bridge.
    response = await handleJsonRpc(payload, { transport: "fs" });
  } catch (error) {
    await writeErrorFile(fileName, error);
    await fileSystem.unlink(filePath).catch(() => {});
    return;
  }

  const targetDir = response.error ? ERR_DIR : RES_DIR;
  const outName = fileName.replace(/\.json$/, "") + `.${randomUUID()}.json`;

  try {
    await fileSystem.writeFile(join(targetDir, outName), JSON.stringify(response), "utf8");
  } catch (error) {
    // Fallback to an error artefact so upstream callers still observe a
    // terminal state even if the preferred channel was unavailable.
    await writeErrorFile(fileName, error);
  } finally {
    await fileSystem.unlink(filePath).catch(() => {});
  }
}

/** Executes a single scan of the request directory. */
async function scanOnce(): Promise<void> {
  const entries = await fileSystem.readdir(REQ_DIR);
  const requests = entries.filter((entry: string) => entry.endsWith(".json") && !entry.endsWith(".json.part"));
  for (const request of requests) {
    await processReqFile(request);
  }
}

/** Starts the polling loop used by the FS bridge (idempotent). */
export async function startFsBridgeWatcher(options?: FsBridgeWatcherOptions): Promise<void> {
  if (pollTimer) {
    if (options?.logger) {
      bridgeLogger = options.logger;
    }
    return;
  }

  if (options?.logger) {
    bridgeLogger = options.logger;
  }
  fileSystem = options?.fileSystem ?? nodeFs;
  const pollInterval = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  await ensureDirs();
  try {
    await scanOnce();
  } catch (error) {
    bridgeLogger.error("fs_bridge_initial_scan_failed", {
      error: serialiseError(error),
    });
    throw error;
  }

  bridgeLogger.info("fs_bridge_watcher_started", {
    ipc_directory: IPC_DIR,
    poll_interval_ms: pollInterval,
  });

  pollTimer = runtimeTimers.setInterval(async () => {
    if (scanInFlight) {
      return;
    }
    scanInFlight = true;
    try {
      await scanOnce();
    } catch (error) {
      bridgeLogger.error("fs_bridge_scan_failed", {
        error: serialiseError(error),
      });
    } finally {
      scanInFlight = false;
    }
  }, pollInterval);
}

/** Stops the polling loop so tests can tear down the bridge deterministically. */
export async function stopFsBridgeWatcher(): Promise<void> {
  if (pollTimer) {
    runtimeTimers.clearInterval(pollTimer);
    pollTimer = null;
    bridgeLogger.info("fs_bridge_watcher_stopped", {
      ipc_directory: IPC_DIR,
    });
  }
  scanInFlight = false;
  fileSystem = nodeFs;
}

/** Utility primarily used by tests to assert whether the watcher is active. */
export function isFsBridgeWatcherRunning(): boolean {
  return pollTimer !== null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startFsBridgeWatcher().catch((error) => {
    bridgeLogger.error("fs_bridge_start_failed", {
      error: serialiseError(error),
    });
    process.exit(1);
  });
}

