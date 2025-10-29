#!/usr/bin/env tsx

import { auditValidationRun } from "../src/validationRun/audit.js";

async function main(): Promise<void> {
  try {
    const report = await auditValidationRun();
    for (const scenario of report.scenarios) {
      if (scenario.missingArtefacts.length === 0 && scenario.timingIssues.length === 0) {
        console.log(`✔ ${scenario.slug} → artefacts complets`);
        continue;
      }

      console.log(`✖ ${scenario.slug}`);
      if (scenario.missingArtefacts.length > 0) {
        console.log(`  • Fichiers manquants: ${scenario.missingArtefacts.join(", ")}`);
      }
      if (scenario.timingIssues.length > 0) {
        for (const issue of scenario.timingIssues) {
          console.log(`  • ${issue}`);
        }
      }
    }

    if (report.secretFindings.length > 0) {
      console.log("⚠ Secrets potentiels détectés:");
      for (const finding of report.secretFindings) {
        console.log(
          `  • ${finding.file}:${finding.line} – ${finding.description} (${finding.snippet})`,
        );
      }
    }

    if (report.hasBlockingIssues) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("✖ audit impossible:", error);
    process.exitCode = 1;
  }
}

void main();
