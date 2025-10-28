#!/usr/bin/env tsx
/**
 * CLI orchestrating the entire validation checklist (layout, snapshots, build,
 * scenarios, audit, remediation). The command is intended for operators running
 * the playbook end-to-end: it surfaces a concise summary of each step while
 * delegating the heavy lifting to the helpers in `src/validationRun/`.
 */
import process from "node:process";

import {
  runValidationCampaign,
  type ValidationCampaignOptions,
  type ValidationCampaignResult,
  type ValidationCampaignStepResult,
} from "../src/validationRun/campaign.js";
import {
  VALIDATION_SCENARIOS,
  formatScenarioSlug,
} from "../src/validationRun/scenario.js";

interface CliOptions {
  readonly baseRoot?: string;
  readonly scenarioIds?: readonly number[];
  readonly captureSnapshots: boolean;
  readonly runBuild: boolean;
  readonly ensureRuntime: boolean;
  readonly generateReport: boolean;
  readonly runIdempotence: boolean;
  readonly runAudit: boolean;
  readonly runRemediation: boolean;
  readonly persistArtifacts: boolean;
  readonly stopOnScenarioFailure: boolean;
  readonly jobPrefix?: string;
}

interface ParsedArgs {
  readonly options: CliOptions;
  readonly errors: readonly string[];
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage([]);
    return;
  }

  const { options, errors } = parseArguments(rawArgs);
  if (errors.length > 0) {
    printUsage(errors);
    process.exitCode = 1;
    return;
  }

  const campaignOptions: ValidationCampaignOptions = {
    baseRoot: options.baseRoot,
    scenarioIds: options.scenarioIds,
    captureSnapshots: options.captureSnapshots,
    runBuild: options.runBuild,
    ensureRuntime: options.ensureRuntime,
    generateReport: options.generateReport,
    runIdempotence: options.runIdempotence,
    runAudit: options.runAudit,
    runRemediation: options.runRemediation,
    persistArtifacts: options.persistArtifacts,
    stopOnScenarioFailure: options.stopOnScenarioFailure,
    scenarioJobIdPrefix: options.jobPrefix,
  };

  try {
    const result = await runValidationCampaign(campaignOptions);
    logSummary(result);
    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("✖ Validation campaign failed:", error);
    process.exitCode = 1;
  }
}

function parseArguments(argv: readonly string[]): ParsedArgs {
  const options: CliOptions = {
    captureSnapshots: true,
    runBuild: true,
    ensureRuntime: true,
    generateReport: true,
    runIdempotence: true,
    runAudit: true,
    runRemediation: true,
    persistArtifacts: true,
    stopOnScenarioFailure: false,
  };
  const errors: string[] = [];
  const scenarioIds: number[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--scenarios=")) {
      const value = token.slice("--scenarios=".length);
      scenarioIds.push(...parseScenarioList(value, errors));
      continue;
    }
    if (token === "--scenarios" || token === "--scenario") {
      index += 1;
      if (index >= argv.length) {
        errors.push("Missing value after --scenarios.");
        break;
      }
      scenarioIds.push(...parseScenarioList(argv[index], errors));
      continue;
    }
    if (token.startsWith("--root=")) {
      const value = token.slice("--root=".length);
      if (value.length === 0) {
        errors.push("--root requires a value (use --root <path>).");
      } else {
        options.baseRoot = value;
      }
      continue;
    }
    if (!token.startsWith("-")) {
      scenarioIds.push(...parseScenarioList(token, errors));
      continue;
    }
    switch (token) {
      case "--root":
      case "-r": {
        index += 1;
        if (index >= argv.length) {
          errors.push("Missing value after --root.");
          break;
        }
        options.baseRoot = argv[index];
        break;
      }
      case "--skip-snapshots":
        options.captureSnapshots = false;
        break;
      case "--skip-build":
        options.runBuild = false;
        break;
      case "--skip-runtime":
        options.ensureRuntime = false;
        break;
      case "--skip-report":
        options.generateReport = false;
        break;
      case "--skip-idempotence":
        options.runIdempotence = false;
        break;
      case "--skip-audit":
        options.runAudit = false;
        break;
      case "--skip-remediation":
        options.runRemediation = false;
        break;
      case "--no-artifacts":
        options.persistArtifacts = false;
        break;
      case "--artifacts":
        options.persistArtifacts = true;
        break;
      case "--stop-on-failure":
        options.stopOnScenarioFailure = true;
        break;
      case "--job-prefix":
      case "-j": {
        index += 1;
        if (index >= argv.length) {
          errors.push("Missing value after --job-prefix.");
          break;
        }
        options.jobPrefix = argv[index];
        break;
      }
      default: {
        if (token.startsWith("--job-prefix=")) {
          options.jobPrefix = token.slice("--job-prefix=".length);
          break;
        }
        errors.push(`Unknown option: ${token}`);
        break;
      }
    }
  }

  if (scenarioIds.length > 0) {
    options.scenarioIds = scenarioIds;
  }

  return { options, errors };
}

function parseScenarioList(value: string, errors: string[]): number[] {
  const result: number[] = [];
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^S?(\d{1,2})$/i.exec(trimmed);
    if (!match) {
      const normalised = trimmed.toLowerCase();
      const bySlug = VALIDATION_SCENARIOS.find((scenario) => {
        const slug = formatScenarioSlug(scenario).toLowerCase();
        return slug === normalised || scenario.label.toLowerCase() === normalised;
      });
      if (bySlug) {
        result.push(bySlug.id);
        continue;
      }
      errors.push(`Invalid scenario identifier: ${trimmed}`);
      continue;
    }
    const id = Number.parseInt(match[1], 10);
    if (!Number.isInteger(id) || id <= 0) {
      errors.push(`Invalid scenario identifier: ${trimmed}`);
      continue;
    }
    result.push(id);
  }
  return result;
}

function logSummary(result: ValidationCampaignResult): void {
  console.log("Validation campaign summary\n============================");
  console.log(`Root: ${result.layout.root}`);
  if (result.skipped.length > 0) {
    console.log(`Skipped steps: ${result.skipped.join(", ")}`);
  }

  logStep("Snapshots", result.snapshots);
  logStep("Build", result.build);
  logStep("Runtime", result.runtime);

  if (result.scenarios.length > 0) {
    console.log("\nScenarios:");
    for (const scenario of result.scenarios) {
      const status = scenario.ok ? "✔" : "✖";
      console.log(`  ${status} ${scenario.slug}`);
      if (!scenario.ok && scenario.error) {
        console.log(`     ${scenario.error}`);
      }
      if (scenario.result?.timings?.tookMs) {
        console.log(`     tookMs=${scenario.result.timings.tookMs}`);
      }
      if (scenario.result?.documents) {
        console.log(`     documents=${scenario.result.documents.length}`);
      }
    }
  }

  logStep("Report", result.report);
  logStep("Idempotence", result.idempotence);
  logStep("Audit", result.audit);
  logStep("Remediation", result.remediation);

  if (result.notes.length > 0) {
    console.log("\nNotes:");
    for (const note of result.notes) {
      console.log(`- ${note}`);
    }
  }

  console.log("\nOverall status:", result.success ? "✔ success" : "✖ failure");
}

function logStep<T>(label: string, step: ValidationCampaignStepResult<T> | undefined): void {
  if (!step) {
    console.log(`${label}: skipped`);
    return;
  }
  const status = step.ok ? "✔" : "✖";
  console.log(`${label}: ${status}`);
  if (!step.ok && step.error) {
    console.log(`  ${step.error}`);
  }
}

function printUsage(errors: readonly string[]): void {
  if (errors.length > 0) {
    console.error("Errors:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    console.error("");
  }

  const scenarioExamples = VALIDATION_SCENARIOS.map((scenario) => formatScenarioSlug(scenario)).join(", ");
  console.log(`Usage: npm run validation:campaign [options]\n\n` +
    `Options:\n` +
    `  --scenarios <list>     Comma-separated scenario IDs or slugs (e.g. 1,5,10).\n` +
    `  --skip-snapshots       Skip the snapshot capture stage.\n` +
    `  --skip-build           Skip the npm build step.\n` +
    `  --skip-runtime         Skip the runtime directory preparation.\n` +
    `  --skip-report          Skip summary/report generation.\n` +
    `  --skip-idempotence     Skip the S01/S05 comparison.\n` +
    `  --skip-audit           Skip the artefact audit.\n` +
    `  --skip-remediation     Skip the remediation plan generation.\n` +
    `  --no-artifacts         Do not persist auxiliary dumps under validation_run/artifacts.\n` +
    `  --stop-on-failure      Abort remaining scenarios after the first failure.\n` +
    `  --job-prefix <value>   Prefix added to scenario job identifiers.\n` +
    `  --root <path>          Override the validation_run root directory.\n` +
    `  -h, --help             Show this message.\n\n` +
    `Available scenarios: ${scenarioExamples}`);
}

void main();
