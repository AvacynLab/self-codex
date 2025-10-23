#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createCliStructuredLogger } from "../src/validation/cliLogger.js";
import { executePlanCli, parsePlanCliOptions } from "../src/validation/plansCli.js";
import { PLAN_JSONL_FILES } from "../src/validation/plans.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/** Identifier used to namespace structured log messages for this CLI. */
const STAGE_ID = "plan_validation";

/**
 * Normalises the environment bag used by the planning stage before forwarding
 * it to the validation workflow. Keeping the helper exported lets the test
 * suite assert the sanitisation behaviour directly.
 */
export function preparePlanPhaseEnvironment(
  rawEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
}

/**
 * Runs the Stage 6 planning validation workflow with structured logging. The
 * helper remains reusable by tests so the script can be exercised without
 * spawning a child process.
 */
export async function runPlanPhase(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stageLogger = createCliStructuredLogger(STAGE_ID),
): Promise<void> {
  const { logger } = stageLogger;
  const sanitisedEnv = preparePlanPhaseEnvironment(env);

  try {
    const options = parsePlanCliOptions(argv);
    const { runRoot, result } = await executePlanCli(options, sanitisedEnv, stageLogger.console);

    logger.info("plan_validation.summary", {
      runRoot,
      graphId: result.summary.graphId ?? null,
      compileStatus: result.summary.compile.success,
      runBt: {
        status: result.summary.runBt.status ?? null,
        ticks: result.summary.runBt.ticks ?? null,
      },
      runReactive: {
        status: result.summary.runReactive.status ?? null,
        loopTicks: result.summary.runReactive.loopTicks ?? null,
        cancelled: result.summary.runReactive.cancelled ?? null,
        cancellationError: result.summary.runReactive.cancellationError ?? null,
      },
      lifecycle: result.summary.lifecycle.statusSnapshot ?? null,
      artefacts: {
        requests: join(runRoot, PLAN_JSONL_FILES.inputs),
        responses: join(runRoot, PLAN_JSONL_FILES.outputs),
        events: join(runRoot, PLAN_JSONL_FILES.events),
        httpLog: join(runRoot, PLAN_JSONL_FILES.log),
        summary: result.summaryPath,
      },
    });
  } catch (error) {
    logger.error("plan_validation.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await logger.flush();
  }
}

/** Executes the CLI when the module is run directly from Node.js. */
async function main(): Promise<void> {
  try {
    await runPlanPhase(process.argv.slice(2), process.env);
  } catch (error) {
    // The error has already been logged by {@link runPlanPhase}; propagate the
    // failure to the shell without emitting duplicate console output.
    process.exitCode = 1;
    if (error instanceof Error && process.env.DEBUG_PLAN_PHASE === "1") {
      // Developers occasionally need stack traces; gate them behind an opt-in
      // environment flag to avoid polluting automation logs.
      process.stderr.write(`${error.stack ?? error.message}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    process.exitCode = 1;
    if (process.env.DEBUG_PLAN_PHASE === "1") {
      const stack = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`${stack}\n`);
    }
  });
}
