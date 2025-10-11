#!/usr/bin/env node
import process from "process";
import { join } from "path";

import { captureHttpLog } from "../src/validation/logs.js";

interface CliOptions {
  /** Optional identifier of the validation run (e.g. `validation_2025-10-10T16-03-31Z`). */
  runId?: string;
  /** Base directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Direct path to an existing run root. Overrides `runId`/`baseDir` when provided. */
  runRoot?: string;
  /** Path to the source HTTP log file. */
  sourcePath: string;
}

/**
 * Parses command-line arguments without relying on external dependencies.  The
 * helper intentionally accepts both `--run-root` and `--run-id` so operators can
 * either point to an explicit directory or reuse the standard `runs/` layout.
 */
function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { baseDir: "runs", sourcePath: "/tmp/mcp_http.log" };

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
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  const runRoot = options.runRoot ?? (options.runId ? join(options.baseDir, options.runId) : undefined);
  if (!runRoot) {
    throw new Error("Please provide either --run-root or --run-id to locate the validation run directory.");
  }

  const { logPath, summaryPath, summary } = await captureHttpLog(runRoot, {
    sourcePath: options.sourcePath,
  });

  console.log(`📁 Log copied to: ${logPath}`);
  console.log(`📄 Summary written to: ${summaryPath}`);
  console.log(`   → Lines: ${summary.totalLines}, errors: ${summary.errorLines}, warns: ${summary.warnLines}`);
  if (summary.latency.samples > 0) {
    console.log(
      `   → Latency p95: ${summary.latency.p95?.toFixed(2)} ms (from ${summary.latency.samples} samples, fields: ${summary.latency.fields.join(
        ", ",
      )})`,
    );
  } else {
    console.log("   → Latency metrics unavailable (no structured samples detected).");
  }
}

main().catch((error) => {
  console.error("Failed to capture HTTP log:", error);
  process.exitCode = 1;
});
