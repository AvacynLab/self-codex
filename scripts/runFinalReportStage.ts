#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { executeFinalReportCli, parseFinalReportCliOptions } from "../src/validation/finalReportCli.js";
import { FINAL_REPORT_FINDINGS_FILENAME, FINAL_REPORT_RECOMMENDATIONS_FILENAME, FINAL_REPORT_SUMMARY_FILENAME } from "../src/validation/finalReport.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Prepares the sanitised invocation for the final report aggregation so the
 * helper reuses the same environment semantics as the other validation
 * scripts.
 */
export function prepareFinalReportCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseFinalReportCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

/**
 * CLI entrypoint that aggregates the validation artefacts into findings,
 * summary and recommendations documents. The script mirrors the ergonomics of
 * the other validation helpers so operators can chain executions seamlessly at
 * the end of a campaign.
 */
async function main(): Promise<void> {
  const { options, env } = prepareFinalReportCliInvocation(
    process.argv.slice(2),
    process.env,
  );
  const { runRoot, result } = await executeFinalReportCli(options, env, console);

  console.log("📊 Rapport final généré:");
  console.log(`   • Appels totaux : ${result.findings.metrics.totalCalls} (erreurs=${result.findings.metrics.errorCount})`);
  console.log(`   • Outils couverts : ${result.findings.coverage.coveredTools}`);
  console.log(`   • Incidents : ${result.findings.incidents.length}`);
  console.log(`🧾 Findings : ${join(runRoot, "report", FINAL_REPORT_FINDINGS_FILENAME)}`);
  console.log(`📝 Summary : ${join(runRoot, "report", FINAL_REPORT_SUMMARY_FILENAME)}`);
  console.log(`🎯 Recommandations : ${join(runRoot, "report", FINAL_REPORT_RECOMMENDATIONS_FILENAME)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to generate the final validation report:", error);
    process.exitCode = 1;
  });
}

