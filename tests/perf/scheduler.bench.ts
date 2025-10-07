import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BehaviorTreeInterpreter } from "../../src/executor/bt/interpreter.js";
import {
  ReactiveScheduler,
  type SchedulerEventName,
  type TaskReadyEvent,
} from "../../src/executor/reactiveScheduler.js";
import { ManualClock, ScriptedNode } from "../helpers/reactiveSchedulerTestUtils.js";

import {
  DEFAULT_SCHEDULER_BENCH_CONFIG,
  runSchedulerMicroBenchmark,
  type SchedulerBenchConfig,
  type SchedulerBenchResult,
} from "./scheduler.micro-bench.js";

/**
 * Target average runtime (ms) expected for each fairness/stigmergy micro-bench
 * invocation. This threshold mirrors the checklist requirement which mandates a
 * <8ms bound on the scheduler heuristics when executed locally.
 */
const FAIRNESS_TARGET_MS = 8;

/** Number of iterations executed for each fairness micro-benchmark scenario. */
const FAIRNESS_ITERATIONS = 50_000;

/**
 * Internal structure exposing the scheduler queue for benchmarking purposes.
 * The shape mirrors the runtime {@link ScheduledTick} structure but only keeps
 * the fields required for the fairness and pheromone tests.
 */
interface SchedulerInternals {
  readonly queue: Array<{
    id: number;
    event: SchedulerEventName;
    payload: TaskReadyEvent;
    enqueuedAt: number;
    basePriority: number;
    causalEventId?: string | null;
  }>;
  readonly computeBasePriority: (
    event: SchedulerEventName,
    payload: TaskReadyEvent,
  ) => number;
  readonly selectNextIndex: (now: number) => number;
  readonly rebalancePheromone: (nodeId: string, intensity: number) => void;
}

/** Sample captured by the fairness bench, storing the average runtime. */
export interface SchedulerFairnessSample {
  readonly label: string;
  readonly averageMs: number;
}

/**
 * Benchmark helper that executes the provided callback a fixed number of times
 * and returns its average runtime. The iteration index is forwarded so callers
 * can vary their inputs and avoid JIT shortcuts that would not occur in real
 * workloads.
 */
function runFairnessBenchmark(label: string, callback: (iteration: number) => void): SchedulerFairnessSample {
  const start = performance.now();
  for (let iteration = 0; iteration < FAIRNESS_ITERATIONS; iteration += 1) {
    callback(iteration);
  }
  const end = performance.now();
  return { label, averageMs: (end - start) / FAIRNESS_ITERATIONS };
}

/** Formats fairness samples into a Markdown table ready to paste in notes. */
export function renderSchedulerFairnessSamples(samples: SchedulerFairnessSample[]): string {
  const header = "| benchmark | average (ms) | target (ms) |\n|-----------|--------------|-------------|";
  const rows = samples.map((sample) => {
    return `| ${sample.label} | ${sample.averageMs.toFixed(4)} | ${FAIRNESS_TARGET_MS.toFixed(2)} |`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Ensures micro-benchmark samples stay within the acceptable threshold. Throwing
 * keeps the script honest when executed in CI even though it primarily targets
 * local performance checks.
 */
function assertFairnessSample(sample: SchedulerFairnessSample): void {
  if (sample.averageMs > FAIRNESS_TARGET_MS) {
    throw new Error(
      `${sample.label} average ${sample.averageMs.toFixed(4)}ms exceeds target ${FAIRNESS_TARGET_MS.toFixed(2)}ms`,
    );
  }
}

/**
 * Builds a scheduler wired to a manual clock so the fairness bench can age
 * entries deterministically without relying on real timers.
 */
function createSchedulerForFairness(): {
  scheduler: ReactiveScheduler;
  clock: ManualClock;
  internals: SchedulerInternals;
} {
  const clock = new ManualClock();
  const scripted = new ScriptedNode("bench", Array.from({ length: 4 }, () => ({ status: "running" as const })));
  const interpreter = new BehaviorTreeInterpreter(scripted);
  const scheduler = new ReactiveScheduler({
    interpreter,
    runtime: {
      invokeTool: async () => undefined,
      now: () => clock.now(),
      wait: (ms) => clock.wait(ms),
      variables: {},
    },
    now: () => clock.now(),
    ageWeight: 0.01,
    agingHalfLifeMs: 250,
    agingFairnessBoost: 40,
    getPheromoneIntensity: () => 6,
    getPheromoneBounds: () => ({
      minIntensity: 0,
      maxIntensity: 12,
      normalisationCeiling: 8,
    }),
  });

  return { scheduler, clock, internals: scheduler as unknown as SchedulerInternals };
}

/**
 * Seeds the scheduler queue with diverse entries so {@link selectNextIndex}
 * exercises both the base priority and fairness boost branches.
 */
function seedQueueForFairness(internals: SchedulerInternals, baseTimestamp: number): void {
  const queue = internals.queue;
  queue.length = 0;
  const nodes = ["alpha", "beta", "gamma", "delta"] as const;
  for (let index = 0; index < 256; index += 1) {
    const payload: TaskReadyEvent = {
      nodeId: nodes[index % nodes.length]!,
      criticality: index % 5,
      pheromone: (index % 7) + 1,
      pheromoneBounds: {
        minIntensity: 0,
        maxIntensity: 10,
        normalisationCeiling: 6,
      },
    };
    queue.push({
      id: index,
      event: "taskReady",
      payload,
      enqueuedAt: baseTimestamp - index * 5,
      basePriority: internals.computeBasePriority("taskReady", payload),
      causalEventId: null,
    });
  }
}

/**
 * Seeds the queue with clustered node identifiers so pheromone rebalancing runs
 * through multiple entries while exercising the bounds snapshotting path.
 */
function seedQueueForPheromone(internals: SchedulerInternals, baseTimestamp: number): string[] {
  const queue = internals.queue;
  queue.length = 0;
  const nodeIds: string[] = [];
  for (let index = 0; index < 96; index += 1) {
    const nodeId = `worker-${index % 12}`;
    if (!nodeIds.includes(nodeId)) {
      nodeIds.push(nodeId);
    }
    const payload: TaskReadyEvent = {
      nodeId,
      criticality: 2,
      pheromone: 4,
      pheromoneBounds: {
        minIntensity: 0,
        maxIntensity: 12,
        normalisationCeiling: 8,
      },
    };
    queue.push({
      id: index,
      event: "taskReady",
      payload,
      enqueuedAt: baseTimestamp - index * 3,
      basePriority: internals.computeBasePriority("taskReady", payload),
      causalEventId: null,
    });
  }
  return nodeIds;
}

/**
 * Executes the fairness micro-benchmarks and returns their aggregated samples.
 */
export function runSchedulerFairnessBench(): SchedulerFairnessSample[] {
  const samples: SchedulerFairnessSample[] = [];

  {
    const { internals, clock } = createSchedulerForFairness();
    const baseTime = 10_000;
    clock.advanceTo(baseTime);
    seedQueueForFairness(internals, baseTime);
    samples.push(
      runFairnessBenchmark("selectNextIndex aging", (iteration) => {
        const now = baseTime + (iteration % 1024);
        const selectedIndex = internals.selectNextIndex(now);
        if (selectedIndex < 0 || selectedIndex >= internals.queue.length) {
          throw new Error(`invalid index ${selectedIndex}`);
        }
      }),
    );
  }

  {
    const { internals, clock } = createSchedulerForFairness();
    const baseTime = 50_000;
    clock.advanceTo(baseTime);
    const hotNodes = seedQueueForPheromone(internals, baseTime);
    samples.push(
      runFairnessBenchmark("rebalancePheromone", (iteration) => {
        const nodeId = hotNodes[iteration % hotNodes.length]!;
        const intensity = (iteration % 20) + 1;
        internals.rebalancePheromone(nodeId, intensity);
      }),
    );
  }

  return samples;
}


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

  if (process.env.SCHED_BENCH_MODE === "fairness") {
    const samples = runSchedulerFairnessBench();
    for (const sample of samples) {
      assertFairnessSample(sample);
    }
    // eslint-disable-next-line no-console -- CLI utility intended for local runs.
    console.log(renderSchedulerFairnessSamples(samples));
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
