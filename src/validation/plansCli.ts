import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  PLAN_JSONL_FILES,
  runPlanPhase,
  type PlanPhaseOptions,
  type PlanPhaseResult,
  type DefaultPlanOptions,
} from "./plans.js";

/** CLI flags recognised by the Behaviour Tree planning validation workflow. */
export interface PlanCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root overriding `runId`/`baseDir`. */
  runRoot?: string;
  /** Tick cadence (milliseconds) forwarded to `plan_run_reactive`. */
  tickMs?: number;
  /** Timeout (milliseconds) for the reactive execution. */
  timeoutMs?: number;
}

/** Lightweight logger abstraction used to surface console output. */
export interface PlanCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executePlanCli}. */
export interface PlanCliOverrides {
  readonly phaseOptions?: PlanPhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: PlanPhaseOptions,
  ) => Promise<PlanPhaseResult>;
}

/** Parses CLI arguments emitted by `scripts/runPlanPhase.ts`. */
export function parsePlanCliOptions(argv: readonly string[]): PlanCliOptions {
  const options: PlanCliOptions = { baseDir: "runs" };

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
    } else if (token === "--tick-ms" && index + 1 < argv.length) {
      options.tickMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (token === "--timeout-ms" && index + 1 < argv.length) {
      options.timeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executePlanCli}. */
export interface PlanCliResult {
  readonly runRoot: string;
  readonly result: PlanPhaseResult;
}

/** Executes the planning validation workflow with CLI semantics. */
export async function executePlanCli(
  options: PlanCliOptions,
  env: NodeJS.ProcessEnv,
  logger: PlanCliLogger,
  overrides: PlanCliOverrides = {},
): Promise<PlanCliResult> {
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

  logger.log(`→ Plans validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions = overrides.phaseOptions ?? {};
  const clonedPlan = clonePlanOptions(basePhaseOptions.plan);
  const cliReactiveOverrides = buildReactiveOverridesFromCli(options);
  const mergedReactive = mergeReactiveOptions(clonedPlan?.reactive, cliReactiveOverrides);

  let mergedPlan = clonedPlan;
  if (mergedReactive) {
    mergedPlan = { ...(mergedPlan ?? {}), reactive: mergedReactive };
  }

  const phaseOptions: PlanPhaseOptions = {
    ...(basePhaseOptions.calls ? { calls: basePhaseOptions.calls } : {}),
    ...(mergedPlan && Object.keys(mergedPlan).length > 0 ? { plan: mergedPlan } : {}),
  };

  const runner = overrides.runner ?? runPlanPhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, PLAN_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, PLAN_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, PLAN_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, PLAN_JSONL_FILES.log)}`);
  logger.log(`   Summary: ${result.summaryPath}`);

  return { runRoot, result };
}

/**
 * Produces a sanitised clone of the provided plan options, omitting any fields
 * set to `undefined` so subsequent spreads respect strict optional semantics.
 */
function clonePlanOptions(options: DefaultPlanOptions | undefined): DefaultPlanOptions | undefined {
  if (!options) {
    return undefined;
  }

  let clone: DefaultPlanOptions | undefined;
  if (options.graph !== undefined) {
    clone = { ...(clone ?? {}), graph: options.graph };
  }
  if (options.variables !== undefined) {
    clone = { ...(clone ?? {}), variables: options.variables };
  }
  if (options.reactive) {
    let reactive: DefaultPlanOptions["reactive"] | undefined;
    if (options.reactive.tickMs !== undefined) {
      reactive = { ...(reactive ?? {}), tickMs: options.reactive.tickMs };
    }
    if (options.reactive.timeoutMs !== undefined) {
      reactive = { ...(reactive ?? {}), timeoutMs: options.reactive.timeoutMs };
    }
    if (reactive) {
      clone = { ...(clone ?? {}), reactive };
    }
  }

  return clone;
}

/**
 * Extracts CLI-provided reactive overrides while filtering out invalid or
 * non-finite values.
 */
function buildReactiveOverridesFromCli(
  options: PlanCliOptions,
): DefaultPlanOptions["reactive"] | undefined {
  let overrides: DefaultPlanOptions["reactive"] | undefined;
  if (typeof options.tickMs === "number" && Number.isFinite(options.tickMs)) {
    overrides = { ...(overrides ?? {}), tickMs: options.tickMs };
  }
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)) {
    overrides = { ...(overrides ?? {}), timeoutMs: options.timeoutMs };
  }

  return overrides;
}

/**
 * Merges the base reactive configuration with CLI overrides, returning
 * `undefined` when both sources are empty to avoid surfacing meaningless
 * objects in the generated phase options.
 */
function mergeReactiveOptions(
  base: DefaultPlanOptions["reactive"] | undefined,
  overrides: DefaultPlanOptions["reactive"] | undefined,
): DefaultPlanOptions["reactive"] | undefined {
  if (!base && !overrides) {
    return undefined;
  }
  return { ...(base ?? {}), ...(overrides ?? {}) };
}
