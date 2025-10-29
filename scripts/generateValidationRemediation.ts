#!/usr/bin/env tsx

import { writeRemediationPlan } from "../src/validationRun/remediation.js";

async function main(): Promise<void> {
  try {
    const result = await writeRemediationPlan();
    console.log(`✔ remediation_plan.json écrit dans ${result.jsonPath}`);
    console.log(`✔ REMEDIATION_PLAN.md écrit dans ${result.markdownPath}`);
  } catch (error) {
    console.error("✖ génération du plan de remédiation échouée:", error);
    process.exitCode = 1;
  }
}

void main();
