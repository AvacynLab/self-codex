import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

import type { EvaluationScenario } from "./scenario.js";
import {
  computeScenarioMetrics,
  computeTranscriptDigest,
  describeOracle,
  evaluateConstraints,
  type OracleEvaluationResult,
  type ScenarioEvaluationSummary,
  type ScenarioStepResult,
} from "./metrics.js";

/** Structure returned by the evaluation client for each MCP call. */
export interface EvaluationClientCallResult {
  readonly toolName: string;
  readonly traceId?: string | null;
  readonly durationMs?: number;
  readonly response?: {
    readonly isError?: boolean;
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly structuredContent?: unknown;
    readonly metadata?: Record<string, unknown> | null;
  } | null;
}

/** Interface implemented by adapters capable of executing scenario steps. */
export interface EvaluationClient {
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: { phaseId?: string; stepId?: string },
  ): Promise<EvaluationClientCallResult>;
}

/** Optional knobs controlling the scenario execution. */
export interface ScenarioRunOptions {
  /** Identifier forwarded to MCP traces; defaults to the scenario identifier. */
  readonly phaseId?: string;
  /** Optional deterministic clock used by tests. */
  readonly now?: () => Date;
  /** Workspace root used to resolve script-based oracles. */
  readonly workspaceRoot?: string;
  /** Whether execution should continue after a failing step (default: false). */
  readonly continueOnFailure?: boolean;
}

/**
 * Executes a single scenario against the provided client. The function collects
 * latency metrics, evaluates oracles, and validates constraints before
 * returning a structured summary suitable for reports and CI gates.
 */
export async function runScenario(
  scenario: EvaluationScenario,
  client: EvaluationClient,
  options: ScenarioRunOptions = {},
): Promise<ScenarioEvaluationSummary> {
  const now = options.now ?? (() => new Date());
  const startedAtInstant = now();
  const stepResults: ScenarioStepResult[] = [];
  const observedTools: string[] = [];
  let aggregatedText = "";
  const failureReasons: string[] = [];
  let executionFailed = false;

  for (const step of scenario.steps) {
    const callStarted = process.hrtime.bigint();
    let callResult: EvaluationClientCallResult | null = null;
    let errorMessage: string | undefined;
    let traceId: string | null = null;

    try {
      callResult = await client.callTool(step.tool, step.arguments ?? {}, {
        phaseId: options.phaseId ?? scenario.id,
        stepId: step.id,
      });
      traceId = callResult.traceId ?? null;
    } catch (error) {
      traceId = typeof (error as any)?.traceId === "string" ? (error as any).traceId : null;
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const durationMs = callResult?.durationMs ?? Number(process.hrtime.bigint() - callStarted) / 1_000_000;
    const response = callResult?.response ?? null;
    const textOutput = collectText(response);
    const structuredOutput = response?.structuredContent ?? null;
    if (textOutput) {
      aggregatedText += `${textOutput}\n`;
    }
    if (callResult) {
      observedTools.push(callResult.toolName);
    } else {
      observedTools.push(step.tool);
    }

    const expectation = step.expect ?? { success: true };
    const shouldSucceed = expectation.success ?? true;
    const callSucceeded = Boolean(callResult && !response?.isError && !errorMessage);
    let stepSuccess = shouldSucceed ? callSucceeded : !callSucceeded;
    const stepMessages: string[] = [];

    if (!callResult && errorMessage) {
      stepMessages.push(errorMessage);
    }

    if (stepSuccess && expectation.match) {
      const regex = normaliseRegex(expectation.match);
      if (!regex.test(textOutput)) {
        stepSuccess = false;
        stepMessages.push(`texte ne correspond pas à ${regex}`);
      }
    }

    if (stepSuccess && expectation.notMatch) {
      const regex = normaliseRegex(expectation.notMatch);
      if (regex.test(textOutput)) {
        stepSuccess = false;
        stepMessages.push(`texte contient motif interdit ${regex}`);
      }
    }

    if (stepSuccess && (expectation.minItems !== undefined || expectation.maxItems !== undefined)) {
      const itemsLength = extractItemsLength(structuredOutput);
      if (expectation.minItems !== undefined && itemsLength < expectation.minItems) {
        stepSuccess = false;
        stepMessages.push(`items ${itemsLength} < min ${expectation.minItems}`);
      }
      if (expectation.maxItems !== undefined && itemsLength > expectation.maxItems) {
        stepSuccess = false;
        stepMessages.push(`items ${itemsLength} > max ${expectation.maxItems}`);
      }
    }

    const tokensConsumed = extractTokenUsage(response);
    const result: ScenarioStepResult = {
      step,
      traceId,
      durationMs,
      success: stepSuccess,
      message: stepMessages.length ? stepMessages.join("; ") : errorMessage,
      textOutput,
      structuredOutput,
      tokensConsumed,
    };
    stepResults.push(result);

    if (!stepSuccess) {
      executionFailed = true;
      failureReasons.push(`étape ${step.id}: ${result.message ?? "échec"}`);
      if (!options.continueOnFailure) {
        break;
      }
    }
  }

  const metrics = computeScenarioMetrics(stepResults);
  const oracles = await evaluateOracles({
    scenario,
    aggregatedText,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    stepResults,
  });
  for (const oracle of oracles) {
    if (!oracle.success) {
      failureReasons.push(`oracle ${oracle.label}: ${oracle.message ?? "échec"}`);
      executionFailed = true;
    }
  }

  const constraintViolations = evaluateConstraints(scenario, metrics, observedTools);
  if (constraintViolations.length) {
    failureReasons.push(...constraintViolations.map((violation) => `contrainte: ${violation}`));
    executionFailed = true;
  }

  const finishedAtInstant = now();
  const transcript = aggregatedText.trimEnd();
  const summary: ScenarioEvaluationSummary = {
    scenarioId: scenario.id,
    success: !executionFailed,
    failureReasons,
    steps: stepResults,
    oracles,
    constraintViolations,
    metrics,
    startedAt: startedAtInstant.toISOString(),
    finishedAt: finishedAtInstant.toISOString(),
    transcript,
    transcriptDigest: computeTranscriptDigest(transcript),
  };

  return summary;
}

/** Normalises regex configuration into a RegExp instance. */
function normaliseRegex(config: { pattern: string; flags?: string } | string): RegExp {
  if (typeof config === "string") {
    return new RegExp(config, "m");
  }
  return new RegExp(config.pattern, config.flags ?? "m");
}

/** Extracts concatenated text segments from an MCP response. */
function collectText(response: EvaluationClientCallResult["response"] | null): string {
  if (!response?.content) {
    return "";
  }
  const segments = response.content
    .filter((item) => typeof item?.text === "string")
    .map((item) => String(item?.text));
  return segments.join("\n");
}

/** Retrieves the number of items returned in a structured payload. */
function extractItemsLength(structured: unknown): number {
  if (structured && typeof structured === "object" && "items" in structured) {
    const items = (structured as { items?: unknown }).items;
    if (Array.isArray(items)) {
      return items.length;
    }
  }
  return 0;
}

/** Attempts to extract the total token usage from the response metadata. */
function extractTokenUsage(response: EvaluationClientCallResult["response"] | null): number | null {
  const cost = (response as any)?.metadata?.cost;
  if (cost && typeof cost === "object") {
    const total = (cost as any).totalTokens ?? (cost as any).tokensTotal ?? (cost as any).total;
    if (typeof total === "number" && Number.isFinite(total)) {
      return total;
    }
  }
  return null;
}

/** Evaluates each oracle and returns a structured outcome. */
async function evaluateOracles(params: {
  scenario: EvaluationScenario;
  aggregatedText: string;
  workspaceRoot: string;
  stepResults: readonly ScenarioStepResult[];
}): Promise<OracleEvaluationResult[]> {
  const results: OracleEvaluationResult[] = [];
  for (const oracle of params.scenario.oracles) {
    const label = describeOracle(oracle);
    if (oracle.type === "regex") {
      const regex = new RegExp(oracle.pattern, oracle.flags ?? "m");
      const success = regex.test(params.aggregatedText);
      results.push({
        label,
        success,
        message: success ? undefined : "motif absent du transcript",
      });
      continue;
    }

    try {
      const modulePath = resolve(params.workspaceRoot, oracle.module);
      const module = await import(pathToFileURL(modulePath).href);
      const exported = oracle.exportName ? module[oracle.exportName] : module.validate ?? module.default;
      if (typeof exported !== "function") {
        results.push({
          label,
          success: false,
          message: `fonction ${oracle.exportName ?? "validate"} introuvable`,
        });
        continue;
      }
      await Promise.resolve(exported({
        scenario: params.scenario,
        transcript: params.aggregatedText,
        steps: params.stepResults,
      }));
      results.push({ label, success: true });
    } catch (error) {
      results.push({
        label,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

