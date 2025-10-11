import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  COORDINATION_JSONL_FILES,
  buildDefaultCoordinationCalls,
  runCoordinationPhase,
  type CoordinationPhaseOptions,
  type CoordinationPhaseResult,
} from "./coordination.js";

/** CLI flags recognised by the coordination validation workflow. */
export interface CoordinationCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root overriding `runId`/`baseDir`. */
  runRoot?: string;
  /** Optional Blackboard key override. */
  blackboardKey?: string;
  /** Optional Stigmergy domain override. */
  stigDomain?: string;
  /** Optional Contract-Net topic override. */
  contractTopic?: string;
  /** Optional consensus topic override. */
  consensusTopic?: string;
}

/** Lightweight logger abstraction used to surface console output. */
export interface CoordinationCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executeCoordinationCli}. */
export interface CoordinationCliOverrides {
  readonly phaseOptions?: CoordinationPhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: CoordinationPhaseOptions,
  ) => Promise<CoordinationPhaseResult>;
}

/** Parses CLI arguments emitted by `scripts/runCoordinationPhase.ts`. */
export function parseCoordinationCliOptions(argv: readonly string[]): CoordinationCliOptions {
  const options: CoordinationCliOptions = { baseDir: "runs" };

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
    } else if (token === "--bb-key" && index + 1 < argv.length) {
      options.blackboardKey = argv[index + 1];
      index += 1;
    } else if (token === "--stig-domain" && index + 1 < argv.length) {
      options.stigDomain = argv[index + 1];
      index += 1;
    } else if (token === "--contract-topic" && index + 1 < argv.length) {
      options.contractTopic = argv[index + 1];
      index += 1;
    } else if (token === "--consensus-topic" && index + 1 < argv.length) {
      options.consensusTopic = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeCoordinationCli}. */
export interface CoordinationCliResult {
  readonly runRoot: string;
  readonly result: CoordinationPhaseResult;
}

/** Executes the coordination validation workflow with CLI semantics. */
export async function executeCoordinationCli(
  options: CoordinationCliOptions,
  env: NodeJS.ProcessEnv,
  logger: CoordinationCliLogger,
  overrides: CoordinationCliOverrides = {},
): Promise<CoordinationCliResult> {
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

  logger.log(`→ Coordination validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const defaultCallsOverrides = {
    blackboardKey: options.blackboardKey,
    stigDomain: options.stigDomain,
    contractTopic: options.contractTopic,
    consensusTopic: options.consensusTopic,
  };

  const basePhaseOptions = overrides.phaseOptions ?? {};
  const hasCliOverrides = Object.values(defaultCallsOverrides).some((value) => value);
  const phaseOptions: CoordinationPhaseOptions =
    !basePhaseOptions.calls && hasCliOverrides
      ? {
          ...basePhaseOptions,
          calls: buildDefaultCoordinationCalls({
            ...(basePhaseOptions.coordination ?? {}),
            ...defaultCallsOverrides,
          }),
        }
      : basePhaseOptions;

  const runner = overrides.runner ?? runCoordinationPhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, COORDINATION_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, COORDINATION_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, COORDINATION_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, COORDINATION_JSONL_FILES.log)}`);
  logger.log(`   Summary: ${result.summaryPath}`);

  return { runRoot, result };
}
