import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import process from "node:process";

import { readOptionalString } from "../config/env.js";
import { coerceNullToUndefined } from "../utils/object.js";

import type { BudgetUsageMetadata } from "./budget.js";

/** Status codes mirrored from the OpenTelemetry specification. */
const OTLP_STATUS_OK = 2;
const OTLP_STATUS_ERROR = 3;

/** Maximum number of latency samples retained per method for percentile stats. */
const MAX_LATENCY_SAMPLES = 512;

/** Internal structure describing an active trace span. */
interface ActiveTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  method: string;
  requestId: string | number | null;
  childId: string | null;
  transport: string | null;
  bytesIn: number;
  bytesOut: number;
  readonly startedAt: bigint;
  readonly startedAtEpochNs: bigint;
  durationMs: number | null;
  ended: boolean;
  forcedOutcome: "ok" | "error" | null;
  forcedErrorCode: string | null;
}

/** Public snapshot exposing correlation fields to logging and diagnostics. */
export interface TraceContextSnapshot {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly method: string;
  readonly requestId: string | number | null;
  readonly childId: string | null;
  readonly transport: string | null;
  readonly durationMs: number | null;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

/** Aggregated latency counters used to compute percentiles. */
interface MethodMetrics {
  count: number;
  errorCount: number;
  samples: number[];
  errorCodeCounts: Map<string, number>;
}

/** Exported snapshot of per-method metrics for tests and the /metrics endpoint. */
export interface MethodMetricsSnapshot {
  readonly method: string;
  readonly count: number;
  readonly errorCount: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly errorCodes: Record<string, number>;
}

/** Structured snapshot of budget telemetry exposed through the metrics endpoint. */
interface BudgetMetricSnapshot {
  readonly method: string;
  readonly stage: string;
  readonly actor: string;
  readonly dimension: string;
  readonly consumed: number;
  readonly exhausted: number;
}

/** Options accepted by {@link runWithRpcTrace}. */
export interface RpcTraceOptions {
  readonly method: string;
  readonly requestId?: string | number | null;
  readonly parentSpanId?: string | null;
  readonly childId?: string | null;
  readonly transport?: string | null;
  readonly traceId?: string;
  readonly bytesIn?: number;
}

/** Partial updates applied to the active trace context. */
export interface TraceAnnotation {
  readonly method?: string;
  readonly requestId?: string | number | null;
  readonly childId?: string | null;
  readonly transport?: string | null;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
}

const storage = new AsyncLocalStorage<ActiveTraceContext>();
const methodMetrics = new Map<string, MethodMetrics>();
const budgetMetrics = new Map<string, BudgetMetricRecord>();

/**
 * Runtime counters exported by the metrics endpoint. Each counter/gauge is kept
 * in-process so the `/metrics` handler can expose instantaneous values without
 * performing additional aggregation work at request time.
 */
let sseDropCount = 0;
let childRestartCount = 0;
let idempotencyConflictCount = 0;
/** Gauge tracking the number of live SSE streams served by the HTTP transport. */
let openSseStreams = 0;
let openChildRuntimes = 0;

interface BudgetMetricRecord {
  consumed: number;
  exhausted: number;
}

interface OtlpConfig {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
}

let otlpConfig: OtlpConfig | null = readOtlpConfigFromEnv();
let otlpQueue: Promise<void> = Promise.resolve();

function readOtlpConfigFromEnv(): OtlpConfig | null {
  const endpoint = readOptionalString("OTEL_EXPORTER_OTLP_ENDPOINT", { allowEmpty: false });
  if (!endpoint) {
    return null;
  }
  const headersValue = readOptionalString("OTEL_EXPORTER_OTLP_HEADERS", { allowEmpty: false });
  if (!headersValue) {
    return { endpoint, headers: { "content-type": "application/json" } };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const part of headersValue.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (key && value) {
      headers[key.toLowerCase()] = value;
    }
  }
  return { endpoint, headers };
}

function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

function ensureMetrics(method: string): MethodMetrics {
  const key = method || "unknown";
  let metrics = methodMetrics.get(key);
  if (!metrics) {
    metrics = { count: 0, errorCount: 0, samples: [], errorCodeCounts: new Map() };
    methodMetrics.set(key, metrics);
  }
  return metrics;
}

function recordMethodMetrics(method: string, durationMs: number, errored: boolean, errorCode: string | null): void {
  const metrics = ensureMetrics(method);
  metrics.count += 1;
  if (errored) {
    metrics.errorCount += 1;
    const code = errorCode ?? "unknown";
    metrics.errorCodeCounts.set(code, (metrics.errorCodeCounts.get(code) ?? 0) + 1);
  }
  metrics.samples.push(durationMs);
  if (metrics.samples.length > MAX_LATENCY_SAMPLES) {
    metrics.samples.splice(0, metrics.samples.length - MAX_LATENCY_SAMPLES);
  }
}

function percentile(samples: readonly number[], percentileRank: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1));
  return sorted[index];
}

function normaliseMetricLabel(value: string | null | undefined, fallback: string): string {
  const fallbackValue = fallback;
  if (typeof value !== "string") {
    return fallbackValue;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallbackValue;
  }
  return trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

/**
 * Records an ad-hoc latency sample so non JSON-RPC workflows can take
 * advantage of the same percentile computation infrastructure exposed via
 * {@link collectMethodMetrics}. The helper is used by the search pipeline to
 * surface p50/p95/p99 timings for the individual stages (Searx query,
 * downloads, extraction, ingestion...).
 */
export function recordCustomOperationLatency(
  label: string,
  durationMs: number,
  options: { errored?: boolean; errorCode?: string | null } = {},
): void {
  const normalisedLabel = normaliseMetricLabel(label, "custom");
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const errored = options.errored ?? false;
  const errorCode = options.errorCode ?? null;
  recordMethodMetrics(normalisedLabel, safeDuration, errored, errorCode);
}

/**
 * Derives the canonical label used to bucket latency metrics. JSON-RPC tool
 * invocations (`tools/call`) are rewritten to the `tool:<name>` namespace so
 * observability dashboards expose per-façade percentiles instead of an
 * aggregated series that hides slow outliers. Non tool invocations retain
 * their original method name for backwards compatibility.
 */
export function deriveMetricMethodLabel(method: string | null | undefined, toolName: string | null | undefined): string {
  const rawMethod = typeof method === "string" ? method.trim() : "";
  const rawTool = typeof toolName === "string" ? toolName.trim() : "";

  if (rawTool.length > 0) {
    if (rawMethod === "tools/call" || rawMethod.length === 0) {
      return `tool:${rawTool}`;
    }
    if (rawMethod.startsWith("tools/")) {
      return `tool:${rawTool}`;
    }
  }

  if (rawMethod.length > 0) {
    return rawMethod;
  }

  return rawTool.length > 0 ? `tool:${rawTool}` : "unknown";
}

function ensureBudgetMetricRecord(key: string): BudgetMetricRecord {
  let record = budgetMetrics.get(key);
  if (!record) {
    record = { consumed: 0, exhausted: 0 };
    budgetMetrics.set(key, record);
  }
  return record;
}

function deriveBudgetMetricLabels(metadata: BudgetUsageMetadata | undefined): {
  method: string;
  stage: string;
  actor: string;
} {
  const context = storage.getStore();
  const methodSource =
    (typeof metadata?.operation === "string" && metadata.operation.trim().length > 0
      ? metadata.operation
      : undefined) ?? context?.method ?? "unknown";
  const stageSource = (typeof metadata?.stage === "string" && metadata.stage.length > 0 ? metadata.stage : undefined) ??
    "unspecified";
  const actorSource = (typeof metadata?.actor === "string" && metadata.actor.length > 0 ? metadata.actor : undefined) ??
    "unknown";
  return {
    method: normaliseMetricLabel(methodSource, "unknown"),
    stage: normaliseMetricLabel(stageSource, "unspecified"),
    actor: normaliseMetricLabel(actorSource, "unknown"),
  };
}

function buildBudgetMetricKey(parts: {
  method: string;
  stage: string;
  actor: string;
  dimension: string;
}): string {
  return `${parts.method}|${parts.stage}|${parts.actor}|${normaliseMetricLabel(parts.dimension, "unknown")}`;
}

/** Returns a snapshot of the budget metrics captured so far (exposed for tests). */
export function collectBudgetMetrics(): BudgetMetricSnapshot[] {
  const snapshots: BudgetMetricSnapshot[] = [];
  for (const [key, record] of budgetMetrics.entries()) {
    const [method, stage, actor, dimension] = key.split("|");
    snapshots.push({
      method: method ?? "unknown",
      stage: stage ?? "unspecified",
      actor: actor ?? "unknown",
      dimension: dimension ?? "unknown",
      consumed: record.consumed,
      exhausted: record.exhausted,
    });
  }
  snapshots.sort((a, b) => {
    const methodCompare = a.method.localeCompare(b.method);
    if (methodCompare !== 0) {
      return methodCompare;
    }
    const stageCompare = a.stage.localeCompare(b.stage);
    if (stageCompare !== 0) {
      return stageCompare;
    }
    const actorCompare = a.actor.localeCompare(b.actor);
    if (actorCompare !== 0) {
      return actorCompare;
    }
    return a.dimension.localeCompare(b.dimension);
  });
  return snapshots;
}

function formatMetricValue(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return value.toFixed(2);
}

function snapshotFromContext(context: ActiveTraceContext): TraceContextSnapshot {
  const durationMs = context.durationMs ?? Number((process.hrtime.bigint() - context.startedAt) / 1_000_000n);
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    method: context.method,
    requestId: context.requestId,
    childId: context.childId,
    transport: context.transport,
    durationMs,
    bytesIn: context.bytesIn,
    bytesOut: context.bytesOut,
  };
}

/**
 * Executes a callback while registering a JSON-RPC trace/span in the async
 * execution context. Metrics are automatically recorded when the callback
 * resolves or throws.
 */
export async function runWithRpcTrace<T>(options: RpcTraceOptions, callback: () => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) {
    annotateTraceContext({
      method: options.method,
      requestId: options.requestId ?? null,
      childId: options.childId ?? null,
      transport: options.transport ?? null,
      bytesIn: options.bytesIn ?? 0,
    });
    return callback();
  }

  const context: ActiveTraceContext = {
    traceId: options.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: options.parentSpanId ?? null,
    method: options.method || "unknown",
    requestId: options.requestId ?? null,
    childId: options.childId ?? null,
    transport: options.transport ?? null,
    bytesIn: Math.max(0, options.bytesIn ?? 0),
    bytesOut: 0,
    startedAt: process.hrtime.bigint(),
    startedAtEpochNs: BigInt(Date.now()) * 1_000_000n,
    durationMs: null,
    ended: false,
    forcedOutcome: null,
    forcedErrorCode: null,
  };

  return await storage.run(context, async () => {
    try {
      const result = await callback();
      endTrace(context, false);
      return result;
    } catch (error) {
      endTrace(context, true);
      throw error;
    }
  });
}

function endTrace(context: ActiveTraceContext, errored: boolean): void {
  if (context.ended) {
    return;
  }
  context.ended = true;
  const elapsedNs = process.hrtime.bigint() - context.startedAt;
  context.durationMs = Math.max(0, Number(elapsedNs / 1_000_000n));
  const outcome = context.forcedOutcome ?? (errored ? "error" : "ok");
  const finalErrored = outcome === "error";
  const errorCode = finalErrored ? context.forcedErrorCode ?? "unknown" : null;
  recordMethodMetrics(context.method, context.durationMs, finalErrored, errorCode);
  if (otlpConfig) {
    scheduleOtlpExport(context, finalErrored, errorCode, elapsedNs);
  }
}

/** Returns the trace context associated with the current async execution. */
export function getActiveTraceContext(): TraceContextSnapshot | undefined {
  const context = storage.getStore();
  return context ? snapshotFromContext(context) : undefined;
}

/** Applies partial updates to the active trace context. */
export function annotateTraceContext(update: TraceAnnotation): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  if (typeof update.method === "string") {
    const nextMethod = update.method.trim();
    if (nextMethod.length > 0) {
      const current = context.method;
      const allowOverride =
        !current ||
        current === "unknown" ||
        current === nextMethod ||
        current === "tools/call" ||
        current.startsWith("tools/");
      if (allowOverride) {
        context.method = nextMethod;
      }
    }
  }
  if (update.requestId !== undefined && context.requestId == null && update.requestId != null) {
    context.requestId = update.requestId;
  }
  if (update.childId !== undefined && update.childId != null) {
    context.childId = update.childId;
  }
  if (update.transport !== undefined && update.transport != null) {
    context.transport = update.transport;
  }
  if (typeof update.bytesIn === "number" && Number.isFinite(update.bytesIn)) {
    context.bytesIn += Math.max(0, update.bytesIn);
  }
  if (typeof update.bytesOut === "number" && Number.isFinite(update.bytesOut)) {
    context.bytesOut += Math.max(0, update.bytesOut);
  }
}

/** Records additional inbound bytes for the active trace, if any. */
export function registerInboundBytes(bytes: number): void {
  if (bytes <= 0) {
    return;
  }
  annotateTraceContext({ bytesIn: bytes });
}

/** Records outbound bytes written for the active trace, if any. */
export function registerOutboundBytes(bytes: number): void {
  if (bytes <= 0) {
    return;
  }
  annotateTraceContext({ bytesOut: bytes });
}

/**
 * Records a budget consumption event against the active JSON-RPC method. The
 * helper is invoked by {@link BudgetTracker} instances so observability
 * dashboards can correlate resource usage with request stages.
 */
export function recordBudgetConsumptionMetric(
  dimension: string,
  amount: number,
  metadata?: BudgetUsageMetadata,
): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }
  const labels = deriveBudgetMetricLabels(metadata);
  const key = buildBudgetMetricKey({ ...labels, dimension });
  const record = ensureBudgetMetricRecord(key);
  record.consumed += amount;
}

/**
 * Records a budget exhaustion occurrence. This is triggered when a
 * {@link BudgetTracker} detects that a dimension would drop below zero.
 */
export function recordBudgetExhaustionMetric(dimension: string, metadata?: BudgetUsageMetadata): void {
  const labels = deriveBudgetMetricLabels(metadata);
  const key = buildBudgetMetricKey({ ...labels, dimension });
  const record = ensureBudgetMetricRecord(key);
  record.exhausted += 1;
}

function normaliseGaugeInput(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

/**
 * Records the number of Server-Sent Events (SSE) frames dropped due to
 * backpressure or transmission failures. The counter feeds the
 * `sse_drops_total` metric exposed over `/metrics` so observability
 * backends can graph cumulative drops over time.
 */
export function recordSseDrop(dropped: number = 1): void {
  if (!Number.isFinite(dropped) || dropped <= 0) {
    return;
  }
  sseDropCount += dropped;
}

/**
 * Registers a child process restart attempt emitted by the supervisor. The
 * count is surfaced as `child_restarts_total`, helping correlate spikes with
 * circuit-breaker activity and downstream failures.
 */
export function registerChildRestart(): void {
  childRestartCount += 1;
}

/**
 * Records an idempotency conflict detected by the HTTP server. Conflicts are
 * surfaced via `idempotency_conflicts_total` so operators can alert when
 * clients reuse keys with diverging payloads.
 */
export function registerIdempotencyConflict(): void {
  idempotencyConflictCount += 1;
}

/**
 * Updates the gauge reflecting the number of active SSE clients. Callers
 * provide the current count so the gauge remains accurate when multiple
 * connection lifecycles overlap.
 */
export function reportOpenSseStreams(count: number): void {
  openSseStreams = normaliseGaugeInput(count);
}

/**
 * Backwards compatible alias maintained for existing imports. The implementation
 * forwards to {@link reportOpenSseStreams} so the gauge exposed over `/metrics`
 * stays consistent with the hardened naming (`open_sse_streams`).
 */
export function reportOpenSseClients(count: number): void {
  reportOpenSseStreams(count);
}

/**
 * Updates the gauge exposing the number of active child runtimes (processes or
 * logical HTTP bridges). The supervisor refreshes the gauge whenever the
 * population changes.
 */
export function reportOpenChildRuntimes(count: number): void {
  openChildRuntimes = normaliseGaugeInput(count);
}

/** Marks the active JSON-RPC trace as successful. */
export function registerRpcSuccess(): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  context.forcedOutcome = "ok";
  context.forcedErrorCode = null;
}

/** Marks the active JSON-RPC trace as errored and captures the error code. */
export function registerRpcError(errorCode: number | string | null | undefined): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  context.forcedOutcome = "error";
  if (errorCode === null || errorCode === undefined || Number.isNaN(errorCode)) {
    context.forcedErrorCode = "unknown";
    return;
  }
  context.forcedErrorCode = String(errorCode);
}

/** Returns a frozen copy of the aggregated per-method metrics. */
export function collectMethodMetrics(): MethodMetricsSnapshot[] {
  const entries: MethodMetricsSnapshot[] = [];
  for (const [method, metrics] of methodMetrics.entries()) {
    const p50 = percentile(metrics.samples, 50);
    const p95 = percentile(metrics.samples, 95);
    const p99 = percentile(metrics.samples, 99);
    const errorCodes: Record<string, number> = {};
    for (const [code, count] of metrics.errorCodeCounts.entries()) {
      errorCodes[code] = count;
    }
    entries.push({ method, count: metrics.count, errorCount: metrics.errorCount, p50, p95, p99, errorCodes });
  }
  entries.sort((a, b) => a.method.localeCompare(b.method));
  return entries;
}

/** Renders metrics using a compact text format consumed by `/metrics`. */
export function renderMetricsSnapshot(): string {
  const lines: string[] = ["# mcp rpc metrics"];
  const snapshots = collectMethodMetrics();
  for (const snapshot of snapshots) {
    lines.push(`rpc_count{method="${snapshot.method}"} ${snapshot.count}`);
    lines.push(`rpc_error_count{method="${snapshot.method}"} ${snapshot.errorCount}`);
    lines.push(`rpc_latency_ms_p50{method="${snapshot.method}"} ${snapshot.p50.toFixed(2)}`);
    lines.push(`rpc_latency_ms_p95{method="${snapshot.method}"} ${snapshot.p95.toFixed(2)}`);
    lines.push(`rpc_latency_ms_p99{method="${snapshot.method}"} ${snapshot.p99.toFixed(2)}`);
    for (const [code, count] of Object.entries(snapshot.errorCodes)) {
      lines.push(`rpc_error_code_count{method="${snapshot.method}",code="${code}"} ${count}`);
    }
  }
  const budgetSnapshots = collectBudgetMetrics();
  if (budgetSnapshots.length > 0) {
    lines.push("# mcp budget metrics");
    for (const snapshot of budgetSnapshots) {
      if (snapshot.consumed > 0) {
        lines.push(
          `budget_consumed_total{method="${snapshot.method}",stage="${snapshot.stage}",actor="${snapshot.actor}",dimension="${snapshot.dimension}"} ${formatMetricValue(snapshot.consumed)}`,
        );
      }
      if (snapshot.exhausted > 0) {
        lines.push(
          `budget_exhausted_total{method="${snapshot.method}",stage="${snapshot.stage}",actor="${snapshot.actor}",dimension="${snapshot.dimension}"} ${snapshot.exhausted}`,
        );
      }
    }
  }
  lines.push("# mcp infra metrics");
  lines.push(`sse_drops_total ${sseDropCount}`);
  lines.push(`child_restarts_total ${childRestartCount}`);
  lines.push(`idempotency_conflicts_total ${idempotencyConflictCount}`);
  lines.push(`open_sse_streams ${openSseStreams}`);
  lines.push(`open_children ${openChildRuntimes}`);
  return `${lines.join("\n")}\n`;
}

/** Testing hooks allowing suites to reset the aggregated metrics. */
export const __tracingInternals = {
  reset(): void {
    methodMetrics.clear();
    budgetMetrics.clear();
    sseDropCount = 0;
    childRestartCount = 0;
    idempotencyConflictCount = 0;
    openSseStreams = 0;
    openChildRuntimes = 0;
  },
  configureOtlp(config: OtlpConfig | null): void {
    otlpConfig = config;
  },
  reloadOtlpConfigFromEnv(): OtlpConfig | null {
    const config = readOtlpConfigFromEnv();
    otlpConfig = config;
    return config;
  },
  async flushOtlpQueue(): Promise<void> {
    await otlpQueue;
  },
};

function scheduleOtlpExport(
  context: ActiveTraceContext,
  errored: boolean,
  errorCode: string | null,
  elapsedNs: bigint,
): void {
  if (!otlpConfig) {
    return;
  }

  const activeConfig = otlpConfig;

  const startTime = context.startedAtEpochNs;
  const endTime = startTime + elapsedNs;
  const attributes = buildOtlpAttributes(context, errored, errorCode);
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "mcp-self-fork-orchestrator" } },
            { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "mcp.jsonrpc" },
            spans: [
              {
                traceId: context.traceId,
                spanId: context.spanId,
                parentSpanId: coerceNullToUndefined(context.parentSpanId),
                name: context.method || "unknown",
                kind: 3, // SPAN_KIND_SERVER
                startTimeUnixNano: startTime.toString(),
                endTimeUnixNano: endTime.toString(),
                attributes,
                status: { code: errored ? OTLP_STATUS_ERROR : OTLP_STATUS_OK },
              },
            ],
          },
        ],
      },
    ],
  };

  otlpQueue = otlpQueue
    .then(async () => {
      try {
        await fetch(activeConfig.endpoint, {
          method: "POST",
          headers: activeConfig.headers,
          body: JSON.stringify(payload),
        });
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            message: "otlp_export_failed",
            detail: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      }
    })
    .catch(() => {
      otlpQueue = Promise.resolve();
    });
}

function buildOtlpAttributes(
  context: ActiveTraceContext,
  errored: boolean,
  errorCode: string | null,
): Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }> {
  const attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }> = [
    { key: "rpc.system", value: { stringValue: "jsonrpc" } },
    { key: "rpc.method", value: { stringValue: context.method || "unknown" } },
  ];
  if (context.requestId !== null) {
    attributes.push({ key: "rpc.request_id", value: { stringValue: String(context.requestId) } });
  }
  if (context.childId) {
    attributes.push({ key: "mcp.child_id", value: { stringValue: context.childId } });
  }
  if (context.transport) {
    attributes.push({ key: "net.transport", value: { stringValue: context.transport } });
  }
  if (errored && errorCode) {
    attributes.push({ key: "rpc.error_code", value: { stringValue: errorCode } });
  }
  if (context.bytesIn > 0) {
    attributes.push({ key: "mcp.bytes_in", value: { intValue: Math.round(context.bytesIn).toString() } });
  }
  if (context.bytesOut > 0) {
    attributes.push({ key: "mcp.bytes_out", value: { intValue: Math.round(context.bytesOut).toString() } });
  }
  return attributes;
}

