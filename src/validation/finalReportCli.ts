import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { collectHttpEnvironment, ensureRunStructure, generateValidationRunId } from "./runSetup.js";
import {
  runFinalReport,
  FINAL_REPORT_FINDINGS_FILENAME,
  FINAL_REPORT_RECOMMENDATIONS_FILENAME,
  FINAL_REPORT_SUMMARY_FILENAME,
  type FinalReportOptions,
  type FinalReportResult,
} from "./finalReport.js";
import { omitUndefinedEntries } from "../utils/object.js";

/** CLI flags recognised by the final report workflow. */
export interface FinalReportCliOptions {
  /** Optional validation run identifier (defaults to `validation_<timestamp>`). */
  readonly runId?: string;
  /** Directory containing the validation runs (`runs` by default). */
  readonly baseDir: string;
  /** Optional absolute path overriding the computed run root. */
  readonly runRoot?: string;
}

/** Console logger abstraction mirroring the other validation CLIs. */
export interface FinalReportCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides accepted by {@link executeFinalReportCli}. */
export interface FinalReportCliOverrides {
  readonly options?: FinalReportOptions;
  readonly runner?: (runRoot: string, options?: FinalReportOptions) => Promise<FinalReportResult>;
}

/** Parses CLI arguments emitted by `scripts/runFinalReportStage.ts`. */
export function parseFinalReportCliOptions(argv: readonly string[]): FinalReportCliOptions {
  const options: { runId?: string; baseDir: string; runRoot?: string } = { baseDir: "validation_run" };

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

/** Result returned by {@link executeFinalReportCli}. */
export interface FinalReportCliResult {
  readonly runRoot: string;
  readonly result: FinalReportResult;
}

/** Executes the final report aggregation workflow with CLI semantics. */
export async function executeFinalReportCli(
  options: FinalReportCliOptions,
  env: NodeJS.ProcessEnv,
  logger: FinalReportCliLogger,
  overrides: FinalReportCliOverrides = {},
): Promise<FinalReportCliResult> {
  const environment = collectHttpEnvironment(env);

  let runRoot: string;
  let runId: string;

  if (options.runRoot) {
    runRoot = await ensureRunStructure(dirname(options.runRoot), basename(options.runRoot));
    runId = basename(runRoot);
  } else {
    runId = options.runId ?? generateValidationRunId();
    runRoot = await ensureRunStructure(options.baseDir, runId);
  }

  logger.log(`→ Validation report run: ${runId}`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const runner =
    overrides.runner ?? ((root: string, finalOptions?: FinalReportOptions) => runFinalReport(root, finalOptions));

  // The CLI only forwards override options when tests explicitly provide them. Sanitising the
  // structure prevents `undefined` placeholders from leaking into the final report workflow once
  // `exactOptionalPropertyTypes` is fully enforced.
  const sanitisedOptions = (() => {
    if (!overrides.options) {
      return undefined;
    }

    const trimmed = omitUndefinedEntries({
      now: overrides.options.now,
      expectedToolsOverride: overrides.options.expectedToolsOverride,
      packageJsonPath: overrides.options.packageJsonPath,
    });
    return Object.keys(trimmed).length > 0 ? (trimmed as FinalReportOptions) : undefined;
  })();

  const result = await runner(runRoot, sanitisedOptions);

  logger.log(`   Findings JSON: ${join(runRoot, "report", FINAL_REPORT_FINDINGS_FILENAME)}`);
  logger.log(`   Summary Markdown: ${join(runRoot, "report", FINAL_REPORT_SUMMARY_FILENAME)}`);
  logger.log(`   Recommendations: ${join(runRoot, "report", FINAL_REPORT_RECOMMENDATIONS_FILENAME)}`);

  return { runRoot, result };
}

