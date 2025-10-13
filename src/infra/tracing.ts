import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import process from "node:process";

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
  durationMs: number | null;
  ended: boolean;
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
}

/** Exported snapshot of per-method metrics for tests and the /metrics endpoint. */
export interface MethodMetricsSnapshot {
  readonly method: string;
  readonly count: number;
  readonly errorCount: number;
  readonly p50: number;
  readonly p95: number;
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
    metrics = { count: 0, errorCount: 0, samples: [] };
    methodMetrics.set(key, metrics);
  }
  return metrics;
}

function recordMethodMetrics(method: string, durationMs: number, errored: boolean): void {
  const metrics = ensureMetrics(method);
  metrics.count += 1;
  if (errored) {
    metrics.errorCount += 1;
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
    durationMs: null,
    ended: false,
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
  context.durationMs = Math.max(0, Number((process.hrtime.bigint() - context.startedAt) / 1_000_000n));
  recordMethodMetrics(context.method, context.durationMs, errored);
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
  if (update.method && !context.method) {
    context.method = update.method;
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

/** Returns a frozen copy of the aggregated per-method metrics. */
export function collectMethodMetrics(): MethodMetricsSnapshot[] {
  const entries: MethodMetricsSnapshot[] = [];
  for (const [method, metrics] of methodMetrics.entries()) {
    const p50 = percentile(metrics.samples, 50);
    const p95 = percentile(metrics.samples, 95);
    entries.push({ method, count: metrics.count, errorCount: metrics.errorCount, p50, p95 });
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
  }
  return `${lines.join("\n")}\n`;
}

/** Testing hooks allowing suites to reset the aggregated metrics. */
export const __tracingInternals = {
  reset(): void {
    methodMetrics.clear();
  },
};

