#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import { executeRobustnessCli, parseRobustnessCliOptions } from "../src/validation/robustnessCli.js";
import { ROBUSTNESS_JSONL_FILES } from "../src/validation/robustness.js";

/**
 * CLI entrypoint for the Stage 9 robustness validation workflow. The command
 * mirrors the ergonomics of earlier stages so operators can automate the
 * remaining checklist items with minimal context switching.
 */
async function main(): Promise<void> {
  const options = parseRobustnessCliOptions(process.argv.slice(2));

  const { runRoot, result } = await executeRobustnessCli(options, process.env, console);

  console.log("🛡️ Robustness validation summary:");
  console.log(
    `   • idempotency consistent: ${result.summary.idempotency?.consistent ?? false ? "yes" : "no"}`,
  );
  if (result.summary.idempotency?.idempotencyKey) {
    console.log(`   • idempotency key: ${result.summary.idempotency.idempotencyKey}`);
  }
  if (result.summary.crashSimulation) {
    console.log(`   • crash events captured: ${result.summary.crashSimulation.eventCount}`);
  }
  if (result.summary.timeout) {
    console.log(
      `   • timeout flagged: ${result.summary.timeout.timedOut ? "yes" : "no"}`,
    );
  }

  console.log(`📚 Requests log: ${join(runRoot, ROBUSTNESS_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, ROBUSTNESS_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, ROBUSTNESS_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, ROBUSTNESS_JSONL_FILES.log)}`);
  console.log(`📝 Summary: ${result.summaryPath}`);
}

main().catch((error) => {
  console.error("Failed to execute robustness validation workflow:", error);
  process.exitCode = 1;
});
