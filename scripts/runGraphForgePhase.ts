#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeGraphForgeCli,
  parseGraphForgeCliOptions,
} from "../src/validation/graphForgeCli.js";
import { GRAPH_FORGE_JSONL_FILES } from "../src/validation/graphForge.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Constructs the sanitised argument bag for the Stage 4 Graph Forge runner so
 * end-to-end executions never leak `undefined` environment entries. Returning
 * a fresh argv copy keeps unit tests deterministic when they tweak arguments.
 */
export function prepareGraphForgeCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseGraphForgeCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

/**
 * CLI entrypoint for the Stage 4 (Graph Forge & autosave) validation workflow.
 * The script wires the reusable executor to Node.js console logging, mirroring
 * the ergonomics of the other validation stages.
 */
async function main(): Promise<void> {
  const { options, env } = prepareGraphForgeCliInvocation(
    process.argv.slice(2),
    process.env,
  );

  const { runRoot, result } = await executeGraphForgeCli(options, env, console);

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to execute Graph Forge validation:", error);
    process.exitCode = 1;
  });
}
