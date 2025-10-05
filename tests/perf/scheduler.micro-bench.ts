import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BehaviorTreeInterpreter } from "../../src/executor/bt/interpreter.js";
import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../../src/executor/bt/types.js";
import { ReactiveEventBus, ReactiveScheduler } from "../../src/executor/reactiveScheduler.js";

/**
 * Configuration shared by the scheduler micro-benchmarks. Keeping the structure
 * exported allows developers to clone/tune the settings from the CLI without
 * modifying the default scenario checked into the repository.
 */
export interface SchedulerBenchConfig {
  /** Number of task-ready events pushed into the scheduler queue. */
  iterations: number;
  /** Distinct node identifiers cycled through when emitting events. */
  uniqueNodes: number;
  /** Logical milliseconds added to the deterministic clock per emission. */
  logicalStepMs: number;
}

/** Results surfaced after each benchmark scenario completes. */
export interface SchedulerBenchResult {
  scenario: "baseline" | "stigmergy";
  ticks: number;
  elapsedMs: number;
  averageMsPerTick: number;
  tracesCaptured: number;
}

export const DEFAULT_SCHEDULER_BENCH_CONFIG: SchedulerBenchConfig = {
  iterations: 5000,
  uniqueNodes: 16,
  logicalStepMs: 3,
};

/**
 * Minimal behaviour node used by the benchmark. The node always reports a
 * running status so the scheduler never stops on its own; the benchmark harness
 * explicitly halts it once all events drained to keep the measurements bounded.
 */
class BenchmarkBehaviorNode implements BehaviorNode {
  public readonly id = "benchmark";
  public ticksExecuted = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    this.ticksExecuted += 1;
    await runtime.invokeTool("bench.task", { step: this.ticksExecuted });
    this.status = "running";
    return { status: "running" };
  }

  reset(): void {
    // The benchmark never asks for a reset because the node never succeeds.
    this.ticksExecuted = 0;
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "benchmark-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { ticksExecuted: this.ticksExecuted },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "benchmark-node") {
      throw new Error(`expected benchmark-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { ticksExecuted?: number } | undefined;
    this.ticksExecuted = typeof state?.ticksExecuted === "number" ? state.ticksExecuted : 0;
    this.status = snapshot.status;
  }

  getProgress(): number {
    if (this.status === "running") {
      return 0.5;
    }
    return this.status === "idle" ? 0 : 1;
  }
}

/**
 * Helper building the deterministic runtime injected into the interpreter.
 * The runtime avoids timers and Date calls to keep the benchmark reproducible
 * across machines — only the wall-clock measurement relies on performance.now().
 */
function buildRuntime(now: () => number): Partial<TickRuntime> & { invokeTool: TickRuntime["invokeTool"] } {
  return {
    now,
    wait: async () => {
      // Intentionally left empty: benchmarks should not delay ticks.
    },
    variables: {},
    invokeTool: async () => ({ acknowledged: true }),
  };
}

/**
 * Run the scheduler micro-benchmark either with or without stigmergic feedback.
 * When `withStigmergy` is enabled the harness emits `stigmergyChanged` events
 * before every `taskReady` signal so the scheduler recomputes priorities using
 * dynamic pheromone intensities.
 */
export async function runSchedulerMicroBenchmark(
  withStigmergy: boolean,
  config: SchedulerBenchConfig = DEFAULT_SCHEDULER_BENCH_CONFIG,
): Promise<SchedulerBenchResult> {
  const benchNode = new BenchmarkBehaviorNode();
  let logicalNow = 0;
  const pheromoneByNode = new Map<string, number>();
  let tracesCaptured = 0;

  const interpreter = new BehaviorTreeInterpreter(benchNode);
  const eventBus = new ReactiveEventBus();
  const scheduler = new ReactiveScheduler({
    interpreter,
    runtime: buildRuntime(() => logicalNow),
    eventBus,
    now: () => logicalNow,
    getPheromoneIntensity: withStigmergy ? (nodeId) => pheromoneByNode.get(nodeId) ?? 0 : undefined,
    onTick: () => {
      tracesCaptured += 1;
    },
  });

  const makeNodeId = (index: number): string => `node-${index % config.uniqueNodes}`;
  const makeCriticality = (index: number): number => (index % 5) + 1;

  const emitTaskReady = (index: number): void => {
    const nodeId = makeNodeId(index);
    if (withStigmergy) {
      const intensity = (index % 10) * 10 + (index % config.uniqueNodes);
      pheromoneByNode.set(nodeId, intensity);
      eventBus.emit("stigmergyChanged", { nodeId, intensity, type: "bench" });
    }
    eventBus.emit("taskReady", { nodeId, criticality: makeCriticality(index) });
    logicalNow += config.logicalStepMs;
  };

  const start = performance.now();
  emitTaskReady(0);
  for (let index = 1; index < config.iterations; index += 1) {
    emitTaskReady(index);
  }
  await scheduler.runUntilSettled();
  scheduler.stop();
  const elapsed = performance.now() - start;

  return {
    scenario: withStigmergy ? "stigmergy" : "baseline",
    ticks: scheduler.tickCount,
    elapsedMs: elapsed,
    averageMsPerTick: scheduler.tickCount > 0 ? elapsed / scheduler.tickCount : 0,
    tracesCaptured,
  };
}

/**
 * Print a compact table comparing the baseline/stigmergy benchmarks. The output
 * mirrors TAP-like formatting so the results remain easy to scrape from CI logs
 * when the benchmark gets executed locally.
 */
async function runAndReport(config: SchedulerBenchConfig = DEFAULT_SCHEDULER_BENCH_CONFIG): Promise<void> {
  const baseline = await runSchedulerMicroBenchmark(false, config);
  const stigmergy = await runSchedulerMicroBenchmark(true, config);

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
  const rows: string[] = [header, separator, formatRow(baseline), formatRow(stigmergy)];

  // eslint-disable-next-line no-console -- the benchmark is a CLI utility.
  console.log(rows.join("\n"));
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedFile && currentFile === invokedFile) {
  const iterations = Number.parseInt(process.env.SCHED_BENCH_ITERATIONS ?? "", 10);
  const uniqueNodes = Number.parseInt(process.env.SCHED_BENCH_NODES ?? "", 10);
  const logicalStepMs = Number.parseInt(process.env.SCHED_BENCH_STEP_MS ?? "", 10);
  const overrides: SchedulerBenchConfig = {
    iterations: Number.isNaN(iterations) ? DEFAULT_SCHEDULER_BENCH_CONFIG.iterations : iterations,
    uniqueNodes: Number.isNaN(uniqueNodes) ? DEFAULT_SCHEDULER_BENCH_CONFIG.uniqueNodes : uniqueNodes,
    logicalStepMs: Number.isNaN(logicalStepMs) ? DEFAULT_SCHEDULER_BENCH_CONFIG.logicalStepMs : logicalStepMs,
  };

  await runAndReport(overrides);
}
