#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeTransactionsCli,
  parseTransactionsCliOptions,
} from "../src/validation/transactionsCli.js";
import { TRANSACTIONS_JSONL_FILES } from "../src/validation/transactions.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Builds the sanitised invocation payload for the Stage 3 transactions runner
 * to ensure optional CLI overrides and environment slots never surface as
 * `undefined` values downstream.
 */
export function prepareTransactionsCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseTransactionsCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

/**
 * CLI entrypoint orchestrating the Stage 3 (transactions & graphs) validation
 * workflow. The script wires the lightweight option parser to the reusable
 * executor so operators benefit from consistent logging across stages.
 */
async function main(): Promise<void> {
  const { options, env } = prepareTransactionsCliInvocation(
    process.argv.slice(2),
    process.env,
  );

  const { runRoot, outcomes } = await executeTransactionsCli(options, env, console);

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to execute transactions phase:", error);
    process.exitCode = 1;
  });
}
