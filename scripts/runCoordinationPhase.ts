#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import { executeCoordinationCli, parseCoordinationCliOptions } from "../src/validation/coordinationCli.js";
import { COORDINATION_JSONL_FILES } from "../src/validation/coordination.js";

/**
 * CLI entrypoint for the Stage 7 coordination validation workflow. The helper
 * mirrors the ergonomics of previous stages so operators can easily chain runs
 * across the entire validation checklist.
 */
async function main(): Promise<void> {
  const options = parseCoordinationCliOptions(process.argv.slice(2));

  const { runRoot, result } = await executeCoordinationCli(options, process.env, console);

  console.log("🤝 Coordination validation summary:");
  console.log(`   • blackboard key: ${result.summary.blackboard.key ?? "unknown"}`);
  console.log(`   • blackboard events captured: ${result.summary.blackboard.eventCount}`);
  console.log(`   • stigmergy domain: ${result.summary.stigmergy.domain ?? "unknown"}`);
  console.log(`   • contract topic: ${result.summary.contractNet.topic ?? "unknown"}`);
  console.log(`   • consensus topic: ${result.summary.consensus.topic ?? "unknown"}`);

  console.log(`🧾 Requests log: ${join(runRoot, COORDINATION_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, COORDINATION_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, COORDINATION_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, COORDINATION_JSONL_FILES.log)}`);
  console.log(`📝 Summary: ${result.summaryPath}`);
}

main().catch((error) => {
  console.error("Failed to execute coordination validation workflow:", error);
  process.exitCode = 1;
});
