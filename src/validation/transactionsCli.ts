import { basename, dirname, join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
} from "./runSetup.js";
import {
  buildDefaultTransactionCalls,
  runTransactionsPhase,
  TRANSACTIONS_JSONL_FILES,
  type TransactionCallOutcome,
} from "./transactions.js";

/**
 * CLI options recognised by the transactions validation workflow.
 */
export interface TransactionsCliOptions {
  /** Optional identifier of the validation run (e.g. `validation_2025-10-10`). */
  runId?: string;
  /** Base directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Explicit absolute or relative path to the run root. */
  runRoot?: string;
}

/** Minimal logger abstraction used so tests can capture console output. */
export interface TransactionsCliLogger {
  log: (...args: unknown[]) => void;
}

/**
 * Parses the CLI arguments accepted by the transactions phase script.
 *
 * Unknown flags are intentionally ignored to keep the interface forgiving
 * during manual validation sessions.
 */
export function parseTransactionsCliOptions(argv: readonly string[]): TransactionsCliOptions {
  const options: TransactionsCliOptions = { baseDir: "runs" };

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

/** Aggregated result returned by {@link executeTransactionsCli}. */
export interface TransactionsCliResult {
  /** Absolute path to the validation run directory used for persistence. */
  runRoot: string;
  /** Detailed outcomes emitted by {@link runTransactionsPhase}. */
  outcomes: TransactionCallOutcome[];
}

/**
 * Executes the transactions validation stage end-to-end using CLI semantics.
 */
export async function executeTransactionsCli(
  options: TransactionsCliOptions,
  env: NodeJS.ProcessEnv,
  logger: TransactionsCliLogger,
): Promise<TransactionsCliResult> {
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

  logger.log(`→ Transactions run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const calls = buildDefaultTransactionCalls();
  const outcomes = await runTransactionsPhase(runRoot, environment, calls);

  logger.log(`   Executed ${outcomes.length} calls.`);
  logger.log(`   Requests JSONL: ${join(runRoot, TRANSACTIONS_JSONL_FILES.inputs)}`);
  logger.log(`   Responses JSONL: ${join(runRoot, TRANSACTIONS_JSONL_FILES.outputs)}`);
  logger.log(`   Events JSONL: ${join(runRoot, TRANSACTIONS_JSONL_FILES.events)}`);
  logger.log(`   HTTP snapshot log: ${join(runRoot, TRANSACTIONS_JSONL_FILES.log)}`);

  return { runRoot, outcomes };
}
