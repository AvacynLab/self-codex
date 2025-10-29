#!/usr/bin/env tsx

import process from "node:process";

import { runValidationBuild } from "../src/validationRun/build";

// This CLI wraps `runValidationBuild` so operators can execute the checklist
// compiler step with a single npm script while preserving an audit trail.

async function main(): Promise<void> {
  const result = await runValidationBuild();

  console.log(`✔ Validation build log recorded at ${result.logFile}`);
  for (const step of result.steps) {
    const args = step.args.join(" ");
    const renderedArgs = args.length > 0 ? ` ${args}` : "";
    const status = step.exitCode === 0 ? "✔" : "✖";
    console.log(`${status} ${step.command}${renderedArgs} (exit=${step.exitCode}, durationMs=${step.durationMs})`);
    if (step.error) {
      console.error(`  error: ${step.error}`);
    }
  }

  if (!result.success) {
    console.error("\n✖ Validation build sequence failed. Inspect the log for details.");
    process.exitCode = 1;
    return;
  }

  console.log("\n✔ Validation build sequence completed successfully.");
}

void main().catch((error) => {
  console.error("Unexpected failure while running the validation build:", error);
  process.exitCode = 1;
});
