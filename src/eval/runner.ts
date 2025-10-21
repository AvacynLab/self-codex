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
      traceId = extractTraceId(error);
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
    const message = stepMessages.length ? stepMessages.join("; ") : errorMessage;
    const result: ScenarioStepResult = {
      step,
      traceId,
      durationMs,
      success: stepSuccess,
      ...(message !== undefined ? { message } : {}),
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
  if (hasItemsCollection(structured)) {
    const { items } = structured;
    if (Array.isArray(items)) {
      return items.length;
    }
  }
  return 0;
}

/** Attempts to extract the total token usage from the response metadata. */
function extractTokenUsage(response: EvaluationClientCallResult["response"] | null): number | null {
  if (!response || !isRecord(response.metadata)) {
    return null;
  }

  const { cost } = response.metadata;
  if (!isCostMetadata(cost)) {
    return null;
  }

  const candidates: ReadonlyArray<unknown> = [cost.totalTokens, cost.tokensTotal, cost.total];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
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
      const message = success ? undefined : "motif absent du transcript";
      results.push({
        label,
        success,
        ...(message !== undefined ? { message } : {}),
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

/**
 * Safely retrieves a trace identifier from arbitrary thrown values. Some
 * transport adapters attach the identifier to non-Error objects, hence the
 * defensive type guards.
 */
function extractTraceId(candidate: unknown): string | null {
  if (!hasTraceIdentifier(candidate)) {
    return null;
  }
  return typeof candidate.traceId === "string" ? candidate.traceId : null;
}

/** Narrows values exposing an `items` collection to compute array sizes. */
function hasItemsCollection(value: unknown): value is { readonly items?: unknown } {
  return typeof value === "object" && value !== null && "items" in value;
}

/** Guards `Record<string, unknown>` structures coming from user-controlled metadata. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Ensures the token cost metadata exposes recognised numeric fields before the
 * runner attempts to interpret them.
 */
function isCostMetadata(value: unknown): value is {
  readonly totalTokens?: unknown;
  readonly tokensTotal?: unknown;
  readonly total?: unknown;
} {
  return typeof value === "object" && value !== null;
}

/** Type predicate guarding thrown values exposing a `traceId` field. */
function hasTraceIdentifier(value: unknown): value is { readonly traceId?: unknown } {
  return typeof value === "object" && value !== null && "traceId" in value;
}

