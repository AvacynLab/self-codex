import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  ROBUSTNESS_JSONL_FILES,
  runRobustnessPhase,
  type DefaultRobustnessOptions,
  type RobustnessPhaseOptions,
  type RobustnessPhaseResult,
} from "./robustness.js";

/** CLI flags recognised by the robustness validation workflow. */
export interface RobustnessCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root overriding `runId`/`baseDir`. */
  runRoot?: string;
  /** Override the idempotency key reused across `tx_begin` calls. */
  idempotencyKey?: string;
  /** Override the timeout forwarded to the reactive plan run (milliseconds). */
  reactiveTimeoutMs?: number;
}

/** Lightweight logger abstraction used to surface console output. */
export interface RobustnessCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executeRobustnessCli}. */
export interface RobustnessCliOverrides {
  readonly phaseOptions?: RobustnessPhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: RobustnessPhaseOptions,
  ) => Promise<RobustnessPhaseResult>;
}

/** Parses CLI arguments emitted by `scripts/runRobustnessPhase.ts`. */
export function parseRobustnessCliOptions(argv: readonly string[]): RobustnessCliOptions {
  const options: RobustnessCliOptions = { baseDir: "validation_run" };

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
    } else if (token === "--idempotency-key" && index + 1 < argv.length) {
      options.idempotencyKey = argv[index + 1];
      index += 1;
    } else if (token === "--timeout-ms" && index + 1 < argv.length) {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(value)) {
        options.reactiveTimeoutMs = value;
      }
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeRobustnessCli}. */
export interface RobustnessCliResult {
  readonly runRoot: string;
  readonly result: RobustnessPhaseResult;
}

/** Executes the robustness validation workflow with CLI semantics. */
export async function executeRobustnessCli(
  options: RobustnessCliOptions,
  env: NodeJS.ProcessEnv,
  logger: RobustnessCliLogger,
  overrides: RobustnessCliOverrides = {},
): Promise<RobustnessCliResult> {
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

  logger.log(`→ Robustness validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions = overrides.phaseOptions ?? {};
  const baseDefaults = basePhaseOptions.defaults ?? {};
  const overrideDefaults: DefaultRobustnessOptions = {
    ...(typeof options.idempotencyKey === "string" && options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
    ...(typeof options.reactiveTimeoutMs === "number" &&
    Number.isFinite(options.reactiveTimeoutMs)
      ? { reactiveTimeoutMs: options.reactiveTimeoutMs }
      : {}),
  };

  const mergedDefaults =
    Object.keys({ ...baseDefaults, ...overrideDefaults }).length > 0
      ? ({ ...baseDefaults, ...overrideDefaults } as DefaultRobustnessOptions)
      : undefined;

  const phaseOptions: RobustnessPhaseOptions = {
    ...basePhaseOptions,
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to optional
    // properties, so we only forward the defaults block when it carries data.
    ...(mergedDefaults ? { defaults: mergedDefaults } : {}),
  };

  const runner = overrides.runner ?? runRobustnessPhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, ROBUSTNESS_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, ROBUSTNESS_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, ROBUSTNESS_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, ROBUSTNESS_JSONL_FILES.log)}`);
  logger.log(`   Summary: ${result.summaryPath}`);
  if (result.summary.idempotency) {
    logger.log(
      `   Idempotency consistent: ${result.summary.idempotency.consistent ? "yes" : "no"}`,
    );
  }
  if (result.summary.crashSimulation) {
    logger.log(
      `   Crash events captured: ${result.summary.crashSimulation.eventCount}`,
    );
  }
  if (result.summary.timeout) {
    logger.log(
      `   Timeout status token: ${result.summary.timeout.statusToken ?? "<missing>"}`,
    );
  }

  return { runRoot, result };
}
