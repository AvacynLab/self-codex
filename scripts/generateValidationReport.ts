#!/usr/bin/env tsx

import { writeValidationReport } from "../src/validationRun/reports.js";

async function main(): Promise<void> {
  try {
    const result = await writeValidationReport();
    console.log(`✔ summary.json écrit dans ${result.summaryPath}`);
    console.log(`✔ REPORT.md écrit dans ${result.reportPath}`);
  } catch (error) {
    console.error("✖ génération du rapport échouée:", error);
    process.exitCode = 1;
  }
}

void main();
