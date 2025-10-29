#!/usr/bin/env tsx

import process from "node:process";

import { recordScenarioRun } from "../src/validationRun/artefacts";
import {
  computeScenarioTimingReportFromFile,
  writeScenarioDashboardExport,
} from "../src/validationRun/metrics";
import { ensureValidationRunLayout } from "../src/validationRun/layout";
import {
  formatScenarioSlug,
  initialiseScenarioRun,
  type ValidationScenarioDefinition,
  VALIDATION_SCENARIOS,
} from "../src/validationRun/scenario";

// CLI helper computing `timings.json` from `events.ndjson` using the aggregation
// utilities provided in `src/validationRun/metrics.ts`.

async function main(): Promise<void> {
  const { scenarioIdentifier, eventsPathOverride } = parseArgs(process.argv.slice(2));
  const scenario = resolveScenario(scenarioIdentifier);
  const layout = await ensureValidationRunLayout();
  const run = await initialiseScenarioRun(scenario, { layout });

  const eventsPath = eventsPathOverride ?? run.events;
  const { report, notes } = await computeScenarioTimingReportFromFile(eventsPath);

  await recordScenarioRun(scenario.id, { timings: report }, { layout });
  const dashboard = await writeScenarioDashboardExport(scenario.id, report, { layout });

  console.log(`✔ timings.json mis à jour pour ${formatScenarioSlug(scenario)} (${eventsPath}).`);
  console.log(`  tookMs=${report.tookMs} | documents=${report.documentsIngested}`);
  console.log(
    `  erreurs=${Object.entries(report.errors)
      .map(([category, count]) => `${category}:${count}`)
      .join(", ") || "aucune"}`,
  );
  console.log(`  dashboard=${dashboard.path}`);

  if (notes.length > 0) {
    console.log("\nNotes:");
    for (const note of notes) {
      console.log(`- ${note}`);
    }
  }
}

interface ParsedArgs {
  readonly scenarioIdentifier: string;
  readonly eventsPathOverride?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let scenarioIdentifier: string | undefined;
  let eventsPathOverride: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--events=")) {
      eventsPathOverride = arg.slice("--events=".length);
    } else if (!scenarioIdentifier) {
      scenarioIdentifier = arg;
    } else {
      throw new Error(`Argument inattendu: ${arg}`);
    }
  }

  if (!scenarioIdentifier) {
    throw new Error("Usage: npm run validation:metrics -- <scenario|slug|SXX> [--events=path]");
  }

  return { scenarioIdentifier, eventsPathOverride };
}

function resolveScenario(identifier: string): ValidationScenarioDefinition {
  const trimmed = identifier.trim();
  const numericMatch = /^S?(\d{1,2})$/i.exec(trimmed);
  if (numericMatch) {
    const id = Number.parseInt(numericMatch[1], 10);
    const byId = VALIDATION_SCENARIOS.find((scenario) => scenario.id === id);
    if (byId) {
      return byId;
    }
  }

  const normalised = trimmed.toLowerCase();
  for (const scenario of VALIDATION_SCENARIOS) {
    const slug = formatScenarioSlug(scenario).toLowerCase();
    if (slug === normalised) {
      return scenario;
    }
    if (scenario.label.toLowerCase() === normalised) {
      return scenario;
    }
  }

  throw new Error(`Scénario inconnu: ${identifier}`);
}

void main().catch((error) => {
  console.error("Échec du calcul des métriques:", error);
  process.exitCode = 1;
});
