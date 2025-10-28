#!/usr/bin/env node
/**
 * CLI helper executing one of the search-driven validation scenarios and
 * persisting the resulting artefacts under `validation_run/`. The command is
 * designed for operators running the checklist manually: it orchestrates the
 * search pipeline, records events, and surfaces a concise status summary.
 */
import process from "node:process";

import { executeSearchScenario } from "../src/validationRun/execution.js";
import { formatScenarioSlug } from "../src/validationRun/scenario.js";

interface CliOptions {
  readonly scenarioId: number;
  readonly jobId?: string;
  readonly baseRoot?: string;
  readonly persistArtifacts: boolean;
}

interface ParsedArgs {
  readonly options: CliOptions;
  readonly errors: readonly string[];
}

function parseArguments(argv: readonly string[]): ParsedArgs {
  let scenarioId: number | null = null;
  let jobId: string | undefined;
  let baseRoot: string | undefined;
  let persistArtifacts = true;
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--scenario" || token === "-s") {
      index += 1;
      if (index >= argv.length) {
        errors.push("Missing value after --scenario");
        break;
      }
      scenarioId = parseScenarioId(argv[index], errors);
      continue;
    }
    if (token.startsWith("--scenario=")) {
      scenarioId = parseScenarioId(token.slice("--scenario=".length), errors);
      continue;
    }
    if (token === "--job" || token === "-j") {
      index += 1;
      if (index >= argv.length) {
        errors.push("Missing value after --job");
        break;
      }
      jobId = argv[index];
      continue;
    }
    if (token.startsWith("--job=")) {
      jobId = token.slice("--job=".length);
      continue;
    }
    if (token === "--root" || token === "-r") {
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
    if (token === "--no-artifacts") {
      persistArtifacts = false;
      continue;
    }
    if (token === "--artifacts") {
      persistArtifacts = true;
      continue;
    }
    if (!token.startsWith("-")) {
      if (scenarioId === null) {
        scenarioId = parseScenarioId(token, errors);
        continue;
      }
      errors.push(`Unexpected positional argument: ${token}`);
      continue;
    }
    errors.push(`Unknown option: ${token}`);
  }

  if (scenarioId === null) {
    errors.push("A scenario identifier (1..10) must be provided via --scenario or as the first positional argument.");
  }

  return {
    options: {
      scenarioId: scenarioId ?? 0,
      jobId,
      baseRoot,
      persistArtifacts,
    },
    errors,
  };
}

function parseScenarioId(raw: string, errors: string[]): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`Invalid scenario identifier: ${raw}`);
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
    const result = await executeSearchScenario({
      scenarioId: options.scenarioId,
      jobId: options.jobId,
      baseRoot: options.baseRoot,
      persistArtifacts: options.persistArtifacts,
    });

    const slug = formatScenarioSlug(result.scenario);
    const stats = (result.response.stats ?? {}) as Record<string, unknown>;
    const response = result.response as Record<string, unknown>;
    const errorCount = typeof response.errorCount === "number"
      ? response.errorCount
      : Array.isArray(response.errors)
        ? response.errors.length
        : Math.max(0, result.documents.length - result.knowledgeSummaries.length);

    if (result.scenario.id === 10) {
      const coverage = (response.coverage ?? {}) as Record<string, unknown>;
      const ragSummary = {
        knowledgeHits: coverage.knowledge_hits ?? null,
        ragHits: coverage.rag_hits ?? null,
        citations: Array.isArray(response.citations) ? response.citations.length : null,
        aggregatedScenarios: stats.aggregatedScenarios ?? [],
        missingScenarios: stats.missingScenarios ?? [],
        knowledgeSubjects: stats.knowledgeSubjects ?? null,
        vectorDocuments: stats.vectorDocuments ?? null,
        tookMs: stats.tookMs ?? null,
        notes: response.notes ?? [],
        artifactDir: result.artifactDir,
      };
      console.info(`[${slug}] RAG scenario completed`, ragSummary);
    } else {
      const summary = {
        requestedResults: stats.requestedResults ?? null,
        receivedResults: stats.receivedResults ?? null,
        fetchedDocuments: stats.fetchedDocuments ?? null,
        structuredDocuments: stats.structuredDocuments ?? null,
        graphIngested: stats.graphIngested ?? null,
        vectorIngested: stats.vectorIngested ?? null,
        errors: errorCount,
        documents: result.documents.length,
        knowledgeSubjects: result.knowledgeSummaries.length,
        vectorChunks: result.vectorSummaries.length,
        tookMs: result.timings?.tookMs ?? null,
        artifactDir: result.artifactDir,
      };
      console.info(`[${slug}] Scenario completed`, summary);
    }
    if (result.timingNotes.length > 0) {
      console.warn("Timing notes:", result.timingNotes);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Scenario execution failed: ${message}`);
    process.exitCode = 1;
  }
}

function printUsage(errors: readonly string[]): void {
  const usage = `Usage: npm run validation:scenario:run -- --scenario <id> [options]\n\n` +
    `Options:\n` +
    `  -s, --scenario <id>   Scenario identifier (1..10).\n` +
    `  -j, --job <id>        Optional job identifier forwarded to the search pipeline.\n` +
    `  -r, --root <path>     Override the validation_run root directory.\n` +
    `      --no-artifacts    Skip writing auxiliary dumps under validation_run/artifacts.\n` +
    `      --artifacts       Force artifact dumps (default).\n` +
    `  -h, --help            Show this message.`;

  for (const error of errors) {
    console.error(error);
  }
  console.error("\n" + usage);
}

void main();
