import { performance } from "node:perf_hooks";

import { recordCustomOperationLatency } from "../infra/tracing.js";

/** Ordered bucket boundaries (ms) used to classify latency samples. */
const LATENCY_BUCKET_BOUNDARIES_MS = [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000] as const;

/** Precomputed bucket labels to keep snapshot ordering deterministic. */
const ORDERED_BUCKET_LABELS: readonly string[] = [
  ...LATENCY_BUCKET_BOUNDARIES_MS.map((boundary) => formatLessOrEqual(boundary)),
  formatGreaterThan(LATENCY_BUCKET_BOUNDARIES_MS[LATENCY_BUCKET_BOUNDARIES_MS.length - 1]),
];

/** Default placeholder when a metric dimension is unknown. */
const UNKNOWN_DIMENSION = "unknown" as const;

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

/** Dimensions recorded alongside each latency sample. */
export interface SearchMetricDimensions {
  /** Domain associated with the resource that triggered the metric. */
  readonly domain?: string | null;
  /** Content type observed (or expected) for the resource. */
  readonly contentType?: string | null;
}

/** Outcome of a measured operation leveraged by context resolvers. */
export type SearchMetricOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Optional callback used to derive metric dimensions from the outcome. */
export type SearchMetricContextResolver<T> = (
  outcome: SearchMetricOutcome<T>,
) => SearchMetricDimensions | null | undefined;

/** Supported shape for the optional context passed to {@link SearchMetricsRecorder.measure}. */
export type SearchMetricContext<T> = SearchMetricDimensions | SearchMetricContextResolver<T>;

/** Snapshot describing counters accumulated for each operation. */
export interface SearchMetricsSnapshot {
  readonly operations: readonly OperationMetricSnapshot[];
  readonly latencyBuckets: readonly OperationLatencyBucketsSnapshot[];
}

/** Counter pair recorded for an operation. */
export interface OperationMetricSnapshot {
  readonly operation: SearchMetricOperation;
  readonly success: number;
  readonly failure: number;
}

/** Snapshot representing the bucketed latency distribution for an operation. */
export interface OperationLatencyBucketsSnapshot {
  readonly operation: SearchMetricOperation;
  readonly buckets: readonly LatencyBucketSnapshot[];
}

/** Count of samples that landed into a specific latency bucket. */
export interface LatencyBucketSnapshot {
  readonly bucket: string;
  readonly count: number;
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
  private readonly bucketCounters = new Map<SearchMetricOperation, Map<string, number>>();

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
    context?: SearchMetricContext<T>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      const result = await callback();
      this.increment(operation, true);
      this.record(operation, this.now() - startedAt, false, null, resolveDimensions(context, {
        ok: true,
        value: result,
      }));
      return result;
    } catch (error) {
      this.increment(operation, false);
      const code = errorCodeResolver ? errorCodeResolver(error) : null;
      this.record(operation, this.now() - startedAt, true, code, resolveDimensions(context, {
        ok: false,
        error,
      }));
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
    const latencyBuckets: OperationLatencyBucketsSnapshot[] = [];
    for (const [operation, bucketMap] of this.bucketCounters.entries()) {
      const buckets: LatencyBucketSnapshot[] = ORDERED_BUCKET_LABELS.map((label) => ({
        bucket: label,
        count: bucketMap.get(label) ?? 0,
      }));
      latencyBuckets.push({ operation, buckets });
    }
    latencyBuckets.sort((left, right) => left.operation.localeCompare(right.operation));
    return { operations, latencyBuckets };
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
    dimensions: SearchMetricDimensions | null,
  ): void {
    const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    const label = buildMetricLabel(operation, dimensions ?? undefined);
    this.incrementBucket(operation, safeDuration);
    recordCustomOperationLatency(label, safeDuration, { errored, errorCode });
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

  private ensureBucketMap(operation: SearchMetricOperation): Map<string, number> {
    const existing = this.bucketCounters.get(operation);
    if (existing) {
      return existing;
    }
    const buckets = new Map<string, number>();
    this.bucketCounters.set(operation, buckets);
    return buckets;
  }

  private incrementBucket(operation: SearchMetricOperation, durationMs: number): void {
    const bucketMap = this.ensureBucketMap(operation);
    const bucket = deriveLatencyBucket(durationMs);
    bucketMap.set(bucket, (bucketMap.get(bucket) ?? 0) + 1);
  }
}

function resolveDimensions<T>(
  context: SearchMetricContext<T> | undefined,
  outcome: SearchMetricOutcome<T>,
): SearchMetricDimensions | null {
  if (!context) {
    return null;
  }
  if (typeof context === "function") {
    return context(outcome) ?? null;
  }
  return context;
}

function buildMetricLabel(
  operation: SearchMetricOperation,
  dimensions: SearchMetricDimensions | undefined,
): string {
  const stepLabel = OPERATION_LABELS[operation];
  const domain = sanitiseDomain(dimensions?.domain);
  const content = sanitiseContentType(dimensions?.contentType);
  return `${stepLabel}.content:${content}.domain:${domain}`;
}

function sanitiseDomain(raw: string | null | undefined): string {
  if (!raw) {
    return UNKNOWN_DIMENSION;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return UNKNOWN_DIMENSION;
  }
  try {
    const value = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const { hostname } = new URL(value);
    return normaliseDimension(hostname.toLowerCase());
  } catch {
    const hostname = trimmed.split("/")[0].toLowerCase();
    return normaliseDimension(hostname);
  }
}

function sanitiseContentType(raw: string | null | undefined): string {
  if (!raw) {
    return UNKNOWN_DIMENSION;
  }
  const base = raw.split(";")[0]?.trim().toLowerCase();
  if (!base) {
    return UNKNOWN_DIMENSION;
  }
  return normaliseDimension(base.replace(/\//g, "_"));
}

function normaliseDimension(value: string): string {
  const cleaned = value.replace(/[^a-z0-9_.-]/g, "_");
  if (cleaned.length === 0) {
    return UNKNOWN_DIMENSION;
  }
  return cleaned.slice(0, 120);
}

function deriveLatencyBucket(durationMs: number): string {
  const safe = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  for (const boundary of LATENCY_BUCKET_BOUNDARIES_MS) {
    if (safe <= boundary) {
      return formatLessOrEqual(boundary);
    }
  }
  return formatGreaterThan(LATENCY_BUCKET_BOUNDARIES_MS[LATENCY_BUCKET_BOUNDARIES_MS.length - 1]);
}

function formatLessOrEqual(boundary: number): string {
  return `le_${String(boundary).padStart(5, "0")}ms`;
}

function formatGreaterThan(boundary: number): string {
  return `gt_${String(boundary).padStart(5, "0")}ms`;
}
