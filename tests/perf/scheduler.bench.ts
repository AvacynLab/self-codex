import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SCHEDULER_BENCH_CONFIG,
  runSchedulerMicroBenchmark,
  type SchedulerBenchConfig,
  type SchedulerBenchResult,
} from "./scheduler.micro-bench.js";

/**
 * Comparison between baseline and stigmergic scheduler runs. The delta captures
 * absolute and relative improvements so developers can quickly detect
 * regressions when iterating locally.
 */
export interface SchedulerBenchmarkComparison {
  baseline: SchedulerBenchResult;
  stigmergy: SchedulerBenchResult;
  deltaElapsedMs: number;
  deltaAverageMsPerTick: number;
  relativeAverageImprovementPct: number;
}

/**
 * Parse benchmark overrides from environment variables while keeping sane
 * defaults when the caller does not customise the execution window.
 */
export function parseSchedulerBenchConfigFromEnv(): SchedulerBenchConfig {
  const parse = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value === null || value.trim().length === 0) {
      return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const defaults = DEFAULT_SCHEDULER_BENCH_CONFIG;
  return {
    iterations: Math.max(1, parse(process.env.SCHED_BENCH_ITERATIONS, defaults.iterations)),
    uniqueNodes: Math.max(1, parse(process.env.SCHED_BENCH_NODES, defaults.uniqueNodes)),
    logicalStepMs: Math.max(0, parse(process.env.SCHED_BENCH_STEP_MS, defaults.logicalStepMs)),
  } satisfies SchedulerBenchConfig;
}

/**
 * Execute the scheduler benchmark twice (baseline vs stigmergy) and compute the
 * resulting performance deltas.
 */
export async function compareSchedulerBenchmarks(
  config: SchedulerBenchConfig = DEFAULT_SCHEDULER_BENCH_CONFIG,
): Promise<SchedulerBenchmarkComparison> {
  const baseline = await runSchedulerMicroBenchmark(false, config);
  const stigmergy = await runSchedulerMicroBenchmark(true, config);
  const deltaElapsedMs = baseline.elapsedMs - stigmergy.elapsedMs;
  const deltaAverageMsPerTick = baseline.averageMsPerTick - stigmergy.averageMsPerTick;
  const relativeAverageImprovementPct = baseline.averageMsPerTick > 0
    ? (deltaAverageMsPerTick / baseline.averageMsPerTick) * 100
    : 0;

  return {
    baseline,
    stigmergy,
    deltaElapsedMs,
    deltaAverageMsPerTick,
    relativeAverageImprovementPct,
  };
}

/** Render a Markdown-friendly table summarising the benchmark comparison. */
export function renderSchedulerBenchmarkTable(
  comparison: SchedulerBenchmarkComparison,
): string {
  const header = ["scenario", "ticks", "elapsed_ms", "avg_ms_per_tick", "traces"].map((cell) => cell.padEnd(16)).join(" | ");
  const separator = "-".repeat(16 * 5 + 4 * 3);
  const formatRow = (result: SchedulerBenchResult): string =>
    [
      result.scenario.padEnd(16),
      result.ticks.toString().padEnd(16),
      result.elapsedMs.toFixed(2).padEnd(16),
      result.averageMsPerTick.toFixed(4).padEnd(16),
      result.tracesCaptured.toString().padEnd(16),
    ].join(" | ");
  const deltaRow = [
    "delta".padEnd(16),
    "".padEnd(16),
    comparison.deltaElapsedMs.toFixed(2).padEnd(16),
    comparison.deltaAverageMsPerTick.toFixed(4).padEnd(16),
    `${comparison.relativeAverageImprovementPct.toFixed(2)}%`.padEnd(16),
  ].join(" | ");
  return [header, separator, formatRow(comparison.baseline), formatRow(comparison.stigmergy), deltaRow].join("\n");
}

/**
 * When the module is executed directly it runs the comparison with environment
 * overrides and prints both the table and a short summary sentence.
 */
async function main(): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const invokedFile = process.argv[1] ? resolve(process.argv[1]) : null;
  if (!invokedFile || currentFile !== invokedFile) {
    return;
  }

  const config = parseSchedulerBenchConfigFromEnv();
  const comparison = await compareSchedulerBenchmarks(config);
  const table = renderSchedulerBenchmarkTable(comparison);

  // eslint-disable-next-line no-console -- CLI utility intended for local runs.
  console.log(table);

  const direction = comparison.deltaAverageMsPerTick >= 0 ? "faster" : "slower";
  const magnitude = Math.abs(comparison.relativeAverageImprovementPct).toFixed(2);
  const summary =
    comparison.relativeAverageImprovementPct === 0
      ? "No average latency change detected between baseline and stigmergy runs."
      : `Stigmergic scheduling is ${direction} by ${magnitude}% on average.`;
  // eslint-disable-next-line no-console -- CLI utility intended for local runs.
  console.log(`\n${summary}`);
}

void main();
