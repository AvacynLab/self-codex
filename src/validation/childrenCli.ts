import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import { omitUndefinedEntries } from "../utils/object.js";
import {
  CHILDREN_JSONL_FILES,
  runChildrenPhase,
  type ChildPhaseOptions,
  type ChildrenPhaseResult,
} from "./children.js";

/** CLI flags recognised by the children validation workflow. */
export interface ChildrenCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root overriding `runId`/`baseDir`. */
  runRoot?: string;
  /** Goal forwarded to `child_spawn_codex`. */
  goal?: string;
  /** Prompt propagated to `child_send`. */
  prompt?: string;
}

/** Lightweight logger abstraction used to surface console output. */
export interface ChildrenCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executeChildrenCli}. */
export interface ChildrenCliOverrides {
  readonly phaseOptions?: ChildPhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: ChildPhaseOptions,
  ) => Promise<ChildrenPhaseResult>;
}

/**
 * Parses CLI arguments emitted by `scripts/runChildrenPhase.ts`.
 *
 * Unknown flags are ignored intentionally to keep the tool forgiving during
 * exploratory validation sessions. New switches can therefore be introduced in
 * subsequent iterations without breaking existing automation.
 */
export function parseChildrenCliOptions(argv: readonly string[]): ChildrenCliOptions {
  const options: ChildrenCliOptions = { baseDir: "runs" };

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
    } else if (token === "--goal" && index + 1 < argv.length) {
      options.goal = argv[index + 1];
      index += 1;
    } else if (token === "--prompt" && index + 1 < argv.length) {
      options.prompt = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeChildrenCli}. */
export interface ChildrenCliResult {
  readonly runRoot: string;
  readonly result: ChildrenPhaseResult;
}

/** Executes the child validation workflow with CLI semantics. */
export async function executeChildrenCli(
  options: ChildrenCliOptions,
  env: NodeJS.ProcessEnv,
  logger: ChildrenCliLogger,
  overrides: ChildrenCliOverrides = {},
): Promise<ChildrenCliResult> {
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

  logger.log(`→ Children validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions = overrides.phaseOptions ?? {};
  const planOverrides = { ...(basePhaseOptions.plan ?? {}) };
  if (options.goal) {
    planOverrides.goal = options.goal;
  }
  if (options.prompt) {
    planOverrides.prompt = options.prompt;
  }

  const plan = Object.keys(planOverrides).length ? planOverrides : basePhaseOptions.plan;
  // NOTE: The CLI only forwards optional overrides when explicitly provided. We
  // filter out the remaining `undefined` placeholders so the eventual
  // `ChildPhaseOptions` complies with `exactOptionalPropertyTypes`.
  const phaseOptions: ChildPhaseOptions = {
    ...omitUndefinedEntries({ ...basePhaseOptions }),
    ...omitUndefinedEntries({ plan }),
  };

  const runner = overrides.runner ?? runChildrenPhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, CHILDREN_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, CHILDREN_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, CHILDREN_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, CHILDREN_JSONL_FILES.log)}`);
  logger.log(`   Summary: ${result.summaryPath}`);
  if (result.conversationPath) {
    logger.log(`   Conversation transcript: ${result.conversationPath}`);
  }

  return { runRoot, result };
}
