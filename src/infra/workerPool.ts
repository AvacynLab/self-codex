import { performance } from "node:perf_hooks";

import type { NormalisedGraph } from "../graph/types.js";

// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Configuration options for the {@link GraphWorkerPool}. The pool is purposely lightweight so
 * callers can decide when to offload expensive diff/validate operations without having to know the
 * underlying worker implementation details.
 */
export interface GraphWorkerPoolOptions {
  /** Maximum number of background workers available. A value of `0` disables the pool. */
  readonly maxWorkers: number;
  /** Minimum change-set size that should trigger the offload heuristics. */
  readonly changeSetSizeThreshold: number;
  /** Optional guard controlling the number of samples retained when computing percentiles. */
  readonly maxSampleSize?: number;
  /** Optional heuristic to trigger offloading when the base graph already contains many nodes. */
  readonly nodeCountThreshold?: number;
}

/** Snapshot describing the worker pool percentile statistics exposed to observability pipelines. */
export interface GraphWorkerPoolStatistics {
  readonly executed: number;
  readonly threshold: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
}

/** Result returned by {@link GraphWorkerPool.execute}. */
export interface GraphWorkerExecutionResult<T> {
  /** Value returned by the delegated task. */
  readonly result: T;
  /** Indicates whether the operation satisfied the offload heuristics. */
  readonly offloaded: boolean;
}

/**
 * Simple percentile calculator using linear interpolation between neighbouring samples.
 */
function computePercentile(sortedSamples: readonly number[], percentile: number): number {
  if (sortedSamples.length === 0) {
    return Number.NaN;
  }

  const position = ((percentile / 100) * (sortedSamples.length - 1));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedSamples[lowerIndex];
  const upperValue = sortedSamples[upperIndex];

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

/**
 * Worker-pool facade dedicated to graph diff/validate workloads. The implementation is deliberately
 * conservative: it merely tracks heuristics and percentile statistics so we can evolve the
 * offloading strategy without forcing callers to depend on a concrete worker library. When the pool
 * is disabled (`maxWorkers = 0`), the helper behaves transparently and always executes tasks inline.
 */
export class GraphWorkerPool {
  private readonly maxWorkers: number;
  private readonly changeSetSizeThreshold: number;
  private readonly nodeCountThreshold: number | null;
  private readonly maxSampleSize: number;
  private readonly durations: number[] = [];
  private executed = 0;

  constructor(options: GraphWorkerPoolOptions) {
    const maxWorkers = Number.isFinite(options.maxWorkers) ? Math.max(0, Math.floor(options.maxWorkers)) : 0;
    const changeSetThreshold = Number.isFinite(options.changeSetSizeThreshold)
      ? Math.max(0, Math.floor(options.changeSetSizeThreshold))
      : 0;
    const sampleCap = options.maxSampleSize !== undefined && Number.isFinite(options.maxSampleSize)
      ? Math.max(1, Math.floor(options.maxSampleSize))
      : 256;

    this.maxWorkers = maxWorkers;
    this.changeSetSizeThreshold = changeSetThreshold;
    this.maxSampleSize = sampleCap;

    if (options.nodeCountThreshold !== undefined && Number.isFinite(options.nodeCountThreshold)) {
      const threshold = Math.max(0, Math.floor(options.nodeCountThreshold));
      this.nodeCountThreshold = threshold === 0 ? null : threshold;
    } else {
      this.nodeCountThreshold = null;
    }
  }

  /** Indicates whether the pool is currently enabled. */
  get enabled(): boolean {
    return this.maxWorkers > 0;
  }

  /**
   * Determines whether the provided workload should be offloaded to the worker pool. The heuristic
   * currently relies on the declared change-set size and optionally the base graph size.
   */
  shouldOffload(changeSetSize: number, graph: NormalisedGraph): boolean {
    if (!this.enabled) {
      return false;
    }

    if (changeSetSize >= this.changeSetSizeThreshold) {
      return true;
    }

    if (this.nodeCountThreshold !== null && graph.nodes.length >= this.nodeCountThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Executes the provided task either inline or through the worker heuristics. The current
   * implementation simply records the elapsed time to feed the percentile calculator and returns
   * the original task result.
   */
  async execute<T>(
    changeSetSize: number,
    graph: NormalisedGraph,
    task: () => Promise<T> | T,
  ): Promise<GraphWorkerExecutionResult<T>> {
    if (!this.shouldOffload(changeSetSize, graph)) {
      const result = await task();
      return { result, offloaded: false };
    }

    const startedAt = performance.now();
    const result = await task();
    const duration = performance.now() - startedAt;
    this.recordSuccess(duration);
    return { result, offloaded: true };
  }

  /** Records a successful worker execution so percentile statistics remain accurate. */
  recordSuccess(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }

    this.executed += 1;
    this.durations.push(durationMs);
    if (this.durations.length > this.maxSampleSize) {
      this.durations.shift();
    }
  }

  /**
   * Returns the percentile statistics computed from the recorded execution durations. The helper is
   * resilient when no samples are available by returning `null` percentiles so the caller can decide
   * how to surface the information.
   */
  getStatistics(): GraphWorkerPoolStatistics {
    if (this.durations.length === 0) {
      return {
        executed: this.executed,
        threshold: this.changeSetSizeThreshold,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      };
    }

    const sortedSamples = [...this.durations].sort((a, b) => a - b);
    return {
      executed: this.executed,
      threshold: this.changeSetSizeThreshold,
      p50Ms: computePercentile(sortedSamples, 50),
      p95Ms: computePercentile(sortedSamples, 95),
      p99Ms: computePercentile(sortedSamples, 99),
    };
  }

  /**
   * Clears the recorded samples. The method returns a promise so the pool can later evolve to a
   * real worker-backed implementation without breaking the existing API contract.
   */
  async destroy(): Promise<void> {
    this.durations.length = 0;
  }
}
