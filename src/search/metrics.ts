import { performance } from "node:perf_hooks";

import { recordCustomOperationLatency } from "../infra/tracing.js";

/** Identifiers used to bucket latency metrics for each search stage. */
export type SearchMetricOperation =
  | "searxQuery"
  | "fetchUrl"
  | "extractWithUnstructured"
  | "ingestGraph"
  | "ingestVector";

/** Options accepted by {@link SearchMetricsRecorder}. */
export interface SearchMetricsOptions {
  /** Clock implementation returning milliseconds with sub-millisecond precision. */
  readonly now?: () => number;
}

/** Snapshot describing counters accumulated for each operation. */
export interface SearchMetricsSnapshot {
  readonly operations: readonly OperationMetricSnapshot[];
}

/** Counter pair recorded for an operation. */
export interface OperationMetricSnapshot {
  readonly operation: SearchMetricOperation;
  readonly success: number;
  readonly failure: number;
}

/** Mapping between operations and the metric label exposed via `/metrics`. */
const OPERATION_LABELS: Record<SearchMetricOperation, string> = {
  searxQuery: "search.searxQuery",
  fetchUrl: "search.fetchUrl",
  extractWithUnstructured: "search.extractWithUnstructured",
  ingestGraph: "search.ingestGraph",
  ingestVector: "search.ingestVector",
};

interface OperationCounters {
  success: number;
  failure: number;
}

/**
 * Records latency samples and success/failure counters for each stage of the
 * search pipeline. Metrics are forwarded to the shared tracing infrastructure
 * so dashboards automatically expose percentile stats without bespoke wiring.
 */
export class SearchMetricsRecorder {
  private readonly now: () => number;
  private readonly counters = new Map<SearchMetricOperation, OperationCounters>();

  constructor(options: SearchMetricsOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * Measures the execution of {@link callback}, recording latency and outcome
   * counters for the selected {@link operation}. Errors are rethrown after being
   * reported so callers can apply their usual error handling.
   */
  async measure<T>(
    operation: SearchMetricOperation,
    callback: () => Promise<T>,
    errorCodeResolver?: (error: unknown) => string | null,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      const result = await callback();
      this.increment(operation, true);
      this.record(operation, this.now() - startedAt, false, null);
      return result;
    } catch (error) {
      this.increment(operation, false);
      const code = errorCodeResolver ? errorCodeResolver(error) : null;
      this.record(operation, this.now() - startedAt, true, code);
      throw error;
    }
  }

  /** Returns an immutable snapshot of the counters collected so far. */
  snapshot(): SearchMetricsSnapshot {
    const operations: OperationMetricSnapshot[] = [];
    for (const [operation, counters] of this.counters.entries()) {
      operations.push({ operation, success: counters.success, failure: counters.failure });
    }
    operations.sort((left, right) => left.operation.localeCompare(right.operation));
    return { operations };
  }

  private increment(operation: SearchMetricOperation, success: boolean): void {
    const counters = this.ensure(operation);
    if (success) {
      counters.success += 1;
    } else {
      counters.failure += 1;
    }
  }

  private record(
    operation: SearchMetricOperation,
    durationMs: number,
    errored: boolean,
    errorCode: string | null,
  ): void {
    const label = OPERATION_LABELS[operation];
    recordCustomOperationLatency(label, durationMs, { errored, errorCode });
  }

  private ensure(operation: SearchMetricOperation): OperationCounters {
    const existing = this.counters.get(operation);
    if (existing) {
      return existing;
    }
    const counters: OperationCounters = { success: 0, failure: 0 };
    this.counters.set(operation, counters);
    return counters;
  }
}
