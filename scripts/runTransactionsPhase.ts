#!/usr/bin/env node
import process from "process";
import { join } from "path";

import {
  executeTransactionsCli,
  parseTransactionsCliOptions,
} from "../src/validation/transactionsCli.js";
import { TRANSACTIONS_JSONL_FILES } from "../src/validation/transactions.js";

/**
 * CLI entrypoint orchestrating the Stage 3 (transactions & graphs) validation
 * workflow. The script wires the lightweight option parser to the reusable
 * executor so operators benefit from consistent logging across stages.
 */
async function main(): Promise<void> {
  const options = parseTransactionsCliOptions(process.argv.slice(2));

  const { runRoot, outcomes } = await executeTransactionsCli(options, process.env, console);

  console.log("🧭 Transactions phase summary:");
  for (const outcome of outcomes) {
    const status = outcome.check.response.status;
    const duration = outcome.check.durationMs.toFixed(1);
    const eventCount = outcome.events.length;
    console.log(
      `   • ${outcome.call.name} [${outcome.call.scenario}] → HTTP ${status} (duration ${duration} ms, events ${eventCount})`,
    );
  }

  console.log(`🧾 Requests log: ${join(runRoot, TRANSACTIONS_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, TRANSACTIONS_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, TRANSACTIONS_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, TRANSACTIONS_JSONL_FILES.log)}`);
}

main().catch((error) => {
  console.error("Failed to execute transactions phase:", error);
  process.exitCode = 1;
});
