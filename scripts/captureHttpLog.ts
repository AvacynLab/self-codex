#!/usr/bin/env node
import process from "node:process";

import { executeLogCaptureCli, parseLogCaptureCliOptions } from "../src/validation/logsCli.js";

/**
 * CLI entrypoint orchestrating the log capture workflow.  The heavy lifting is
 * delegated to the reusable helpers in `src/validation/logsCli.ts` so both
 * manual operators and unit tests leverage the same behaviour and logging.
 */
async function main(): Promise<void> {
  const options = parseLogCaptureCliOptions(process.argv.slice(2));
  await executeLogCaptureCli(options, console);
}

main().catch((error) => {
  console.error("Failed to capture HTTP log:", error);
  process.exitCode = 1;
});
