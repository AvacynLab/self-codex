#!/usr/bin/env node
/**
 * CLI helper verifying the idempotence requirement of the validation playbook.
 * The command compares the canonical S01 (base) and S05 (rerun) artefacts by
 * default, ensuring docIds and `search:doc_ingested` events remain identical.
 */
import process from "node:process";

import {
  compareScenarioIdempotence,
  type IdempotenceStatus,
} from "../src/validationRun/idempotence.js";
import { formatScenarioSlug } from "../src/validationRun/scenario.js";

interface CliOptions {
  readonly baseId: number;
  readonly rerunId: number;
  readonly baseRoot?: string;
  readonly asJson: boolean;
}

interface ParsedArguments {
  readonly options: CliOptions;
  readonly errors: readonly string[];
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let baseId: number | null = null;
  let rerunId: number | null = null;
  let baseRoot: string | undefined;
  let asJson = false;
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base") {
      index += 1;
      if (index >= argv.length) {
        errors.push("Missing value after --base");
        break;
      }
      baseId = parseId(argv[index], "--base", errors);
      continue;
    }
    if (token.startsWith("--base=")) {
      baseId = parseId(token.slice("--base=".length), "--base", errors);
      continue;
    }
    if (token === "--rerun") {
      index += 1;
      if (index >= argv.length) {
        errors.push("Missing value after --rerun");
        break;
      }
      rerunId = parseId(argv[index], "--rerun", errors);
      continue;
    }
    if (token.startsWith("--rerun=")) {
      rerunId = parseId(token.slice("--rerun=".length), "--rerun", errors);
      continue;
    }
    if (token === "--root") {
      index += 1;
      if (index >= argv.length) {
        errors.push("Missing value after --root");
        break;
      }
      baseRoot = argv[index];
      continue;
    }
    if (token.startsWith("--root=")) {
      baseRoot = token.slice("--root=".length);
      continue;
    }
    if (token === "--json") {
      asJson = true;
      continue;
    }
    errors.push(`Unknown option: ${token}`);
  }

  return {
    options: {
      baseId: baseId ?? 1,
      rerunId: rerunId ?? 5,
      baseRoot,
      asJson,
    },
    errors,
  };
}

function parseId(value: string, label: string, errors: string[]): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`Invalid scenario identifier for ${label}: ${value}`);
    return null;
  }
  return parsed;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const wantsHelp = rawArgs.some((token) => token === "--help" || token === "-h");
  if (wantsHelp) {
    printUsage([]);
    return;
  }

  const filteredArgs = rawArgs.filter((token) => token !== "--help" && token !== "-h");
  const { options, errors } = parseArguments(filteredArgs);
  if (errors.length > 0) {
    printUsage(errors);
    process.exitCode = 1;
    return;
  }

  try {
    const comparison = await compareScenarioIdempotence({
      baseScenarioId: options.baseId,
      rerunScenarioId: options.rerunId,
      baseRoot: options.baseRoot,
    });

    if (options.asJson) {
      console.log(JSON.stringify(comparison, null, 2));
      process.exitCode = statusToExitCode(comparison.status);
      return;
    }

    const baseSlug = formatScenarioSlug(comparison.base.scenario);
    const rerunSlug = formatScenarioSlug(comparison.rerun.scenario);
    const summary = {
      baseScenario: baseSlug,
      rerunScenario: rerunSlug,
      status: comparison.status,
      documentDiff: comparison.documentDiff,
      eventDiff: comparison.eventDiff,
      baseDocumentCount: comparison.base.documentIds?.length ?? null,
      rerunDocumentCount: comparison.rerun.documentIds?.length ?? null,
      baseEventDocIds: comparison.base.eventDocIds?.length ?? null,
      rerunEventDocIds: comparison.rerun.eventDocIds?.length ?? null,
      baseDuplicates: {
        documents: comparison.base.documentDuplicates,
        events: comparison.base.eventDuplicates,
      },
      rerunDuplicates: {
        documents: comparison.rerun.documentDuplicates,
        events: comparison.rerun.eventDuplicates,
      },
    };

    const log = comparison.status === "pass" ? console.info : console.warn;
    log("Idempotence summary", summary);
    if (comparison.notes.length > 0) {
      console.warn("Notes:");
      for (const note of comparison.notes) {
        console.warn(`- ${note}`);
      }
    }
    process.exitCode = statusToExitCode(comparison.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Idempotence check failed: ${message}`);
    process.exitCode = 1;
  }
}

function statusToExitCode(status: IdempotenceStatus): number {
  switch (status) {
    case "pass":
      return 0;
    case "fail":
      return 1;
    default:
      return 2;
  }
}

function printUsage(errors: readonly string[]): void {
  const usage = `Usage: npm run validation:idempotence [-- --base <id> --rerun <id> --root <path> --json]\n\n` +
    `Options:\n` +
    `  --base <id>    Scenario de référence (par défaut: 1).\n` +
    `  --rerun <id>   Scenario à comparer (par défaut: 5).\n` +
    `  --root <path>  Dossier racine de validation (par défaut: ./validation_run).\n` +
    `  --json         Affiche le rapport complet au format JSON.\n` +
    `  -h, --help     Affiche cette aide.`;

  for (const error of errors) {
    console.error(error);
  }
  console.error("\n" + usage);
}

void main();
