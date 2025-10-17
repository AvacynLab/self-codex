import { createHash } from "node:crypto";

import type { EvaluationScenario, ScenarioStep } from "./scenario.js";

/**
 * Result captured for a single MCP tool invocation while executing a scenario.
 * The runner records latency, token usage (when available), and helpful context
 * for debugging failures.
 */
export interface ScenarioStepResult {
  /** Step definition executed by the harness. */
  readonly step: ScenarioStep;
  /** Identifier returned by the MCP runtime for traceability. */
  readonly traceId: string | null;
  /** Wall-clock duration (milliseconds) measured for the call. */
  readonly durationMs: number;
  /** Whether the invocation satisfied the configured expectations. */
  readonly success: boolean;
  /** Optional diagnostic message describing the failure reason. */
  readonly message?: string;
  /** Extracted textual response used for regex assertions. */
  readonly textOutput: string;
  /** Structured payload returned by the MCP tool (if any). */
  readonly structuredOutput: unknown;
  /** Token cost reported by the runtime when available. */
  readonly tokensConsumed: number | null;
}

/**
 * Aggregated outcome computed after a scenario finishes executing. Downstream
 * reporting and CI gates use this shape to render summaries and detect
 * regressions.
 */
export interface ScenarioEvaluationSummary {
  /** Unique identifier associated with the evaluated scenario. */
  readonly scenarioId: string;
  /** Whether the scenario satisfied all checks (steps, oracles, constraints). */
  readonly success: boolean;
  /** Collected explanations for each failure encountered during the run. */
  readonly failureReasons: readonly string[];
  /** Detailed per-step results (preserves execution order). */
  readonly steps: readonly ScenarioStepResult[];
  /**
   * Oracle evaluations executed after the scenario completed. Each entry keeps a
   * human readable label to aid debugging when an oracle fails.
   */
  readonly oracles: readonly OracleEvaluationResult[];
  /** Constraint violations triggered by the measured metrics. */
  readonly constraintViolations: readonly string[];
  /** Latency and cost statistics derived from the step results. */
  readonly metrics: ScenarioMetrics;
  /** ISO-8601 timestamp marking the beginning of the run. */
  readonly startedAt: string;
  /** ISO-8601 timestamp marking the end of the run. */
  readonly finishedAt: string;
  /** Aggregated textual transcript captured from the tool responses. */
  readonly transcript: string;
  /** Hash of the aggregated textual output for reproducibility checks. */
  readonly transcriptDigest: string;
}

/**
 * Result describing the evaluation of an oracle (regex or script). Keeping a
 * stable label simplifies reporting and gating.
 */
export interface OracleEvaluationResult {
  readonly label: string;
  readonly success: boolean;
  readonly message?: string;
}

/**
 * Collection of metrics derived from the raw scenario execution artefacts.
 * Values are rounded to avoid leaking excessive precision in reports.
 */
export interface ScenarioMetrics {
  readonly totalDurationMs: number;
  readonly averageLatencyMs: number;
  readonly p95LatencyMs: number | null;
  readonly p99LatencyMs: number | null;
  readonly maxLatencyMs: number;
  readonly totalTokens: number | null;
  readonly toolCalls: number;
}

/**
 * Aggregate statistics computed across a campaign (multiple scenarios). The
 * harness uses this structure to feed CI gates and generate run summaries.
 */
export interface CampaignMetrics {
  readonly scenarioCount: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly totalDurationMs: number;
  readonly p95LatencyMs: number | null;
  readonly totalTokens: number | null;
  readonly totalToolCalls: number;
}

/**
 * Thresholds enforced by CI gates. All values are optional so callers can focus
 * on the dimensions relevant to their pipelines.
 */
export interface GateThresholds {
  readonly minSuccessRate?: number;
  readonly maxLatencyP95Ms?: number;
  readonly maxTokens?: number;
}

/** Outcome of the gate evaluation. */
export interface GateEvaluationResult {
  readonly passed: boolean;
  readonly violations: readonly string[];
}

/** Computes the sum of tokens while gracefully handling missing telemetry. */
export function sumTokens(results: readonly ScenarioStepResult[]): number | null {
  let total = 0;
  let found = false;
  for (const result of results) {
    if (typeof result.tokensConsumed === "number") {
      total += result.tokensConsumed;
      found = true;
    }
  }
  return found ? total : null;
}

/** Computes an interpolated percentile over the provided dataset. */
export function computePercentile(samples: readonly number[], percentile: number): number | null {
  if (!samples.length) {
    return null;
  }
  if (samples.length === 1) {
    return samples[0];
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (percentile / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const fraction = rank - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction;
}

/**
 * Computes latency and token metrics for a scenario run.
 */
export function computeScenarioMetrics(stepResults: readonly ScenarioStepResult[]): ScenarioMetrics {
  const durations = stepResults.map((step) => step.durationMs);
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const averageLatencyMs = durations.length ? totalDurationMs / durations.length : 0;
  const p95LatencyMs = computePercentile(durations, 95);
  const p99LatencyMs = computePercentile(durations, 99);
  const maxLatencyMs = durations.length ? Math.max(...durations) : 0;
  const totalTokens = sumTokens(stepResults);
  return {
    totalDurationMs,
    averageLatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    maxLatencyMs,
    totalTokens,
    toolCalls: stepResults.length,
  };
}

/**
 * Validates scenario-level constraints (latency budget, token ceiling, required
 * tools) against the collected metrics. Violations are returned as human-readable
 * strings that can be surfaced in reports or CI logs.
 */
export function evaluateConstraints(
  scenario: EvaluationScenario,
  metrics: ScenarioMetrics,
  observedTools: readonly string[],
): readonly string[] {
  const violations: string[] = [];
  const constraints = scenario.constraints;
  if (constraints.maxDurationMs !== undefined && metrics.totalDurationMs > constraints.maxDurationMs) {
    violations.push(`durée ${metrics.totalDurationMs.toFixed(1)}ms > budget ${constraints.maxDurationMs}ms`);
  }
  if (constraints.maxToolCalls !== undefined && metrics.toolCalls > constraints.maxToolCalls) {
    violations.push(`outil x${metrics.toolCalls} > limite ${constraints.maxToolCalls}`);
  }
  if (constraints.maxTokens !== undefined && metrics.totalTokens !== null && metrics.totalTokens > constraints.maxTokens) {
    violations.push(`tokens ${metrics.totalTokens} > budget ${constraints.maxTokens}`);
  }
  if (constraints.requiredTools && constraints.requiredTools.length > 0) {
    for (const tool of constraints.requiredTools) {
      if (!observedTools.includes(tool)) {
        violations.push(`outil requis absent: ${tool}`);
      }
    }
  }
  return violations;
}

/**
 * Computes aggregated campaign metrics from individual scenario summaries. The
 * helper ignores scenarios that did not execute any steps to avoid skewing
 * latencies with empty datasets.
 */
export function aggregateCampaignMetrics(summaries: readonly ScenarioEvaluationSummary[]): CampaignMetrics {
  const executedSummaries = summaries.filter((summary) => summary.steps.length > 0);
  const durations = executedSummaries.flatMap((summary) => summary.steps.map((step) => step.durationMs));
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const p95LatencyMs = computePercentile(durations, 95);
  const totalTokensArray = executedSummaries
    .map((summary) => summary.metrics.totalTokens)
    .filter((value): value is number => typeof value === "number");
  const totalTokens = totalTokensArray.length ? totalTokensArray.reduce((sum, value) => sum + value, 0) : null;
  const totalToolCalls = executedSummaries.reduce((sum, summary) => sum + summary.metrics.toolCalls, 0);
  const successCount = summaries.filter((summary) => summary.success).length;

  return {
    scenarioCount: summaries.length,
    successCount,
    successRate: summaries.length ? successCount / summaries.length : 0,
    totalDurationMs,
    p95LatencyMs,
    totalTokens,
    totalToolCalls,
  };
}

/**
 * Evaluates CI gates using the aggregated metrics. Violations are returned as a
 * descriptive array so callers can surface all problems at once.
 */
export function evaluateGates(metrics: CampaignMetrics, thresholds: GateThresholds): GateEvaluationResult {
  const violations: string[] = [];
  if (thresholds.minSuccessRate !== undefined && metrics.successRate < thresholds.minSuccessRate) {
    violations.push(
      `taux de succès ${formatPercent(metrics.successRate)} < seuil ${formatPercent(thresholds.minSuccessRate)}`,
    );
  }
  if (thresholds.maxLatencyP95Ms !== undefined && metrics.p95LatencyMs !== null && metrics.p95LatencyMs > thresholds.maxLatencyP95Ms) {
    violations.push(`latence p95 ${metrics.p95LatencyMs.toFixed(2)}ms > seuil ${thresholds.maxLatencyP95Ms}ms`);
  }
  if (thresholds.maxTokens !== undefined && metrics.totalTokens !== null && metrics.totalTokens > thresholds.maxTokens) {
    violations.push(`tokens ${metrics.totalTokens} > seuil ${thresholds.maxTokens}`);
  }
  return { passed: violations.length === 0, violations };
}

/** Formats a floating point ratio as a percentage with two decimals. */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Produces a stable digest of the aggregated transcript so changes can be
 * highlighted without storing megabytes of raw text in reports.
 */
export function computeTranscriptDigest(text: string): string {
  const hash = createHash("sha256");
  hash.update(text, "utf8");
  return hash.digest("hex");
}

/** Utility building a human-readable label for an oracle definition. */
export function describeOracle(oracle: { type: string; description?: string; module?: string; pattern?: string }): string {
  if (oracle.description) {
    return oracle.description;
  }
  if (oracle.type === "script" && oracle.module) {
    return `script:${oracle.module}`;
  }
  if (oracle.type === "regex" && oracle.pattern) {
    return `regex:${oracle.pattern}`;
  }
  return oracle.type;
}
