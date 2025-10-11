import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  GRAPH_FORGE_JSONL_FILES,
  runGraphForgePhase,
  type GraphForgePhaseOptions,
  type GraphForgePhaseResult,
} from "./graphForge.js";

/**
 * CLI flags recognised by the Graph Forge validation workflow. The options keep
 * parity with other validation stages so operators can orchestrate end-to-end
 * runs using consistent switches.
 */
export interface GraphForgeCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing the validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root (bypasses `runId`/`baseDir` resolution). */
  runRoot?: string;
  /** Interval forwarded to the autosave tool (milliseconds). */
  autosaveIntervalMs?: number;
  /** Number of ticks required before the workflow stops autosave. */
  autosaveTicks?: number;
  /** Polling cadence for the autosave observer (milliseconds). */
  autosavePollMs?: number;
  /** Timeout enforced by the autosave observer (milliseconds). */
  autosaveTimeoutMs?: number;
}

/** Lightweight logger abstraction mirrored from other CLI helpers. */
export interface GraphForgeCliLogger {
  log: (...args: unknown[]) => void;
}

/**
 * Optional overrides consumed by {@link executeGraphForgeCli}. Tests use the
 * hook to inject deterministic observers while production callers rely on the
 * default behaviour.
 */
export interface GraphForgeCliOverrides {
  readonly phaseOptions?: GraphForgePhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: GraphForgePhaseOptions,
  ) => Promise<GraphForgePhaseResult>;
}

/**
 * Parses CLI arguments passed to the Graph Forge validation entrypoint. Unknown
 * flags are ignored to remain forgiving during exploratory sessions.
 */
export function parseGraphForgeCliOptions(argv: readonly string[]): GraphForgeCliOptions {
  const options: GraphForgeCliOptions = { baseDir: "runs" };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-id" && index + 1 < argv.length) {
      options.runId = argv[index + 1];
      index += 1;
    } else if (token === "--base-dir" && index + 1 < argv.length) {
      options.baseDir = argv[index + 1];
      index += 1;
    } else if (token === "--run-root" && index + 1 < argv.length) {
      options.runRoot = argv[index + 1];
      index += 1;
    } else if (token === "--autosave-interval-ms" && index + 1 < argv.length) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (!Number.isNaN(parsed)) {
        options.autosaveIntervalMs = parsed;
      }
      index += 1;
    } else if (token === "--autosave-ticks" && index + 1 < argv.length) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (!Number.isNaN(parsed)) {
        options.autosaveTicks = parsed;
      }
      index += 1;
    } else if (token === "--autosave-poll-ms" && index + 1 < argv.length) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (!Number.isNaN(parsed)) {
        options.autosavePollMs = parsed;
      }
      index += 1;
    } else if (token === "--autosave-timeout-ms" && index + 1 < argv.length) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (!Number.isNaN(parsed)) {
        options.autosaveTimeoutMs = parsed;
      }
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeGraphForgeCli}. */
export interface GraphForgeCliResult {
  /** Absolute validation run directory used for artefact persistence. */
  readonly runRoot: string;
  /** Structured outcome returned by {@link runGraphForgePhase}. */
  readonly result: GraphForgePhaseResult;
}

/**
 * Orchestrates the Graph Forge validation stage end-to-end using CLI semantics.
 */
export async function executeGraphForgeCli(
  options: GraphForgeCliOptions,
  env: NodeJS.ProcessEnv,
  logger: GraphForgeCliLogger,
  overrides: GraphForgeCliOverrides = {},
): Promise<GraphForgeCliResult> {
  const environment = collectHttpEnvironment(env);

  let runRoot: string;
  let runId: string;

  if (options.runRoot) {
    const baseDir = dirname(options.runRoot);
    runId = basename(options.runRoot);
    runRoot = await ensureRunStructure(baseDir, runId);
  } else {
    runId = options.runId ?? generateValidationRunId();
    runRoot = await ensureRunStructure(options.baseDir, runId);
  }

  logger.log(`→ Graph Forge run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions = overrides.phaseOptions ?? {};
  const phaseOptions: GraphForgePhaseOptions = {
    ...basePhaseOptions,
    workspaceRoot: basePhaseOptions.workspaceRoot ?? process.cwd(),
    autosaveIntervalMs: options.autosaveIntervalMs ?? basePhaseOptions.autosaveIntervalMs,
    autosaveObservation: {
      ...basePhaseOptions.autosaveObservation,
      requiredTicks: options.autosaveTicks ?? basePhaseOptions.autosaveObservation?.requiredTicks,
      pollIntervalMs: options.autosavePollMs ?? basePhaseOptions.autosaveObservation?.pollIntervalMs,
      timeoutMs: options.autosaveTimeoutMs ?? basePhaseOptions.autosaveObservation?.timeoutMs,
    },
  };

  const runner = overrides.runner ?? runGraphForgePhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, GRAPH_FORGE_JSONL_FILES.log)}`);
  logger.log(`   Analysis DSL: ${result.analysis.dslPath}`);
  logger.log(`   Analysis report: ${result.analysis.resultPath}`);
  logger.log(`   Autosave summary: ${result.autosave.summaryPath}`);

  return { runRoot, result };
}
