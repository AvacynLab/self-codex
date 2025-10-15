import { performance } from "node:perf_hooks";
import { Worker, type WorkerOptions } from "node:worker_threads";

import type { JsonPatchOperation } from "../graph/diff.js";
import type { NormalisedGraph } from "../graph/types.js";
import { computeGraphChangeSet, type GraphChangeSetComputation } from "./graphChangeSet.js";

// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Configuration options for the {@link GraphWorkerPool}. The pool focuses on large graph
 * change-sets so the orchestrator can offload diff/validate workloads to background workers
 * without polluting the façade implementation with worker-specific code.
 */
export interface GraphWorkerPoolOptions {
  /** Maximum number of background workers available. A value of `0` disables offloading. */
  readonly maxWorkers: number;
  /** Minimum change-set size that should trigger the offload heuristics. */
  readonly changeSetSizeThreshold: number;
  /** Optional guard controlling the number of samples retained when computing percentiles. */
  readonly maxSampleSize?: number;
  /** Optional heuristic to trigger offloading when the base graph already contains many nodes. */
  readonly nodeCountThreshold?: number;
  /** Optional timeout after which the worker is deemed unresponsive and execution falls back inline. */
  readonly workerTimeoutMs?: number;
  /**
   * Optional factory used to instantiate worker threads. Primarily intended for unit tests so they can
   * inject lightweight fakes without relying on the compiled worker bundle.
   */
  readonly workerFactory?: (script: URL, options: WorkerOptions) => Worker;
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
export interface GraphWorkerExecutionResult {
  /** Value returned by the delegated task. */
  readonly result: GraphChangeSetComputation;
  /** Indicates whether the operation satisfied the offload heuristics. */
  readonly offloaded: boolean;
}

interface GraphWorkerTask {
  readonly changeSetSize: number;
  readonly baseGraph: NormalisedGraph;
  readonly operations: JsonPatchOperation[];
}

interface GraphWorkerSuccessMessage {
  readonly ok: true;
  readonly result: GraphChangeSetComputation;
}

interface GraphWorkerErrorMessage {
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

type GraphWorkerResponse = GraphWorkerSuccessMessage | GraphWorkerErrorMessage;

const DEFAULT_SAMPLE_CAP = 256;

function computePercentile(sortedSamples: readonly number[], percentile: number): number {
  if (sortedSamples.length === 0) {
    return Number.NaN;
  }

  const position = (percentile / 100) * (sortedSamples.length - 1);
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

function resolveWorkerScriptUrl(): URL | null {
  try {
    return new URL("../../dist/infra/graphWorkerThread.js", import.meta.url);
  } catch {
    // Ignore resolution failures and fall back to inline execution.
  }
  return null;
}

/**
 * Worker-pool facade dedicated to graph diff/validate workloads. The implementation keeps the API
 * narrow so the orchestrator can evolve its heuristics without leaking worker-specific concerns to
 * façade handlers. When the pool is disabled (`maxWorkers = 0`) or the worker script is not
 * available, the helper behaves transparently and executes tasks inline.
 */
export class GraphWorkerPool {
  private readonly maxWorkers: number;
  private readonly changeSetSizeThreshold: number;
  private readonly nodeCountThreshold: number | null;
  private readonly maxSampleSize: number;
  private readonly durations: number[] = [];
  private workerScriptUrl: URL | null;
  private readonly workerTimeoutMs: number | null;
  private readonly workerFactory: ((script: URL, options: WorkerOptions) => Worker) | null;
  /** Guards against repeatedly spawning workers once the runtime reports the script as unavailable. */
  private workerUnavailable = false;
  private activeWorkers = 0;
  private executed = 0;

  constructor(options: GraphWorkerPoolOptions) {
    const maxWorkers = Number.isFinite(options.maxWorkers) ? Math.max(0, Math.floor(options.maxWorkers)) : 0;
    const changeSetThreshold = Number.isFinite(options.changeSetSizeThreshold)
      ? Math.max(0, Math.floor(options.changeSetSizeThreshold))
      : 0;
    const sampleCap = options.maxSampleSize !== undefined && Number.isFinite(options.maxSampleSize)
      ? Math.max(1, Math.floor(options.maxSampleSize))
      : DEFAULT_SAMPLE_CAP;

    this.maxWorkers = maxWorkers;
    this.changeSetSizeThreshold = changeSetThreshold;
    this.maxSampleSize = sampleCap;
    this.workerScriptUrl = resolveWorkerScriptUrl();
    this.workerFactory = typeof options.workerFactory === "function" ? options.workerFactory : null;

    if (options.nodeCountThreshold !== undefined && Number.isFinite(options.nodeCountThreshold)) {
      const threshold = Math.max(0, Math.floor(options.nodeCountThreshold));
      this.nodeCountThreshold = threshold === 0 ? null : threshold;
    } else {
      this.nodeCountThreshold = null;
    }

    if (options.workerTimeoutMs !== undefined && Number.isFinite(options.workerTimeoutMs)) {
      const timeout = Math.max(0, Math.floor(options.workerTimeoutMs));
      this.workerTimeoutMs = timeout === 0 ? null : timeout;
    } else {
      this.workerTimeoutMs = null;
    }
  }

  /** Indicates whether the pool is currently enabled. */
  get enabled(): boolean {
    return this.maxWorkers > 0;
  }

  /** Exposes whether the worker script was located during bootstrap. */
  get hasWorkerSupport(): boolean {
    return this.workerScriptUrl !== null;
  }

  /** Determines whether the workload satisfies the offload heuristics. */
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

  /** Executes the change-set either inline or through a worker thread. */
  async execute(task: GraphWorkerTask): Promise<GraphWorkerExecutionResult> {
    if (!this.shouldOffload(task.changeSetSize, task.baseGraph)) {
      return { result: computeGraphChangeSet(task.baseGraph, task.operations), offloaded: false };
    }

    if (!this.workerScriptUrl || this.workerUnavailable || this.activeWorkers >= this.maxWorkers) {
      return { result: computeGraphChangeSet(task.baseGraph, task.operations), offloaded: false };
    }

    this.activeWorkers += 1;
    const startedAt = performance.now();

    try {
      const response = await this.runWorker(task);
      if (response.ok) {
        const duration = performance.now() - startedAt;
        this.recordSuccess(duration);
        return { result: response.result, offloaded: true };
      }
    } catch {
      // Mark the worker script as unavailable so future calls fall back to the inline execution path.
      this.workerUnavailable = true;
      // Fall through to the inline execution path when the worker fails.
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    }

    return { result: computeGraphChangeSet(task.baseGraph, task.operations), offloaded: false };
  }

  private async runWorker(task: GraphWorkerTask): Promise<GraphWorkerResponse> {
    if (!this.workerScriptUrl) {
      throw new Error("graph worker script unavailable");
    }

    let worker: Worker;
    const workerOptions: WorkerOptions = {
        workerData: {
          baseGraph: task.baseGraph,
          operations: task.operations,
        },
        stderr: false,
        stdout: false,
        execArgv: [],
    };

    try {
      worker = this.workerFactory ? this.workerFactory(this.workerScriptUrl, workerOptions) : new Worker(this.workerScriptUrl, workerOptions);
    } catch (error) {
      this.workerUnavailable = true;
      throw error;
    }

    return await new Promise<GraphWorkerResponse>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        worker.removeAllListeners("message");
        worker.removeAllListeners("error");
        worker.removeAllListeners("exit");
      };

      if (this.workerTimeoutMs !== null) {
        timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          this.workerUnavailable = true;
          void worker.terminate();
          reject(new Error(`graph worker timed out after ${this.workerTimeoutMs} ms`));
        }, this.workerTimeoutMs);

        timeoutHandle.unref?.();
      }

      worker.once("message", (message: GraphWorkerResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(message);
      });

      worker.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });

      worker.once("exit", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (code === 0) {
          resolve({ ok: false, error: { name: "WorkerExit", message: "worker exited without result" } });
        } else {
          reject(new Error(`graph worker exited with code ${code}`));
        }
      });
    });
  }

  public recordSuccess(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }

    this.executed += 1;
    this.durations.push(durationMs);
    if (this.durations.length > this.maxSampleSize) {
      this.durations.shift();
    }
  }

  /** Returns the percentile statistics computed from the recorded execution durations. */
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

  /** Clears the recorded samples and resets internal counters. */
  async destroy(): Promise<void> {
    this.durations.length = 0;
    this.executed = 0;
    this.activeWorkers = 0;
    this.workerUnavailable = false;
  }
}
