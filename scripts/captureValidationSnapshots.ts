#!/usr/bin/env node
import process from "node:process";
import path from "node:path";

import { captureValidationSnapshots } from "../src/validationRun/snapshots.js";
import { computeValidationRunEnv, ensureValidationRunLayout } from "../src/validationRun/layout.js";

/**
 * Simple CLI entry point that initialises the validation_run snapshots mandated
 * by the playbook. The script ensures the directory layout exists, captures the
 * artefacts and prints their relative locations so operators can inspect them
 * immediately.
 */
async function main(): Promise<void> {
  const layout = await ensureValidationRunLayout();
  const recommendedEnv = computeValidationRunEnv(layout);
  Object.assign(process.env, recommendedEnv);

  const snapshots = await captureValidationSnapshots({ layout, env: process.env });

  const relative = Object.fromEntries(
    Object.entries(snapshots).map(([key, absolute]) => [key, path.relative(process.cwd(), absolute)]),
  );

  console.log("✅ Validation snapshots captured:");
  for (const [key, filePath] of Object.entries(relative)) {
    console.log(` • ${key}: ${filePath}`);
  }

  console.log("ℹ️ Recommended environment overrides applied:");
  for (const [key, value] of Object.entries(recommendedEnv)) {
    console.log(`   ${key}=${value}`);
  }
}

main().catch((error) => {
  console.error("❌ Failed to capture validation snapshots:", error);
  process.exitCode = 1;
});
