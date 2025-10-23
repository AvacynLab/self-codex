#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { executeKnowledgeCli, parseKnowledgeCliOptions } from "../src/validation/knowledgeCli.js";
import { KNOWLEDGE_JSONL_FILES } from "../src/validation/knowledge.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Creates the sanitised invocation payload for the knowledge validation
 * runner, ensuring both argv and environment inputs remain deterministic and
 * free from `undefined` placeholders.
 */
export function prepareKnowledgeCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseKnowledgeCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

/**
 * CLI entrypoint for the Stage 8 knowledge & values validation workflow. The
 * helper mirrors the ergonomics of previous stages so operators can easily
 * chain runs across the entire validation checklist.
 */
async function main(): Promise<void> {
  const { options, env } = prepareKnowledgeCliInvocation(
    process.argv.slice(2),
    process.env,
  );

  const { runRoot, result } = await executeKnowledgeCli(options, env, console);

  console.log("🧠 Knowledge & values validation summary:");
  console.log(`   • assist query: ${result.summary.knowledge.assistQuery ?? "unknown"}`);
  console.log(`   • plan title: ${result.summary.knowledge.planTitle ?? "unknown"}`);
  console.log(`   • values topic: ${result.summary.values.topic ?? "unknown"}`);
  console.log(
    `   • explanation consistent: ${result.summary.values.explanationConsistent ? "yes" : "no"}`,
  );

  console.log(`📚 Requests log: ${join(runRoot, KNOWLEDGE_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, KNOWLEDGE_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, KNOWLEDGE_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, KNOWLEDGE_JSONL_FILES.log)}`);
  if (result.summary.artefacts.valuesGraphExport) {
    console.log(`🧾 Values graph export: ${result.summary.artefacts.valuesGraphExport}`);
  }
  if (result.summary.artefacts.causalExport) {
    console.log(`🧾 Values causal export: ${result.summary.artefacts.causalExport}`);
  }
  console.log(`📝 Summary: ${result.summaryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to execute knowledge validation workflow:", error);
    process.exitCode = 1;
  });
}
