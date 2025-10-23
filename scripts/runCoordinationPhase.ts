#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { executeCoordinationCli, parseCoordinationCliOptions } from "../src/validation/coordinationCli.js";
import { COORDINATION_JSONL_FILES } from "../src/validation/coordination.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Builds the sanitised invocation bag for the Stage 7 coordination runner.
 * The helper clones argv so repeated calls remain side-effect free and strips
 * `undefined` entries from the environment to preserve strict optional
 * semantics when the workflow inspects process settings.
 */
export function prepareCoordinationCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseCoordinationCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

/**
 * CLI entrypoint for the Stage 7 coordination validation workflow. The helper
 * mirrors the ergonomics of previous stages so operators can easily chain runs
 * across the entire validation checklist.
 */
async function main(): Promise<void> {
  const { options, env } = prepareCoordinationCliInvocation(
    process.argv.slice(2),
    process.env,
  );

  const { runRoot, result } = await executeCoordinationCli(options, env, console);

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to execute coordination validation workflow:", error);
    process.exitCode = 1;
  });
}
