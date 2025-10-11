import { basename, dirname, join } from "node:path";

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
  const planOverrides = { ...(basePhaseOptions.plan ?? {}) };
  const reactiveOverrides: Record<string, unknown> = {
    ...(planOverrides.reactive ?? {}),
  };

  if (typeof options.tickMs === "number" && Number.isFinite(options.tickMs)) {
    reactiveOverrides.tickMs = options.tickMs;
  }
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)) {
    reactiveOverrides.timeoutMs = options.timeoutMs;
  }

  const phaseOptions: PlanPhaseOptions = {
    ...basePhaseOptions,
    plan: {
      ...planOverrides,
      reactive: Object.keys(reactiveOverrides).length ? (reactiveOverrides as { tickMs?: number; timeoutMs?: number }) : planOverrides.reactive,
    },
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
