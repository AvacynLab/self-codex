import { basename, dirname, join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  SECURITY_JSONL_FILES,
  runSecurityPhase,
  type DefaultSecurityOptions,
  type SecurityPhaseOptions,
  type SecurityPhaseResult,
} from "./security.js";

/** CLI flags recognised by the Stage 11 security validation workflow. */
export interface SecurityCliOptions {
  runId?: string;
  baseDir: string;
  runRoot?: string;
  secretText?: string;
  redactionTool?: string;
  unauthorizedMethod?: string;
  pathTool?: string;
  pathAttempt?: string;
}

/** Lightweight logger abstraction surfaced for tests. */
export interface SecurityCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executeSecurityCli}. */
export interface SecurityCliOverrides {
  readonly phaseOptions?: SecurityPhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: SecurityPhaseOptions,
  ) => Promise<SecurityPhaseResult>;
}

/** Parses CLI arguments emitted by `scripts/runSecurityPhase.ts`. */
export function parseSecurityCliOptions(argv: readonly string[]): SecurityCliOptions {
  const options: SecurityCliOptions = { baseDir: "runs" };

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
    } else if (token === "--secret-text" && index + 1 < argv.length) {
      options.secretText = argv[index + 1];
      index += 1;
    } else if (token === "--redaction-tool" && index + 1 < argv.length) {
      options.redactionTool = argv[index + 1];
      index += 1;
    } else if ((token === "--unauthorised-method" || token === "--unauthorized-method") && index + 1 < argv.length) {
      options.unauthorizedMethod = argv[index + 1];
      index += 1;
    } else if (token === "--path-tool" && index + 1 < argv.length) {
      options.pathTool = argv[index + 1];
      index += 1;
    } else if (token === "--path-attempt" && index + 1 < argv.length) {
      options.pathAttempt = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeSecurityCli}. */
export interface SecurityCliResult {
  readonly runRoot: string;
  readonly result: SecurityPhaseResult;
}

/** Executes the security validation workflow with CLI semantics. */
export async function executeSecurityCli(
  options: SecurityCliOptions,
  env: NodeJS.ProcessEnv,
  logger: SecurityCliLogger,
  overrides: SecurityCliOverrides = {},
): Promise<SecurityCliResult> {
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

  logger.log(`→ Security validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions: SecurityPhaseOptions = overrides.phaseOptions ?? {};
  type MutableDefaults = { -readonly [K in keyof DefaultSecurityOptions]?: DefaultSecurityOptions[K] };
  const mergedDefaults: MutableDefaults = { ...(basePhaseOptions.defaults ?? {}) };

  if (typeof options.secretText === "string" && options.secretText.length) {
    mergedDefaults.secretText = options.secretText;
  }
  if (typeof options.redactionTool === "string" && options.redactionTool.length) {
    mergedDefaults.redactionTool = options.redactionTool;
  }
  if (typeof options.unauthorizedMethod === "string" && options.unauthorizedMethod.length) {
    mergedDefaults.unauthorizedMethod = options.unauthorizedMethod;
  }
  if (typeof options.pathTool === "string" && options.pathTool.length) {
    mergedDefaults.pathTool = options.pathTool;
  }
  if (typeof options.pathAttempt === "string" && options.pathAttempt.length) {
    mergedDefaults.pathAttempt = options.pathAttempt;
  }

  const defaults = Object.keys(mergedDefaults).length
    ? (mergedDefaults as DefaultSecurityOptions)
    : basePhaseOptions.defaults;

  const phaseOptions: SecurityPhaseOptions = {
    ...basePhaseOptions,
    defaults,
  };

  const runner = overrides.runner ?? runSecurityPhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log(`   Requests JSONL: ${join(runRoot, SECURITY_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, SECURITY_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, SECURITY_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, SECURITY_JSONL_FILES.log)}`);
  logger.log(`   Summary: ${result.summaryPath}`);

  if (result.summary.redaction) {
    const probe = result.summary.redaction;
    logger.log(
      `   • Redaction probe (${probe.secret}): leaks=${probe.calls.filter((call) => call.leakedInResponse || call.leakedInEvents).length}`,
    );
  }
  if (result.summary.unauthorized) {
    const failures = result.summary.unauthorized.calls.filter((call) => call.success);
    logger.log(`   • Unauthorized checks blocked: ${failures.length}/${result.summary.unauthorized.calls.length}`);
  }
  if (result.summary.pathValidation) {
    logger.log(`   • Path probes executed: ${result.summary.pathValidation.calls.length}`);
  }

  return { runRoot, result };
}
