#!/usr/bin/env node
import process from "process";

import {
  executeLogStimulusCli,
  parseLogStimulusCliOptions,
} from "../src/validation/logStimulusCli.js";

/**
 * CLI entrypoint that triggers a lightweight JSON-RPC request designed to force
 * MCP HTTP log writes. The heavy lifting is delegated to the reusable
 * `executeLogStimulusCli` helper so both tests and manual operators benefit
 * from consistent orchestration and logging.
 */
async function main(): Promise<void> {
  const options = parseLogStimulusCliOptions(process.argv.slice(2));
  await executeLogStimulusCli(options, process.env, console);
}

main().catch((error) => {
  console.error("Failed to stimulate HTTP logging:", error);
  process.exitCode = 1;
});
