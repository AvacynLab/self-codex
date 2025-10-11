#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import { executePlanCli, parsePlanCliOptions } from "../src/validation/plansCli.js";
import { PLAN_JSONL_FILES } from "../src/validation/plans.js";

/**
 * CLI entrypoint for the Stage 6 planning validation workflow. The script keeps
 * flag semantics aligned with previous stages so operators can chain executions
 * without memorising new conventions.
 */
async function main(): Promise<void> {
  const options = parsePlanCliOptions(process.argv.slice(2));

  const { runRoot, result } = await executePlanCli(options, process.env, console);

  console.log("🧭 Planning validation summary:");
  console.log(`   • graph id: ${result.summary.graphId ?? "unknown"}`);
  console.log(`   • compile success: ${result.summary.compile.success}`);
  console.log(
    `   • plan_run_bt status: ${result.summary.runBt.status ?? "unknown"} (ticks=${
      result.summary.runBt.ticks ?? "n/a"
    })`,
  );
  console.log(
    `   • plan_run_reactive status: ${result.summary.runReactive.status ?? "unknown"} (loop_ticks=${
      result.summary.runReactive.loopTicks ?? "n/a"
    })`,
  );
  if (result.summary.runReactive.cancelled) {
    console.log(
      `   • cancellation observed (error=${result.summary.runReactive.cancellationError ?? "n/a"})`,
    );
  }
  if (result.summary.lifecycle.statusSnapshot) {
    console.log(
      `   • lifecycle state: ${JSON.stringify(result.summary.lifecycle.statusSnapshot)}`,
    );
  }

  console.log(`🧾 Requests log: ${join(runRoot, PLAN_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, PLAN_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, PLAN_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, PLAN_JSONL_FILES.log)}`);
  console.log(`📝 Summary: ${result.summaryPath}`);
}

main().catch((error) => {
  console.error("Failed to execute planning validation workflow:", error);
  process.exitCode = 1;
});
