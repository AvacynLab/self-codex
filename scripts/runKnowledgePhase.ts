#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import { executeKnowledgeCli, parseKnowledgeCliOptions } from "../src/validation/knowledgeCli.js";
import { KNOWLEDGE_JSONL_FILES } from "../src/validation/knowledge.js";

/**
 * CLI entrypoint for the Stage 8 knowledge & values validation workflow. The
 * helper mirrors the ergonomics of previous stages so operators can easily
 * chain runs across the entire validation checklist.
 */
async function main(): Promise<void> {
  const options = parseKnowledgeCliOptions(process.argv.slice(2));

  const { runRoot, result } = await executeKnowledgeCli(options, process.env, console);

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

main().catch((error) => {
  console.error("Failed to execute knowledge validation workflow:", error);
  process.exitCode = 1;
});
