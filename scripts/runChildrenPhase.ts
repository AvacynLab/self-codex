#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeChildrenCli,
  parseChildrenCliOptions,
} from "../src/validation/childrenCli.js";
import { CHILDREN_JSONL_FILES } from "../src/validation/children.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Prepares the sanitised invocation for the Stage 5 validation runner. The
 * helper clones the incoming argv slice to avoid mutating the caller and
 * filters `undefined` environment entries so downstream strict optional checks
 * never observe placeholder values.
 */
export function prepareChildrenCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseChildrenCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

/**
 * CLI entrypoint for the Stage 5 (child orchestration) validation workflow.
 * The script keeps the ergonomics aligned with the other validation tools so
 * operators can chain stages without memorising new flag conventions.
 */
async function main(): Promise<void> {
  const { options, env } = prepareChildrenCliInvocation(
    process.argv.slice(2),
    process.env,
  );

  const { runRoot, result } = await executeChildrenCli(options, env, console);

  console.log("🧒 Child validation summary:");
  console.log(`   • child id: ${result.summary.childId ?? "unknown"}`);
  console.log(`   • goal: ${result.summary.goal ?? "n/a"}`);
  console.log(`   • prompt: ${result.summary.prompt ?? "n/a"}`);
  console.log(`   • reply: ${result.summary.replyText ?? "n/a"}`);

  if (result.summary.updatedLimits) {
    console.log(
      `   • limits tightened to cpu=${result.summary.updatedLimits.cpu_ms}ms, ` +
        `memory=${result.summary.updatedLimits.memory_mb}MB, wall=${result.summary.updatedLimits.wall_ms}ms`,
    );
  }

  console.log(`🧾 Requests log: ${join(runRoot, CHILDREN_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, CHILDREN_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, CHILDREN_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, CHILDREN_JSONL_FILES.log)}`);
  console.log(`📝 Summary: ${result.summaryPath}`);
  if (result.conversationPath) {
    console.log(`💬 Conversation transcript: ${result.conversationPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to execute child validation workflow:", error);
    process.exitCode = 1;
  });
}
