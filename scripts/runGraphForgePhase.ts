#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import {
  executeGraphForgeCli,
  parseGraphForgeCliOptions,
} from "../src/validation/graphForgeCli.js";
import { GRAPH_FORGE_JSONL_FILES } from "../src/validation/graphForge.js";

/**
 * CLI entrypoint for the Stage 4 (Graph Forge & autosave) validation workflow.
 * The script wires the reusable executor to Node.js console logging, mirroring
 * the ergonomics of the other validation stages.
 */
async function main(): Promise<void> {
  const options = parseGraphForgeCliOptions(process.argv.slice(2));

  const { runRoot, result } = await executeGraphForgeCli(options, process.env, console);

  console.log("🧮 Graph Forge analysis complete:");
  console.log(`   • DSL: ${result.analysis.dslPath}`);
  console.log(`   • Report: ${result.analysis.resultPath}`);

  const observation = result.autosave.observation;
  console.log("🕒 Autosave observation:");
  console.log(
    `   • ticks observed: ${observation.observedTicks}/${observation.requiredTicks} (completed=${observation.completed})`,
  );
  if (observation.lastError) {
    console.log(`   • last error: ${observation.lastError}`);
  }
  console.log(`   • summary: ${result.autosave.summaryPath}`);

  console.log(`🧾 Requests log: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.log)}`);
}

main().catch((error) => {
  console.error("Failed to execute Graph Forge validation:", error);
  process.exitCode = 1;
});
