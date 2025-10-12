import { stat } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  type HttpCheckSnapshot,
  type HttpCheckArtefactTargets,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import { type JsonRpcCallSpec } from "./introspection.js";

/** Relative JSONL targets dedicated to the log stimulation workflow (playbook section 2). */
export const LOG_STIMULUS_JSONL_FILES = {
  inputs: "inputs/02_logging.jsonl",
  outputs: "outputs/02_logging.jsonl",
  log: "logs/log_stimulus_http.json",
} as const;

/** Internal artefact routing helper reused across the module. */
const LOG_STIMULUS_TARGETS: HttpCheckArtefactTargets = {
  inputs: LOG_STIMULUS_JSONL_FILES.inputs,
  outputs: LOG_STIMULUS_JSONL_FILES.outputs,
};

/** Default absolute path of the MCP runtime HTTP log. */
const DEFAULT_HTTP_LOG_PATH = "/tmp/mcp_http.log";

/**
 * Captures the state of the MCP HTTP log before and after invoking the
 * stimulation request.  The helper primarily tracks file size and modification
 * time to verify that the runtime produced fresh log entries.
 */
export interface HttpLogFileSnapshot {
  /** Whether the file existed at the time of the observation. */
  exists: boolean;
  /** File size in bytes (zero when the file is missing). */
  size: number;
  /** POSIX timestamp (milliseconds) of the last modification. */
  mtimeMs: number;
}

/** Result returned by {@link stimulateHttpLogging}. */
export interface LogStimulusIterationOutcome {
  /** 1-based position of the iteration. */
  index: number;
  /** Logical name associated with the HTTP check (suffix added for uniqueness). */
  name: string;
  /** Detailed HTTP artefacts captured for the iteration. */
  check: HttpCheckSnapshot;
}

export interface LogStimulusResult {
  /** JSON-RPC call executed to trigger log traffic (without iteration suffix). */
  call: JsonRpcCallSpec;
  /** Detailed HTTP artefacts captured during the final iteration (legacy field). */
  check: HttpCheckSnapshot;
  /** Aggregated outcomes for every executed iteration. */
  iterations: LogStimulusIterationOutcome[];
  /** File snapshot gathered immediately before the call sequence. */
  logBefore: HttpLogFileSnapshot;
  /** File snapshot gathered immediately after the call sequence. */
  logAfter: HttpLogFileSnapshot;
  /** Absolute path inspected on disk. */
  logPath: string;
  /** Total delta in bytes observed between both snapshots. */
  logDeltaBytes: number;
  /** Convenience flag exposing whether the log changed between snapshots. */
  logChanged: boolean;
}

/** Configuration accepted by {@link stimulateHttpLogging}. */
export interface LogStimulusOptions {
  /** Optional JSON-RPC call override (defaults to a `tools/call` echo request). */
  call?: JsonRpcCallSpec;
  /** Location of the HTTP log file written by the MCP runtime. */
  logPath?: string;
  /** Number of times the request should be repeated (defaults to a single probe). */
  iterations?: number;
}

/**
 * Generates the default JSON-RPC call used to stimulate HTTP logs.  The
 * payload intentionally targets the lightweight `tools/call` echo tool so the
 * workflow remains safe to execute repeatedly without altering persistent
 * server state.
 */
function buildDefaultStimulusCall(): JsonRpcCallSpec {
  return {
    name: "log_stimulus_echo",
    method: "tools/call",
    params: {
      name: "echo",
      arguments: { text: "log stimulus probe" },
    },
  };
}

/**
 * Collects basic metadata about a file. Missing files are tolerated – the
 * helper returns a snapshot flagging `exists: false` rather than throwing,
 * making it convenient to detect first-time log creation.
 */
async function captureFileSnapshot(path: string): Promise<HttpLogFileSnapshot> {
  try {
    const stats = await stat(path);
    return { exists: true, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      return { exists: false, size: 0, mtimeMs: 0 };
    }
    throw error;
  }
}

/**
 * Executes a JSON-RPC call designed to stimulate the MCP HTTP log and records
 * all artefacts under the validation run directory.
 *
 * The helper captures a file snapshot before and after the request to determine
 * whether the log effectively changed. Operators can inspect the boolean flag
 * to quickly verify the runtime is emitting new entries. All HTTP artefacts are
 * persisted as JSONL (requests/responses) alongside a structured log for audit
 * purposes.
 */
export async function stimulateHttpLogging(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: LogStimulusOptions = {},
): Promise<LogStimulusResult> {
  if (!runRoot) {
    throw new Error("stimulateHttpLogging requires a run root directory");
  }

  if (!environment || !environment.baseUrl) {
    throw new Error("stimulateHttpLogging requires a valid HTTP environment");
  }

  const call = options.call ?? buildDefaultStimulusCall();
  const logPath = options.logPath ?? DEFAULT_HTTP_LOG_PATH;
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));

  const logBefore = await captureFileSnapshot(logPath);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const iterationOutcomes: LogStimulusIterationOutcome[] = [];

  for (let iterationIndex = 0; iterationIndex < iterations; iterationIndex += 1) {
    const requestBody: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: `log_stimulus_${Date.now()}_${iterationIndex + 1}`,
      method: call.method,
    };

    if (call.params !== undefined) {
      requestBody.params = call.params;
    }

    const iterationName = iterations === 1 ? call.name : `${call.name}_${String(iterationIndex + 1).padStart(2, "0")}`;
    const check = await performHttpCheck(iterationName, {
      method: "POST",
      url: environment.baseUrl,
      headers,
      body: requestBody,
    });

    await appendHttpCheckArtefactsToFiles(runRoot, LOG_STIMULUS_TARGETS, check, LOG_STIMULUS_JSONL_FILES.log);

    iterationOutcomes.push({ index: iterationIndex + 1, name: iterationName, check });
  }

  const logAfter = await captureFileSnapshot(logPath);
  const logChanged =
    logAfter.exists &&
    (!logBefore.exists || logBefore.size !== logAfter.size || logBefore.mtimeMs !== logAfter.mtimeMs);

  const logDeltaBytes = logAfter.size - logBefore.size;

  const finalCheck = iterationOutcomes[iterationOutcomes.length - 1]?.check ?? iterationOutcomes[0]?.check;
  if (!finalCheck) {
    throw new Error("stimulateHttpLogging executed zero iterations unexpectedly");
  }

  return {
    call,
    check: finalCheck,
    iterations: iterationOutcomes,
    logBefore,
    logAfter,
    logPath,
    logDeltaBytes,
    logChanged,
  };
}

/**
 * Convenience helper returning the absolute path to the JSON file that records
 * the raw HTTP snapshots for the log stimulation workflow.
 */
export function resolveLogStimulusHttpLogPath(runRoot: string): string {
  return join(runRoot, LOG_STIMULUS_JSONL_FILES.log);
}
