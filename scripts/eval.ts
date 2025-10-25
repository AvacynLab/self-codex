#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { createCliStructuredLogger } from "../src/validation/cliLogger.js";
import {
  loadScenarioFromFile,
  loadScenariosFromDirectory,
  type EvaluationScenario,
} from "../src/eval/scenario.js";
import { runScenario, type EvaluationClient } from "../src/eval/runner.js";
import {
  aggregateCampaignMetrics,
  evaluateGates,
  type CampaignMetrics,
  type GateEvaluationResult,
  type GateThresholds,
  type ScenarioEvaluationSummary,
} from "../src/eval/metrics.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_SCENARIO_DIR = join(WORKSPACE_ROOT, "scenarios");
const BASE_FEATURE_OVERRIDES = Object.freeze({
  enableMcpIntrospection: true,
  enableResources: true,
  enableEventsBus: true,
});

interface CliOptions {
  runId?: string;
  runRoot?: string;
  scenarioPaths: string[];
  tags: string[];
  gateThresholds: GateThresholds;
  featureOverrides: Record<string, unknown>;
  traceSeed?: string;
  helpRequested: boolean;
  errors: string[];
}

/**
 * Sanitised options consumed by {@link runEvaluationCampaign}. The structure
 * mirrors {@link CliOptions} while enforcing a resolved run identifier so the
 * pure orchestrator logic can operate without depending on CLI defaults.
 */
export interface EvaluationCampaignOptions {
  /** Unique identifier associated with the evaluation run. */
  readonly runId: string;
  /** Optional directory where artefacts should be written. */
  readonly runRoot?: string;
  /** Explicit scenario definitions selected via the CLI. */
  readonly scenarioPaths: readonly string[];
  /** Tag filters constraining directory scans. */
  readonly tags: readonly string[];
  /** Gate thresholds enforced after aggregating campaign metrics. */
  readonly gateThresholds: GateThresholds;
  /** Runtime feature overrides forwarded to the MCP session. */
  readonly featureOverrides: Record<string, unknown>;
  /** Deterministic seed for trace identifiers, when provided. */
  readonly traceSeed?: string;
}

/**
 * Minimal set of directories produced by the validation harness. The
 * evaluation orchestrator only relies on the report path but surfacing the full
 * structure keeps the type faithful to the runtime contract.
 */
export interface EvaluationRunDirectories {
  readonly inputs: string;
  readonly outputs: string;
  readonly events: string;
  readonly logs: string;
  readonly artifacts: string;
  readonly report: string;
  readonly [key: string]: string;
}

/**
 * Runtime context shared across validation stages. The structure mirrors the
 * JavaScript implementation while remaining permissive enough for tests to
 * stub only the required properties.
 */
export interface EvaluationRunContext {
  readonly runId: string;
  readonly rootDir: string;
  readonly directories: EvaluationRunDirectories;
  readonly createTraceId: () => string;
  readonly [key: string]: unknown;
}

/**
 * Artefact recorder abstraction injected by the CLI. Tests commonly stub the
 * interface with lightweight objects, hence the index signature.
 */
export interface EvaluationRecorder {
  readonly [key: string]: unknown;
}

/**
 * Runtime guard ensuring the validation harness returns the expected run
 * context shape. The guard keeps the TypeScript compiler honest while providing
 * a fail-fast error when the JavaScript helpers drift from the documented
 * contract.
 */
function isEvaluationRunContext(value: unknown): value is EvaluationRunContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== "string" || typeof candidate.rootDir !== "string") {
    return false;
  }
  if (typeof candidate.createTraceId !== "function") {
    return false;
  }
  const directories = candidate.directories;
  if (!directories || typeof directories !== "object") {
    return false;
  }
  const report = (directories as Record<string, unknown>).report;
  return typeof report === "string";
}

/**
 * Dependencies required to execute an evaluation campaign. Tests supply stub
 * implementations to exercise orchestration logic without touching the real
 * MCP runtime, while the CLI wires the concrete implementations at runtime.
 */
export interface EvaluationCampaignDependencies {
  /** Absolute workspace root forwarded to the scenario runner. */
  readonly workspaceRoot: string;
  /** Builds the structured logger bridge used to surface progress messages. */
  createLogger(): { log: (message: string) => void; warn: (message: string) => void };
  /** Loads scenarios either from explicit paths or by scanning the workspace. */
  loadScenarios(input: { scenarioPaths: readonly string[]; tags: readonly string[] }): Promise<readonly EvaluationScenario[]>;
  /** Creates the recorder-friendly run context used to persist artefacts. */
  createRunContext(params: { runId: string; runRoot?: string; traceSeed?: string }): Promise<EvaluationRunContext>;
  /** Instantiates the artefact recorder tied to the current run context. */
  createRecorder(runContext: EvaluationRunContext): Promise<EvaluationRecorder>;
  /**
   * Connects to the MCP runtime for a given scenario. The helper receives the
   * scenario definition so tests can provide deterministic clients per case.
   */
  createMcpClient(params: {
    runContext: EvaluationRunContext;
    recorder: EvaluationRecorder;
    featureOverrides: Record<string, unknown>;
    scenario: EvaluationScenario;
  }): Promise<
    EvaluationClient & {
      close(): Promise<void>;
    }
  >;
  /** Persists per-scenario JSON reports for later inspection. */
  writeScenarioReport(
    runContext: EvaluationRunContext,
    index: number,
    summary: ScenarioEvaluationSummary,
    scenario: EvaluationScenario,
  ): Promise<string>;
  /** Writes the aggregated campaign summary and returns its path. */
  writeCampaignSummary(
    runContext: EvaluationRunContext,
    runId: string,
    summaries: readonly ScenarioEvaluationSummary[],
    overallMetrics: CampaignMetrics,
    gateMetrics: CampaignMetrics,
    gateResult: GateEvaluationResult,
  ): Promise<string>;
}

/**
 * Result returned by {@link runEvaluationCampaign}. The shape intentionally
 * mirrors the artefacts surfaced by the CLI to keep testing and automation in
 * lockstep.
 */
export interface EvaluationCampaignResult {
  /** Identifier of the executed campaign. */
  readonly runId: string;
  /** Scenario definitions considered during the run. */
  readonly scenarios: readonly EvaluationScenario[];
  /** Completed scenario summaries in evaluation order. */
  readonly summaries: readonly ScenarioEvaluationSummary[];
  /** Subset of summaries contributing to CI gates. */
  readonly gateSummaries: readonly ScenarioEvaluationSummary[];
  /** Aggregated metrics across every executed scenario. */
  readonly overallMetrics: CampaignMetrics | null;
  /** Aggregated metrics restricted to gate-eligible scenarios. */
  readonly gateMetrics: CampaignMetrics | null;
  /** Result of the CI gate evaluation (always successful when no scenarios ran). */
  readonly gateResult: GateEvaluationResult;
  /** Path to the Markdown summary when at least one scenario executed. */
  readonly summaryPath: string | null;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenarioPaths: [],
    tags: [],
    gateThresholds: { minSuccessRate: 1 },
    featureOverrides: {},
    helpRequested: false,
    errors: [],
  };

  function coerceValue(value: string): unknown {
    if (value === "true" || value === "false") {
      return value === "true";
    }
    if (value === "null") {
      return null;
    }
    if (value === "undefined") {
      return undefined;
    }
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && value.trim() !== "") {
      return numeric;
    }
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.helpRequested = true;
      continue;
    }

    const consumeValue = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        options.errors.push(`Missing value for ${token}`);
        return undefined;
      }
      return value;
    };

    switch (token) {
      case "--run-id": {
        const value = consumeValue();
        if (value) {
          options.runId = value;
        }
        break;
      }
      case "--run-root": {
        const value = consumeValue();
        if (value) {
          options.runRoot = resolve(value);
        }
        break;
      }
      case "--scenario": {
        const value = consumeValue();
        if (value) {
          options.scenarioPaths.push(resolve(value));
        }
        break;
      }
      case "--tag": {
        const value = consumeValue();
        if (value) {
          options.tags.push(value);
        }
        break;
      }
      case "--gate-success-rate": {
        const value = consumeValue();
        if (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
            options.gateThresholds.minSuccessRate = numeric;
          } else {
            options.errors.push(`Invalid success rate: ${value}`);
          }
        }
        break;
      }
      case "--gate-latency-p95": {
        const value = consumeValue();
        if (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric >= 0) {
            options.gateThresholds.maxLatencyP95Ms = numeric;
          } else {
            options.errors.push(`Invalid latency threshold: ${value}`);
          }
        }
        break;
      }
      case "--gate-max-tokens": {
        const value = consumeValue();
        if (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric >= 0) {
            options.gateThresholds.maxTokens = numeric;
          } else {
            options.errors.push(`Invalid token threshold: ${value}`);
          }
        }
        break;
      }
      case "--trace-seed": {
        const value = consumeValue();
        if (value) {
          options.traceSeed = value;
        }
        break;
      }
      case "--feature": {
        const value = consumeValue();
        if (value) {
          const [key, raw] = value.split("=", 2);
          if (!key || raw === undefined) {
            options.errors.push(`Invalid feature override "${value}". Expected key=value.`);
          } else {
            options.featureOverrides[key] = coerceValue(raw);
          }
        }
        break;
      }
      default: {
        if (token.startsWith("--feature=")) {
          const raw = token.slice("--feature=".length);
          const [key, rawValue] = raw.split("=", 2);
          if (!key || rawValue === undefined) {
            options.errors.push(`Invalid feature override "${raw}". Expected key=value.`);
          } else {
            options.featureOverrides[key] = coerceValue(rawValue);
          }
          break;
        }
        if (token.startsWith("--")) {
          options.errors.push(`Unknown option ${token}`);
        } else {
          options.errors.push(`Unexpected argument ${token}`);
        }
        break;
      }
    }
  }

  return options;
}

function printHelp(): void {
  const lines = [
    "Usage: node --import tsx scripts/eval.ts [options]",
    "",
    "Options:",
    "  --run-id <id>              Override the evaluation run identifier.",
    "  --run-root <path>          Directory where artefacts will be written.",
    "  --scenario <file>          Execute a specific scenario definition (repeatable).",
    "  --tag <tag>                Filter scenarios by tag (repeatable).",
    "  --gate-success-rate <n>    Minimal success rate expected (0-1).",
    "  --gate-latency-p95 <ms>    Maximum allowed p95 latency across gated scenarios.",
    "  --gate-max-tokens <n>      Maximum total tokens allowed across gated scenarios.",
    "  --feature key=value        Override runtime feature toggles (repeatable).",
    "  --trace-seed <value>       Deterministic seed for trace identifiers.",
    "  -h, --help                 Display this help message.",
  ];
  console.log(lines.join("\n"));
}

/** Loads scenarios from explicit paths or by scanning the default directory. */
async function loadScenarioDefinitions(input: {
  scenarioPaths: readonly string[];
  tags: readonly string[];
}): Promise<readonly EvaluationScenario[]> {
  if (input.scenarioPaths.length > 0) {
    const scenarios: EvaluationScenario[] = [];
    for (const path of input.scenarioPaths) {
      scenarios.push(await loadScenarioFromFile(path));
    }
    return scenarios;
  }
  return loadScenariosFromDirectory(DEFAULT_SCENARIO_DIR, { tags: input.tags });
}

async function createRunContext(params: {
  runId: string;
  runRoot?: string;
  traceSeed?: string;
}): Promise<EvaluationRunContext> {
  const { createRunContext: createValidationRunContext } = await import("./lib/validation/run-context.mjs");
  const runRoot = params.runRoot ?? join(WORKSPACE_ROOT, "evaluation_runs", params.runId);
  const context: unknown = await createValidationRunContext({
    runId: params.runId,
    workspaceRoot: WORKSPACE_ROOT,
    runRoot,
    traceSeed: params.traceSeed,
  });
  if (!isEvaluationRunContext(context)) {
    throw new TypeError("Validation run context is missing required properties.");
  }
  return context;
}

async function createRecorder(runContext: EvaluationRunContext): Promise<EvaluationRecorder> {
  const { ArtifactRecorder } = await import("./lib/validation/artifact-recorder.mjs");
  await mkdir(runContext.directories.report, { recursive: true });
  return new ArtifactRecorder(runContext) as EvaluationRecorder;
}

async function createMcpClient(params: {
  runContext: EvaluationRunContext;
  recorder: EvaluationRecorder;
  featureOverrides: Record<string, unknown>;
  scenario: EvaluationScenario;
}) {
  const { runContext, recorder, featureOverrides, scenario: _scenario } = params;
  void _scenario;
  const { McpSession } = await import("./lib/validation/mcp-session.mjs");
  const session = new McpSession({
    context: runContext,
    recorder,
    clientName: "eval-scenarios",
    clientVersion: "0.1.0",
    featureOverrides,
  });
  await session.open();
  return {
    async callTool(
      toolName: string,
      args: Record<string, unknown>,
      options?: { phaseId?: string; stepId?: string },
    ) {
      const call = await session.callTool(toolName, args, { phaseId: options?.phaseId ?? "eval" });
      return {
        toolName: call.toolName,
        traceId: call.traceId,
        durationMs: call.durationMs,
        response: call.response,
      };
    },
    async close() {
      await session.close();
    },
  };
}

function selectGateSummaries(
  summaries: readonly ScenarioEvaluationSummary[],
  scenarioById: Map<string, EvaluationScenario>,
): readonly ScenarioEvaluationSummary[] {
  const gated = summaries.filter((summary) => scenarioById.get(summary.scenarioId)?.tags.includes("critical"));
  return gated.length ? gated : summaries;
}

async function writeScenarioReport(
  runContext: EvaluationRunContext,
  index: number,
  summary: ScenarioEvaluationSummary,
  scenario: EvaluationScenario,
) {
  const payload = {
    scenario,
    summary,
  };
  const fileName = `${String(index + 1).padStart(3, "0")}-${scenario.id}.json`;
  const path = join(runContext.directories.report, fileName);
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

async function writeCampaignSummary(
  runContext: EvaluationRunContext,
  runId: string,
  summaries: readonly ScenarioEvaluationSummary[],
  overallMetrics: ReturnType<typeof aggregateCampaignMetrics>,
  gateMetrics: ReturnType<typeof aggregateCampaignMetrics>,
  gateResult: ReturnType<typeof evaluateGates>,
): Promise<string> {
  const lines = [
    `# Evaluation Summary — ${runId}`,
    "",
    "## Campagne",
    `- Scénarios exécutés : ${summaries.length}`,
    `- Réussites : ${overallMetrics.successCount} (${(overallMetrics.successRate * 100).toFixed(2)}%)`,
    `- Durée cumulée : ${overallMetrics.totalDurationMs.toFixed(2)} ms`,
    overallMetrics.p95LatencyMs !== null
      ? `- Latence p95 : ${overallMetrics.p95LatencyMs.toFixed(2)} ms`
      : "- Latence p95 : n/a",
    overallMetrics.totalTokens !== null
      ? `- Tokens cumulés : ${overallMetrics.totalTokens}`
      : "- Tokens cumulés : n/a",
    `- Appels outil : ${overallMetrics.totalToolCalls}`,
    "",
    "## CI Gate",
    gateResult.passed ? "- ✅ Seuils respectés" : "- ❌ Seuils violés",
  ];
  if (!gateResult.passed) {
    for (const violation of gateResult.violations) {
      lines.push(`  - ${violation}`);
    }
  }
  lines.push(
    "",
    "## Métriques (scénarios critiques)",
    `- Réussites : ${gateMetrics.successCount} (${(gateMetrics.successRate * 100).toFixed(2)}%)`,
    gateMetrics.p95LatencyMs !== null
      ? `- Latence p95 : ${gateMetrics.p95LatencyMs.toFixed(2)} ms`
      : "- Latence p95 : n/a",
    gateMetrics.totalTokens !== null
      ? `- Tokens cumulés : ${gateMetrics.totalTokens}`
      : "- Tokens cumulés : n/a",
  );
  lines.push("", "## Détail des scénarios");
  for (const summary of summaries) {
    const status = summary.success ? "✅" : "❌";
    const failure = summary.failureReasons.length ? ` — ${summary.failureReasons.join("; ")}` : "";
    lines.push(`- ${status} ${summary.scenarioId} (${summary.metrics.totalDurationMs.toFixed(2)} ms)${failure}`);
  }
  const path = join(runContext.directories.report, "summary.md");
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}

/**
 * Executes the evaluation workflow using the provided dependencies. The helper
 * mirrors the CLI behaviour while remaining test-friendly through dependency
 * injection.
 */
export async function runEvaluationCampaign(
  options: EvaluationCampaignOptions,
  dependencies: EvaluationCampaignDependencies,
): Promise<EvaluationCampaignResult> {
  const { log, warn } = dependencies.createLogger();
  const scenarios = await dependencies.loadScenarios({
    scenarioPaths: options.scenarioPaths,
    tags: options.tags,
  });

  if (scenarios.length === 0) {
    warn("Aucun scénario ne correspond aux filtres fournis.");
    return {
      runId: options.runId,
      scenarios,
      summaries: [],
      gateSummaries: [],
      overallMetrics: null,
      gateMetrics: null,
      gateResult: { passed: true, violations: [] },
      summaryPath: null,
    };
  }

  const runContext = await dependencies.createRunContext({
    runId: options.runId,
    runRoot: options.runRoot,
    traceSeed: options.traceSeed,
  });
  const recorder = await dependencies.createRecorder(runContext);

  const summaries: ScenarioEvaluationSummary[] = [];
  const scenarioById = new Map<string, EvaluationScenario>();
  scenarios.forEach((scenario) => scenarioById.set(scenario.id, scenario));

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    log(`Exécution du scénario ${scenario.id}…`);
    const featureOverrides = {
      ...BASE_FEATURE_OVERRIDES,
      ...options.featureOverrides,
      ...(scenario.featureOverrides ?? {}),
    };
    const client = await dependencies.createMcpClient({
      runContext,
      recorder,
      featureOverrides,
      scenario,
    });
    try {
      const summary = await runScenario(scenario, client, {
        phaseId: scenario.id,
        workspaceRoot: dependencies.workspaceRoot,
      });
      summaries.push(summary);
      await dependencies.writeScenarioReport(runContext, index, summary, scenario);
      if (summary.success) {
        log(`✅ ${scenario.id} réussi en ${summary.metrics.totalDurationMs.toFixed(2)} ms`);
      } else {
        warn(`❌ ${scenario.id} échec: ${summary.failureReasons.join("; ") || "motif inconnu"}`);
      }
    } finally {
      await client.close();
    }
  }

  const gateSummaries = selectGateSummaries(summaries, scenarioById);
  const overallMetrics = aggregateCampaignMetrics(summaries);
  const gateMetrics = aggregateCampaignMetrics(gateSummaries);
  const gateResult = evaluateGates(gateMetrics, options.gateThresholds);
  const summaryPath = await dependencies.writeCampaignSummary(
    runContext,
    options.runId,
    summaries,
    overallMetrics,
    gateMetrics,
    gateResult,
  );
  log(`Résumé écrit dans ${summaryPath}`);

  return {
    runId: options.runId,
    scenarios,
    summaries,
    gateSummaries,
    overallMetrics,
    gateMetrics,
    gateResult,
    summaryPath,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.helpRequested) {
    printHelp();
    return;
  }
  if (options.errors.length > 0) {
    for (const error of options.errors) {
      console.error(error);
    }
    console.error("Use --help to display the supported options.");
    process.exitCode = 64;
    return;
  }

  const runId = options.runId ?? `eval_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const result = await runEvaluationCampaign(
    {
      runId,
      runRoot: options.runRoot,
      scenarioPaths: options.scenarioPaths,
      tags: options.tags,
      gateThresholds: options.gateThresholds,
      featureOverrides: options.featureOverrides,
      traceSeed: options.traceSeed,
    },
    {
      workspaceRoot: WORKSPACE_ROOT,
      createLogger: () => {
        const { console: cliConsole } = createCliStructuredLogger("evaluation-scenarios");
        return { log: cliConsole.log, warn: cliConsole.warn };
      },
      loadScenarios: loadScenarioDefinitions,
      createRunContext,
      createRecorder,
      createMcpClient,
      writeScenarioReport,
      writeCampaignSummary,
    },
  );

  if (result.summaries.length > 0 && !result.gateResult.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
