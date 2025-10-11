import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
} from "./runSetup.js";
import {
  LOG_STIMULUS_JSONL_FILES,
  stimulateHttpLogging,
  type LogStimulusOptions,
  type LogStimulusResult,
} from "./logStimulus.js";
import { type JsonRpcCallSpec } from "./introspection.js";

/**
 * CLI options recognised by the log stimulation workflow.
 *
 * The flags mirror the conventions used by the other validation helpers so
 * operators can easily chain commands within the same run directory.
 */
export interface LogStimulusCliOptions {
  /** Optional identifier of the validation run (e.g. `validation_2025-10-10`). */
  runId?: string;
  /** Base directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Explicit absolute or relative path to the run root. */
  runRoot?: string;
  /** Optional override of the MCP HTTP log path. */
  logPath?: string;
  /** Friendly name used when persisting the HTTP snapshot. */
  callName?: string;
  /** JSON-RPC method to invoke (defaults to `tools/call`). */
  method?: string;
  /**
   * JSON string describing the params payload. When omitted the CLI generates a
   * safe default targeting the `echo` tool.
   */
  paramsJson?: string;
  /** Convenience flag configuring the `name` field of the default `tools/call`. */
  toolName?: string;
  /** Optional text forwarded to the default echo call. */
  toolText?: string;
}

/** Minimal logger abstraction so tests can capture human-readable output. */
export interface LogStimulusCliLogger {
  log: (...args: unknown[]) => void;
}

/**
 * Parses the CLI arguments accepted by the log stimulation script.
 *
 * Unknown flags are ignored intentionally to keep the interface forgiving
 * during manual operations.
 */
export function parseLogStimulusCliOptions(argv: readonly string[]): LogStimulusCliOptions {
  const options: LogStimulusCliOptions = { baseDir: "runs" };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-id" && index + 1 < argv.length) {
      options.runId = argv[index + 1];
      index += 1;
    } else if (token === "--base-dir" && index + 1 < argv.length) {
      options.baseDir = argv[index + 1];
      index += 1;
    } else if (token === "--run-root" && index + 1 < argv.length) {
      options.runRoot = argv[index + 1];
      index += 1;
    } else if (token === "--log-path" && index + 1 < argv.length) {
      options.logPath = argv[index + 1];
      index += 1;
    } else if (token === "--call-name" && index + 1 < argv.length) {
      options.callName = argv[index + 1];
      index += 1;
    } else if (token === "--method" && index + 1 < argv.length) {
      options.method = argv[index + 1];
      index += 1;
    } else if (token === "--params" && index + 1 < argv.length) {
      options.paramsJson = argv[index + 1];
      index += 1;
    } else if (token === "--tool" && index + 1 < argv.length) {
      options.toolName = argv[index + 1];
      index += 1;
    } else if (token === "--text" && index + 1 < argv.length) {
      options.toolText = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Aggregated result returned by {@link executeLogStimulusCli}. */
export interface LogStimulusCliResult {
  /** Absolute path to the validation run directory used for persistence. */
  runRoot: string;
  /** Outcome emitted by {@link stimulateHttpLogging}. */
  result: LogStimulusResult;
}

/**
 * Builds the JSON-RPC call specification based on CLI flags.
 */
function buildCallSpec(options: LogStimulusCliOptions): JsonRpcCallSpec {
  if (options.paramsJson) {
    let parsedParams: unknown;
    try {
      parsedParams = JSON.parse(options.paramsJson);
    } catch (error) {
      throw new Error(`Failed to parse --params JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      name: options.callName ?? "log_stimulus_custom",
      method: options.method ?? "tools/call",
      params: parsedParams,
    };
  }

  const toolName = options.toolName ?? "echo";
  const toolText = options.toolText ?? "log stimulus probe";

  return {
    name: options.callName ?? `log_stimulus_${toolName}`,
    method: options.method ?? "tools/call",
    params: {
      name: toolName,
      arguments: { text: toolText },
    },
  };
}

/**
 * Executes the log stimulation workflow end-to-end using CLI semantics.
 */
export async function executeLogStimulusCli(
  options: LogStimulusCliOptions,
  env: NodeJS.ProcessEnv,
  logger: LogStimulusCliLogger,
): Promise<LogStimulusCliResult> {
  const environment = collectHttpEnvironment(env);
  const logPath = options.logPath;

  let runRoot: string;
  let runId: string;

  if (options.runRoot) {
    const baseDir = dirname(options.runRoot);
    runId = basename(options.runRoot);
    runRoot = await ensureRunStructure(baseDir, runId);
  } else {
    runId = options.runId ?? generateValidationRunId();
    runRoot = await ensureRunStructure(options.baseDir, runId);
  }

  logger.log(`→ Log stimulus run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);
  if (logPath) {
    logger.log(`   Inspecting log file: ${logPath}`);
  }

  const call = buildCallSpec(options);
  const stimulusOptions: LogStimulusOptions = {};
  if (logPath) {
    stimulusOptions.logPath = logPath;
  }
  stimulusOptions.call = call;

  const result = await stimulateHttpLogging(runRoot, environment, stimulusOptions);

  logger.log(`   HTTP status: ${result.check.response.status}`);
  logger.log(
    `   Log changed: ${result.logChanged ? "yes" : "no"} (before size ${result.logBefore.size} → after ${result.logAfter.size})`,
  );
  logger.log(`   Requests JSONL: ${join(runRoot, LOG_STIMULUS_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, LOG_STIMULUS_JSONL_FILES.outputs)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, LOG_STIMULUS_JSONL_FILES.log)}`);

  return { runRoot, result };
}
