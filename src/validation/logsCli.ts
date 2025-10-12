import { basename, dirname } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { captureHttpLog, type CaptureHttpLogOptions, type HttpLogSummary } from "./logs.js";
import { ensureRunStructure, generateValidationRunId } from "./runSetup.js";

/**
 * CLI flags recognised by the HTTP log capture workflow.
 */
export interface LogCaptureCliOptions {
  /** Optional identifier of the validation run (e.g. `validation_2025-10-11`). */
  runId?: string;
  /** Base directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Absolute or relative path to an existing run root. */
  runRoot?: string;
  /** Location of the MCP HTTP log (defaults to `/tmp/mcp_http.log`). */
  sourcePath?: string;
  /** File name written under `logs/` within the run directory. */
  targetFileName?: string;
  /** File name used for the structured summary. */
  summaryFileName?: string;
}

/** Minimal logger abstraction so tests can capture human-readable output. */
export interface LogCaptureCliLogger {
  log: (...args: unknown[]) => void;
}

/**
 * Parses command-line arguments accepted by the log capture CLI. Unknown flags
 * are intentionally ignored to keep the interface forgiving when used manually.
 */
export function parseLogCaptureCliOptions(argv: readonly string[]): LogCaptureCliOptions {
  const options: LogCaptureCliOptions = { baseDir: "runs" };

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
    } else if (token === "--source" && index + 1 < argv.length) {
      options.sourcePath = argv[index + 1];
      index += 1;
    } else if (token === "--target" && index + 1 < argv.length) {
      options.targetFileName = argv[index + 1];
      index += 1;
    } else if (token === "--summary" && index + 1 < argv.length) {
      options.summaryFileName = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeLogCaptureCli}. */
export interface LogCaptureCliResult {
  /** Absolute path to the run directory used for persistence. */
  runRoot: string;
  /** Location of the copied log file. */
  logPath: string;
  /** Location of the generated summary. */
  summaryPath: string;
  /** Structured summary content. */
  summary: HttpLogSummary;
}

/**
 * Executes the log capture workflow end-to-end: ensure the run directory exists
 * and persist the copied log plus the structured summary in the expected
 * locations.
 */
export async function executeLogCaptureCli(
  options: LogCaptureCliOptions,
  logger: LogCaptureCliLogger,
): Promise<LogCaptureCliResult> {
  const sourcePath = options.sourcePath ?? "/tmp/mcp_http.log";
  const targetFileName = options.targetFileName;
  const summaryFileName = options.summaryFileName;

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

  logger.log(`→ Capturing HTTP log for run: ${runId} (${runRoot})`);
  logger.log(`   Source file: ${sourcePath}`);

  const captureOptions: CaptureHttpLogOptions = {};
  if (sourcePath) {
    captureOptions.sourcePath = sourcePath;
  }
  if (targetFileName) {
    captureOptions.targetFileName = targetFileName;
  }
  if (summaryFileName) {
    captureOptions.summaryFileName = summaryFileName;
  }

  const { logPath, summaryPath, summary } = await captureHttpLog(runRoot, captureOptions);

  logger.log(`   Copied log path: ${logPath}`);
  logger.log(`   Summary path: ${summaryPath}`);
  logger.log(
    `   Lines: ${summary.totalLines}, errors: ${summary.errorLines}, warns: ${summary.warnLines}, size: ${summary.fileSizeBytes} bytes`,
  );
  if (summary.topMessages.length) {
    logger.log("   Top messages:");
    summary.topMessages.forEach((entry, index) => {
      logger.log(`     ${index + 1}. [${entry.count}] ${entry.text}`);
    });
  } else {
    logger.log("   Top messages: none detected.");
  }

  return { runRoot, logPath, summaryPath, summary };
}
