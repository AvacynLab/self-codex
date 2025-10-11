import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
} from "./runSetup.js";
import {
  INTROSPECTION_JSONL_FILES,
  runIntrospectionPhase,
  type JsonRpcCallOutcome,
} from "./introspection.js";
import {
  buildIntrospectionSummary,
  persistIntrospectionSummary,
  type IntrospectionSummaryDocument,
} from "./introspectionSummary.js";

/**
 * Shape of the CLI arguments accepted by the introspection phase runner.
 *
 * The helper mirrors the conventions established by the preflight tooling:
 * `--run-id` targets the canonical `runs/<id>/` layout whereas `--run-root`
 * lets operators point to an arbitrary directory (useful when the run lives in
 * a custom location).
 */
export interface IntrospectionCliOptions {
  /** Optional identifier of the validation run (e.g. `validation_2025-10-10T16-03-31Z`). */
  runId?: string;
  /** Base directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Explicit absolute or relative path to the run root. */
  runRoot?: string;
}

/** Lightweight logger interface used so tests can capture human-readable output. */
export interface IntrospectionCliLogger {
  /** Standard output channel. */
  log: (...args: unknown[]) => void;
}

/**
 * Parses command-line arguments without relying on a third-party dependency.
 *
 * Unknown flags are ignored intentionally: the validation scripts are primarily
 * operated by humans and we prefer leniency over strict rejection. Future
 * enhancements can extend the recognised switches without breaking existing
 * automation.
 */
export function parseIntrospectionCliOptions(argv: readonly string[]): IntrospectionCliOptions {
  const options: IntrospectionCliOptions = { baseDir: "runs" };

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
    }
  }

  return options;
}

/** Aggregated result returned by {@link executeIntrospectionCli}. */
export interface IntrospectionCliResult {
  /** Absolute path to the validation run directory used for persistence. */
  runRoot: string;
  /** Detailed HTTP snapshots emitted by {@link runIntrospectionPhase}. */
  outcomes: JsonRpcCallOutcome[];
  /** Aggregated summary persisted under `report/introspection_summary.json`. */
  summary: IntrospectionSummaryDocument;
}

/**
 * Executes the introspection phase end-to-end using CLI semantics.
 *
 * The helper takes care of initialising the run directory, collecting the
 * target MCP endpoint from environment variables, invoking
 * {@link runIntrospectionPhase}, and surfacing a concise progress report via
 * `logger.log`. Returning the raw outcomes enables higher-level automation to
 * perform additional checks (e.g. verifying response schemas) without needing
 * to reimplement the orchestration logic.
 */
export async function executeIntrospectionCli(
  options: IntrospectionCliOptions,
  env: NodeJS.ProcessEnv,
  logger: IntrospectionCliLogger,
): Promise<IntrospectionCliResult> {
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

  logger.log(`→ Introspection run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const outcomes = await runIntrospectionPhase(runRoot, environment);
  const summary = buildIntrospectionSummary(outcomes);
  const summaryPath = await persistIntrospectionSummary(runRoot, summary);

  logger.log(`   Recorded ${outcomes.length} calls into:`);
  logger.log(`     • Requests: ${join(runRoot, INTROSPECTION_JSONL_FILES.inputs)}`);
  logger.log(`     • Responses: ${join(runRoot, INTROSPECTION_JSONL_FILES.outputs)}`);
  logger.log(`     • Events: ${join(runRoot, INTROSPECTION_JSONL_FILES.events)}`);
  logger.log(`     • Summary: ${summaryPath}`);

  return { runRoot, outcomes, summary };
}
