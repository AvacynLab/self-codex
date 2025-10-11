import { basename, dirname, join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import {
  KNOWLEDGE_JSONL_FILES,
  runKnowledgePhase,
  type DefaultKnowledgeOptions,
  type KnowledgePhaseOptions,
  type KnowledgePhaseResult,
} from "./knowledge.js";

/** CLI flags recognised by the knowledge & values validation workflow. */
export interface KnowledgeCliOptions {
  /** Optional validation run identifier (`validation_<timestamp>` when omitted). */
  runId?: string;
  /** Directory containing validation runs (`runs` by default). */
  baseDir: string;
  /** Optional absolute run root overriding `runId`/`baseDir`. */
  runRoot?: string;
  /** Optional custom prompt forwarded to `kg_assist`. */
  assistQuery?: string;
  /** Optional topic forwarded to `values_explain`. */
  valuesTopic?: string;
}

/** Lightweight logger abstraction used to surface console output. */
export interface KnowledgeCliLogger {
  log: (...args: unknown[]) => void;
}

/** Optional overrides consumed by {@link executeKnowledgeCli}. */
export interface KnowledgeCliOverrides {
  readonly phaseOptions?: KnowledgePhaseOptions;
  readonly runner?: (
    runRoot: string,
    environment: HttpEnvironmentSummary,
    options: KnowledgePhaseOptions,
  ) => Promise<KnowledgePhaseResult>;
}

/** Parses CLI arguments emitted by `scripts/runKnowledgePhase.ts`. */
export function parseKnowledgeCliOptions(argv: readonly string[]): KnowledgeCliOptions {
  const options: KnowledgeCliOptions = { baseDir: "runs" };

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
    } else if (token === "--assist-query" && index + 1 < argv.length) {
      options.assistQuery = argv[index + 1];
      index += 1;
    } else if (token === "--values-topic" && index + 1 < argv.length) {
      options.valuesTopic = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

/** Result returned by {@link executeKnowledgeCli}. */
export interface KnowledgeCliResult {
  readonly runRoot: string;
  readonly result: KnowledgePhaseResult;
}

/** Executes the knowledge validation workflow with CLI semantics. */
export async function executeKnowledgeCli(
  options: KnowledgeCliOptions,
  env: NodeJS.ProcessEnv,
  logger: KnowledgeCliLogger,
  overrides: KnowledgeCliOverrides = {},
): Promise<KnowledgeCliResult> {
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

  logger.log(`→ Knowledge validation run: ${runId} (${runRoot})`);
  logger.log(`   Target: ${environment.baseUrl}`);

  const basePhaseOptions = overrides.phaseOptions ?? {};
  const mergedKnowledge: Record<string, unknown> = {
    ...(basePhaseOptions.knowledge ?? {}),
  };

  if (typeof options.assistQuery === "string" && options.assistQuery.length > 0) {
    mergedKnowledge.assistQuery = options.assistQuery;
  }
  if (typeof options.valuesTopic === "string" && options.valuesTopic.length > 0) {
    mergedKnowledge.valuesTopic = options.valuesTopic;
  }

  const knowledgeOption =
    Object.keys(mergedKnowledge).length > 0
      ? (mergedKnowledge as DefaultKnowledgeOptions)
      : basePhaseOptions.knowledge;

  const phaseOptions: KnowledgePhaseOptions = {
    ...basePhaseOptions,
    knowledge: knowledgeOption,
  };

  const runner = overrides.runner ?? runKnowledgePhase;
  const result = await runner(runRoot, environment, phaseOptions);

  logger.log("🧠 Knowledge validation summary:");
  logger.log(`   • assist query: ${result.summary.knowledge.assistQuery ?? "unknown"}`);
  logger.log(`   • plan steps: ${result.summary.knowledge.planSteps ?? 0}`);
  logger.log(`   • values topic: ${result.summary.values.topic ?? "unknown"}`);
  logger.log(
    `   • explanation consistent: ${result.summary.values.explanationConsistent ? "yes" : "no"}`,
  );

  logger.log(`📚 Requests log: ${join(runRoot, KNOWLEDGE_JSONL_FILES.inputs)}`);
  logger.log(`📤 Responses log: ${join(runRoot, KNOWLEDGE_JSONL_FILES.outputs)}`);
  logger.log(`📡 Events log: ${join(runRoot, KNOWLEDGE_JSONL_FILES.events)}`);
  logger.log(`🗂️ HTTP snapshots: ${join(runRoot, KNOWLEDGE_JSONL_FILES.log)}`);
  if (result.summary.artefacts.valuesGraphExport) {
    logger.log(`🧾 Values graph export: ${result.summary.artefacts.valuesGraphExport}`);
  }
  if (result.summary.artefacts.causalExport) {
    logger.log(`🧾 Values causal export: ${result.summary.artefacts.causalExport}`);
  }
  logger.log(`📝 Summary: ${result.summaryPath}`);

  return { runRoot, result };
}
