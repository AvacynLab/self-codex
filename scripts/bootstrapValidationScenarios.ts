#!/usr/bin/env node
import process from "node:process";
import path from "node:path";

import {
  formatScenarioSlug,
  initialiseAllScenarios,
  initialiseScenarioRerun,
  VALIDATION_SCENARIOS,
  type ValidationScenarioDefinition,
} from "../src/validationRun/scenario.js";
import { computeValidationRunEnv, ensureValidationRunLayout } from "../src/validationRun/layout.js";

/**
 * CLI utility that scaffolds the per-scenario directories described in the
 * validation checklist. The script materialises `input.json` files with the
 * canonical payloads and leaves placeholders for the remaining artefacts so the
 * execution team can focus on running the scenarios.
 */
async function main(): Promise<void> {
  const { ensureBase, reruns } = parseCliArgs(process.argv.slice(2));

  const layout = await ensureValidationRunLayout();
  const envOverrides = computeValidationRunEnv(layout);
  Object.assign(process.env, envOverrides);

  if (ensureBase) {
    const runs = await initialiseAllScenarios({ layout });
    console.log("✅ Validation scenarios prepared under validation_run/runs:");
    for (const [index, run] of runs.entries()) {
      const scenario = VALIDATION_SCENARIOS[index];
      const slug = formatScenarioSlug(scenario);
      const relativeRoot = path.relative(process.cwd(), run.root);
      console.log(` • ${slug} (${scenario.label}): ${relativeRoot}`);
      console.log(`   ↳ input: ${path.relative(process.cwd(), run.input)}`);
    }
  } else {
    console.log("ℹ️ Base scenario scaffolding skipped (--no-base).");
  }

  if (reruns.length > 0) {
    console.log("🔁 Rerun folders prepared:");
    for (const request of reruns) {
      const run = await initialiseScenarioRerun(request.scenario, {
        layout,
        iteration: request.iteration,
      });
      const runSlug = path.basename(run.root);
      console.log(
        ` • ${runSlug} (${request.scenario.label}): ${path.relative(process.cwd(), run.root)}`,
      );
      console.log(`   ↳ input: ${path.relative(process.cwd(), run.input)}`);
    }
  }

  console.log("ℹ️ MCP log environment overrides applied:");
  for (const [key, value] of Object.entries(envOverrides)) {
    console.log(`   ${key}=${value}`);
  }
}

/** Parses CLI arguments controlling base scaffolding and rerun creation. */
function parseCliArgs(args: readonly string[]): {
  readonly ensureBase: boolean;
  readonly reruns: readonly RerunRequest[];
} {
  let ensureBase = true;
  const reruns: RerunRequest[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-base") {
      ensureBase = false;
      continue;
    }
    if (arg.startsWith("--rerun=")) {
      reruns.push(resolveRerun(arg.slice("--rerun=".length)));
      continue;
    }
    if (arg === "--rerun") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--rerun requires a value (e.g. --rerun S05:rerun1)");
      }
      reruns.push(resolveRerun(value));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { ensureBase, reruns };
}

/** Descriptor capturing a rerun request extracted from the CLI arguments. */
interface RerunRequest {
  readonly scenario: ValidationScenarioDefinition;
  readonly iteration?: string;
}

/** Resolves a rerun reference such as `S05:rerun2` to its structured form. */
function resolveRerun(argument: string): RerunRequest {
  const [scenarioRefRaw, iterationRaw] = argument.split(":", 2);
  const scenario = resolveScenarioReference(scenarioRefRaw ?? "");
  const iteration = iterationRaw?.trim();
  return {
    scenario,
    iteration: iteration && iteration.length > 0 ? iteration : undefined,
  };
}

/**
 * Maps a scenario reference (`S05`, `5`, `S05_pdf_science`) to the canonical
 * definition exported by {@link VALIDATION_SCENARIOS}.
 */
function resolveScenarioReference(reference: string): ValidationScenarioDefinition {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("Scenario reference cannot be empty when requesting a rerun");
  }

  const idMatch = trimmed.match(/^s?(\d{1,2})$/i);
  if (idMatch) {
    const id = Number.parseInt(idMatch[1], 10);
    const scenarioById = VALIDATION_SCENARIOS.find((entry) => entry.id === id);
    if (scenarioById) {
      return scenarioById;
    }
  }

  const normalized = trimmed.toLowerCase();
  const scenarioBySlug = VALIDATION_SCENARIOS.find(
    (entry) => formatScenarioSlug(entry).toLowerCase() === normalized,
  );
  if (scenarioBySlug) {
    return scenarioBySlug;
  }

  throw new Error(`Unknown scenario reference: ${reference}`);
}

main().catch((error) => {
  console.error("❌ Failed to prepare validation scenarios:", error);
  process.exitCode = 1;
});
