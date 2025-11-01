import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  PERFORMANCE_JSONL_FILES,
  runPerformancePhase,
  type DefaultPerformanceOptions,
  type PerformancePhaseOptions,
  type PerformancePhaseResult,
} from "./performance.js";
import { omitUndefinedEntries } from "../utils/object.js";

/** CLI flags recognised by the Stage 10 performance validation workflow. */
export interface PerformanceCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root overriding `runId`/`baseDir`. */
  runRoot?: string;
  /** Number of lightweight samples recorded for percentile computation. */
  sampleSize?: number;
  /** Number of concurrent requests dispatched during the throughput burst. */
  concurrencyBurst?: number;
  /** MCP tool name invoked by the latency probes. */
  toolName?: string;
  /** Text payload forwarded to the default `tools/call` latency probe. */
  toolText?: string;
  /** Absolute or relative path to the HTTP log inspected for growth. */
  logPath?: string;
}

/** Lightweight logger abstraction used to surface console output. */
export interface PerformanceCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executePerformanceCli}. */
export interface PerformanceCliOverrides {
  readonly phaseOptions?: PerformancePhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: PerformancePhaseOptions,
  ) => Promise<PerformancePhaseResult>;
}

/** Parses CLI arguments emitted by `scripts/runPerformancePhase.ts`. */
export function parsePerformanceCliOptions(argv: readonly string[]): PerformanceCliOptions {
  const options: PerformanceCliOptions = { baseDir: "validation_run" };

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
    } else if (token === "--sample-size" && index + 1 < argv.length) {
      options.sampleSize = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (token === "--concurrency" && index + 1 < argv.length) {
      options.concurrencyBurst = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (token === "--tool-name" && index + 1 < argv.length) {
      options.toolName = argv[index + 1];
      index += 1;
    } else if (token === "--tool-text" && index + 1 < argv.length) {
      options.toolText = argv[index + 1];
      index += 1;
    } else if (token === "--log-path" && index + 1 < argv.length) {
      options.logPath = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executePerformanceCli}. */
export interface PerformanceCliResult {
  readonly runRoot: string;
  readonly result: PerformancePhaseResult;
}

/** Executes the performance validation workflow with CLI semantics. */
export async function executePerformanceCli(
  options: PerformanceCliOptions,
  env: NodeJS.ProcessEnv,
  logger: PerformanceCliLogger,
  overrides: PerformanceCliOverrides = {},
): Promise<PerformanceCliResult> {
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

  logger.log(`→ Performance validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions: PerformancePhaseOptions = overrides.phaseOptions ?? {};
  const { performance: basePerformanceOption, ...restBaseOptions } = basePhaseOptions;
  type MutablePerformanceOptions = { -readonly [K in keyof DefaultPerformanceOptions]?: DefaultPerformanceOptions[K] };
  const overrideAccumulator: MutablePerformanceOptions = { ...(basePerformanceOption ?? {}) };

  if (typeof options.sampleSize === "number" && Number.isFinite(options.sampleSize)) {
    overrideAccumulator.sampleSize = options.sampleSize;
  }
  if (typeof options.concurrencyBurst === "number" && Number.isFinite(options.concurrencyBurst)) {
    overrideAccumulator.concurrencyBurst = options.concurrencyBurst;
  }
  if (typeof options.toolName === "string" && options.toolName.trim()) {
    overrideAccumulator.toolName = options.toolName.trim();
  }
  if (typeof options.toolText === "string" && options.toolText.trim()) {
    overrideAccumulator.toolText = options.toolText;
  }
  if (typeof options.logPath === "string" && options.logPath.trim()) {
    overrideAccumulator.logPath = options.logPath;
  }

  const mergedPerformance = omitUndefinedEntries(overrideAccumulator) as DefaultPerformanceOptions;

  const phaseOptions: PerformancePhaseOptions = {
    ...restBaseOptions,
    ...(Object.keys(mergedPerformance).length > 0 ? { performance: mergedPerformance } : {}),
  };

  const runner = overrides.runner ?? runPerformancePhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, PERFORMANCE_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, PERFORMANCE_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, PERFORMANCE_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, PERFORMANCE_JSONL_FILES.log)}`);
  logger.log(`   Summary: ${result.summaryPath}`);

  return { runRoot, result };
}
