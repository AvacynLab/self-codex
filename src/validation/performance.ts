import { appendFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckRequestSnapshot,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
} from "./runSetup.js";

/** JSONL artefacts associated with the Stage 10 performance validation workflow. */
export const PERFORMANCE_JSONL_FILES = {
  inputs: "inputs/10_performance.jsonl",
  outputs: "outputs/10_performance.jsonl",
  events: "events/10_performance.jsonl",
  log: "logs/performance_http.json",
} as const;

/** Relative filename of the summary persisted under the `report/` directory. */
const PERFORMANCE_SUMMARY_FILENAME = "perf_summary.json";

/** Snapshot of the MCP HTTP log captured before/after the workflow. */
export interface PerformanceLogSnapshot {
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Context forwarded to parameter/meta factories when building the call plan. */
export interface PerformanceCallContext {
  readonly environment: HttpEnvironmentSummary;
  readonly previousCalls: readonly PerformanceCallOutcome[];
  readonly state: PerformancePhaseState;
  /** Index of the current attempt within the `repeat`/`batch` loop. */
  readonly attempt: number;
  /** Number of calls spawned together when `batch` is configured. */
  readonly batchSize: number;
}

/** Function signature used to produce dynamic JSON-RPC params. */
export type PerformanceParamsFactory = (context: PerformanceCallContext) => unknown;

/** Function signature used to produce dynamic JSON-RPC meta attributes. */
export type PerformanceMetaFactory = (context: PerformanceCallContext) => Record<string, unknown>;

/**
 * Specification of a JSON-RPC call executed during the performance workflow.
 * Each entry produces one line in the inputs/outputs JSONL artefacts.
 */
export interface PerformanceCallSpec {
  /** Logical scenario advertised in the artefacts (latency, concurrency, logs…). */
  readonly scenario: string;
  /** Friendly identifier persisted alongside the request artefacts. */
  readonly name: string;
  /** JSON-RPC method invoked against the MCP endpoint. */
  readonly method: string;
  /** Optional params object or factory invoked before dispatching the request. */
  readonly params?: unknown | PerformanceParamsFactory;
  /** Optional meta object (idempotency keys, timeouts…) or factory builder. */
  readonly meta?: Record<string, unknown> | PerformanceMetaFactory;
  /** When false, response events are not appended to `events/10_performance.jsonl`. */
  readonly captureEvents?: boolean;
  /** When true, the call contributes latency samples to percentile calculations. */
  readonly collectLatency?: boolean;
  /** Optional label describing the latency series (defaults to {@link name}). */
  readonly latencyLabel?: string;
  /** Optional tool identifier surfaced in the summary (for operator guidance). */
  readonly latencyToolName?: string;
  /** Optional concurrency bucket aggregating success/error counters. */
  readonly concurrencyGroup?: string;
  /** Number of sequential repetitions executed for this spec (defaults to 1). */
  readonly repeat?: number;
  /** Number of concurrent calls spawned for this spec (defaults to 1). */
  readonly batch?: number;
}

/** Representation of a call after parameter and meta factories resolved to JSON values. */
export type ExecutedPerformanceCall = Omit<PerformanceCallSpec, "params" | "meta"> & {
  readonly params?: unknown;
  readonly meta?: Record<string, unknown>;
  /** Attempt index (0-based) when `repeat` or `batch` expands the spec. */
  readonly attempt: number;
};

/** Outcome persisted for each JSON-RPC call executed during the workflow. */
export interface PerformanceCallOutcome {
  readonly call: ExecutedPerformanceCall;
  readonly check: HttpCheckSnapshot;
  readonly events: readonly unknown[];
}

/** Mutable state shared across the workflow (allows hooks to persist metadata). */
export interface PerformancePhaseState {
  /** Map of artefact labels to absolute file paths captured during hooks. */
  readonly artefacts: Map<string, string>;
  /** Raw durations (milliseconds) collected from latency probes. */
  readonly latencySamples: number[];
  /** Friendly label advertised in the summary for latency probes. */
  latencyLabel: string | null;
  /** Optional tool name surfaced in the summary. */
  latencyToolName: string | null;
  /** Aggregated counters tracking success/failure by concurrency group. */
  readonly concurrency: Map<string, PerformanceConcurrencyCounters>;
}

/** Internal counters collected for concurrency validation. */
export interface PerformanceConcurrencyCounters {
  totalCalls: number;
  success: number;
  failure: number;
}

/** Options accepted by {@link runPerformancePhase}. */
export interface PerformancePhaseOptions {
  readonly calls?: PerformanceCallSpec[];
  readonly performance?: DefaultPerformanceOptions;
}

/** Additional knobs exposed when building the default call plan. */
export interface DefaultPerformanceOptions {
  /** Number of lightweight tool calls executed to compute latency percentiles. */
  readonly sampleSize?: number;
  /** Name of the MCP tool targeted by the latency series (defaults to `echo`). */
  readonly toolName?: string;
  /** Text payload forwarded to the default `tools/call` latency probe. */
  readonly toolText?: string;
  /** Number of concurrent calls emitted to validate basic throughput. */
  readonly concurrencyBurst?: number;
  /** Location of the HTTP log inspected before and after the workflow. */
  readonly logPath?: string;
}

/** Result returned by {@link runPerformancePhase}. */
export interface PerformancePhaseResult {
  readonly outcomes: readonly PerformanceCallOutcome[];
  readonly summary: PerformanceSummary;
  readonly summaryPath: string;
  readonly logBefore: PerformanceLogSnapshot;
  readonly logAfter: PerformanceLogSnapshot;
}

/** Summary structure persisted in `report/performance_summary.json`. */
export interface PerformanceSummary {
  readonly artefacts: {
    readonly inputsJsonl: string;
    readonly outputsJsonl: string;
    readonly eventsJsonl: string;
    readonly httpSnapshotLog: string;
  };
  readonly latency: {
    readonly label: string | null;
    readonly toolName: string | null;
    readonly samples: number;
    readonly averageMs: number | null;
    readonly minMs: number | null;
    readonly maxMs: number | null;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly p99Ms: number | null;
  };
  readonly concurrency: {
    readonly groups: PerformanceConcurrencySummary[];
  };
  readonly logs: {
    readonly path: string | null;
    readonly existedBefore: boolean;
    readonly existedAfter: boolean;
    readonly sizeBeforeBytes: number | null;
    readonly sizeAfterBytes: number | null;
    readonly growthBytes: number | null;
    readonly rotated: boolean;
  };
}

/** Human readable snapshot of a concurrency bucket. */
export interface PerformanceConcurrencySummary {
  readonly group: string;
  readonly totalCalls: number;
  readonly success: number;
  readonly failure: number;
}

/** Hooks used by tests to simulate HTTP responses deterministically. */
export interface PerformancePhaseOverrides {
  readonly httpCheck?: (
    name: string,
    request: HttpCheckRequestSnapshot,
  ) => Promise<HttpCheckSnapshot>;
}

/** Default number of latency samples gathered when no override is provided. */
const DEFAULT_SAMPLE_SIZE = 50;

/** Default number of concurrent requests executed during the throughput burst. */
const DEFAULT_CONCURRENCY_BURST = 5;

/** Default HTTP log path inspected for growth/rotation. */
const DEFAULT_HTTP_LOG_PATH = "/tmp/mcp_http.log";

/**
 * Executes the Stage 10 performance validation call plan while persisting all
 * artefacts expected by the operator checklist.
 */
export async function runPerformancePhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: PerformancePhaseOptions = {},
  overrides: PerformancePhaseOverrides = {},
): Promise<PerformancePhaseResult> {
  if (!runRoot) {
    throw new Error("runPerformancePhase requires a run root directory");
  }

  if (!environment || !environment.baseUrl) {
    throw new Error("runPerformancePhase requires a valid HTTP environment");
  }

  const defaultOptions = options.performance ?? {};
  const calls = options.calls ?? buildDefaultPerformanceCalls(defaultOptions);
  const logPath = defaultOptions.logPath ?? DEFAULT_HTTP_LOG_PATH;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const logBefore = await captureLogSnapshot(logPath);

  const httpRunner = overrides.httpCheck ?? performHttpCheck;
  const outcomes: PerformanceCallOutcome[] = [];
  const state: PerformancePhaseState = {
    artefacts: new Map(),
    latencySamples: [],
    latencyLabel: null,
    latencyToolName: null,
    concurrency: new Map(),
  };

  let globalCallIndex = 0;

  for (const spec of calls) {
    const repeat = Math.max(1, spec.repeat ?? 1);
    const batch = Math.max(1, spec.batch ?? 1);

    for (let repetition = 0; repetition < repeat; repetition += 1) {
      const outcomesBatch = await Promise.all(
        Array.from({ length: batch }, async (_unused, batchIndex) => {
          const callIndex = globalCallIndex;
          globalCallIndex += 1;

          const context: PerformanceCallContext = {
            environment,
            previousCalls: outcomes,
            state,
            attempt: repetition * batch + batchIndex,
            batchSize: batch,
          };

          const params =
            typeof spec.params === "function"
              ? (spec.params as PerformanceParamsFactory)(context)
              : spec.params;
          const meta =
            typeof spec.meta === "function"
              ? (spec.meta as PerformanceMetaFactory)(context)
              : spec.meta;

          const requestBody: Record<string, unknown> = {
            jsonrpc: "2.0",
            id: buildJsonRpcId(callIndex, spec, context),
            method: spec.method,
          };
          if (params !== undefined) {
            requestBody.params = params;
          }
          if (meta !== undefined) {
            requestBody.meta = meta;
          }

          const check = await httpRunner(`${spec.scenario}:${spec.name}`, {
            method: "POST",
            url: environment.baseUrl,
            headers,
            body: requestBody,
          });

          // Persist only defined optional metadata to keep artefacts compatible
          // with the stricter optional property semantics enforced by the TypeScript
          // compiler flag targeted by this refactor.
          const executedCall: ExecutedPerformanceCall = {
            scenario: spec.scenario,
            name: spec.name,
            method: spec.method,
            ...(params !== undefined ? { params } : {}),
            ...(meta !== undefined ? { meta } : {}),
            ...(spec.captureEvents !== undefined ? { captureEvents: spec.captureEvents } : {}),
            ...(spec.collectLatency !== undefined ? { collectLatency: spec.collectLatency } : {}),
            ...(spec.latencyLabel !== undefined ? { latencyLabel: spec.latencyLabel } : {}),
            ...(spec.latencyToolName !== undefined ? { latencyToolName: spec.latencyToolName } : {}),
            ...(spec.concurrencyGroup !== undefined ? { concurrencyGroup: spec.concurrencyGroup } : {}),
            batch,
            repeat,
            attempt: context.attempt,
          };

          await appendPerformanceCallArtefacts(runRoot, executedCall, check);

          const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
          if (events.length) {
            await appendPerformanceEvents(runRoot, executedCall, events);
          }

          if (spec.collectLatency) {
            state.latencySamples.push(check.durationMs);
            if (!state.latencyLabel) {
              state.latencyLabel = spec.latencyLabel ?? spec.name;
            }
            if (!state.latencyToolName && spec.latencyToolName) {
              state.latencyToolName = spec.latencyToolName;
            }
          }

          if (spec.concurrencyGroup) {
            const counters = state.concurrency.get(spec.concurrencyGroup) ?? {
              totalCalls: 0,
              success: 0,
              failure: 0,
            };
            counters.totalCalls += 1;
            if (check.response.status >= 200 && check.response.status < 300) {
              counters.success += 1;
            } else {
              counters.failure += 1;
            }
            state.concurrency.set(spec.concurrencyGroup, counters);
          }

          const outcome: PerformanceCallOutcome = { call: executedCall, check, events };
          outcomes.push(outcome);
          return outcome;
        }),
      );

      // Ensure batch outcomes are available for potential future factories.
      if (outcomesBatch.length) {
        void outcomesBatch[outcomesBatch.length - 1];
      }
    }
  }

  const logAfter = await captureLogSnapshot(logPath);

  validatePerformanceExpectations(state, calls);

  const summary = buildPerformanceSummary(runRoot, state, logPath, logBefore, logAfter);
  const summaryPath = join(runRoot, "report", PERFORMANCE_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);

  return { outcomes, summary, summaryPath, logBefore, logAfter };
}

/**
 * Builds the default call plan covering latency probes, concurrency bursts and
 * log growth inspection expected by Stage 10.
 */
export function buildDefaultPerformanceCalls(
  options: DefaultPerformanceOptions = {},
): PerformanceCallSpec[] {
  const sampleSize = Math.max(1, options.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const toolName = options.toolName ?? "echo";
  const toolText = options.toolText ?? "performance latency probe";
  const concurrencyBurst = Math.max(1, options.concurrencyBurst ?? DEFAULT_CONCURRENCY_BURST);

  const latencyCall: PerformanceCallSpec = {
    scenario: "latency",
    name: "tools_call_echo",
    method: "tools/call",
    params: {
      name: toolName,
      arguments: { text: toolText },
    },
    collectLatency: true,
    latencyLabel: `${toolName} latency`,
    latencyToolName: toolName,
    repeat: sampleSize,
  };

  const concurrencyCall: PerformanceCallSpec = {
    scenario: "concurrency",
    name: "tools_call_echo_concurrent",
    method: "tools/call",
    params: {
      name: toolName,
      arguments: { text: `${toolText} (concurrency)` },
    },
    concurrencyGroup: "tools_call",
    batch: concurrencyBurst,
    collectLatency: false,
  };

  return [latencyCall, concurrencyCall];
}

/** Persists the JSON-RPC request/response and a structured log entry. */
async function appendPerformanceCallArtefacts(
  runRoot: string,
  call: ExecutedPerformanceCall,
  check: HttpCheckSnapshot,
): Promise<void> {
  const inputEntry = toJsonlLine({
    scenario: call.scenario,
    name: call.name,
    method: call.method,
    attempt: call.attempt,
    startedAt: check.startedAt,
    params: call.params ?? null,
    meta: call.meta ?? null,
    request: check.request,
  });
  const outputEntry = toJsonlLine({
    scenario: call.scenario,
    name: call.name,
    attempt: call.attempt,
    durationMs: check.durationMs,
    response: check.response,
  });
  const logEntry = `${JSON.stringify(
    {
      scenario: call.scenario,
      name: call.name,
      attempt: call.attempt,
      method: call.method,
      params: call.params ?? null,
      meta: call.meta ?? null,
      check,
    },
    null,
    2,
  )}\n`;

  await Promise.all([
    writeFile(join(runRoot, PERFORMANCE_JSONL_FILES.inputs), inputEntry, { encoding: "utf8", flag: "a" }),
    writeFile(join(runRoot, PERFORMANCE_JSONL_FILES.outputs), outputEntry, { encoding: "utf8", flag: "a" }),
    writeFile(join(runRoot, PERFORMANCE_JSONL_FILES.log), logEntry, { encoding: "utf8", flag: "a" }),
  ]);
}

/** Appends captured events to the dedicated `.jsonl` artefact. */
async function appendPerformanceEvents(
  runRoot: string,
  call: ExecutedPerformanceCall,
  events: readonly unknown[],
): Promise<void> {
  if (!events.length) {
    return;
  }

  const capturedAt = new Date().toISOString();
  const payload = events
    .map((event, index) =>
      toJsonlLine({
        scenario: call.scenario,
        source: call.name,
        attempt: call.attempt,
        capturedAt,
        eventIndex: index,
        // Stage 10 artefacts must avoid `undefined` placeholders so the stricter
        // optional property semantics enforced by `exactOptionalPropertyTypes`
        // remain satisfied. Only attach the payload when the event is defined.
        ...(event !== undefined ? { event } : {}),
      }),
    )
    .join("");

  await appendFile(join(runRoot, PERFORMANCE_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/** Extracts events embedded in JSON-RPC responses or error payloads. */
function extractEvents(body: unknown): unknown[] {
  const result = extractJsonRpcResult(body);
  if (result && Array.isArray((result as { events?: unknown }).events)) {
    return ((result as { events?: unknown[] }).events ?? []).filter(
      (event): event is unknown => event !== undefined,
    );
  }
  const error = extractJsonRpcError(body);
  if (error?.data && Array.isArray((error.data as { events?: unknown }).events)) {
    return ((error.data as { events?: unknown[] }).events ?? []).filter(
      (event): event is unknown => event !== undefined,
    );
  }
  return [];
}

/** Extracts the JSON-RPC result payload if the response matches the contract. */
function extractJsonRpcResult(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== "object") {
    return null;
  }
  return result as Record<string, unknown>;
}

/** Extracts the JSON-RPC error payload if the response exposes one. */
function extractJsonRpcError(body: unknown): {
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
} | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const result: { code?: number; message?: string; data?: Record<string, unknown> } = {};
  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === "number") {
    result.code = maybeCode;
  }
  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === "string") {
    result.message = maybeMessage;
  }
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object") {
    result.data = data as Record<string, unknown>;
  }
  return result;
}

/** Builds the summary document aggregating the performance outcomes. */
function buildPerformanceSummary(
  runRoot: string,
  state: PerformancePhaseState,
  logPath: string | undefined,
  logBefore: PerformanceLogSnapshot,
  logAfter: PerformanceLogSnapshot,
): PerformanceSummary {
  const samples = [...state.latencySamples].sort((left, right) => left - right);
  const average = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null;

  return {
    artefacts: {
      inputsJsonl: join(runRoot, PERFORMANCE_JSONL_FILES.inputs),
      outputsJsonl: join(runRoot, PERFORMANCE_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, PERFORMANCE_JSONL_FILES.events),
      httpSnapshotLog: join(runRoot, PERFORMANCE_JSONL_FILES.log),
    },
    latency: {
      label: state.latencyLabel,
      toolName: state.latencyToolName,
      samples: samples.length,
      averageMs: average,
      minMs: samples.length ? samples[0] : null,
      maxMs: samples.length ? samples[samples.length - 1] : null,
      p50Ms: computePercentile(samples, 0.5),
      p95Ms: computePercentile(samples, 0.95),
      p99Ms: computePercentile(samples, 0.99),
    },
    concurrency: {
      groups: [...state.concurrency.entries()].map(([group, counters]) => ({
        group,
        totalCalls: counters.totalCalls,
        success: counters.success,
        failure: counters.failure,
      })),
    },
    logs: {
      path: logPath ?? DEFAULT_HTTP_LOG_PATH,
      existedBefore: logBefore.exists,
      existedAfter: logAfter.exists,
      sizeBeforeBytes: logBefore.exists ? logBefore.size : null,
      sizeAfterBytes: logAfter.exists ? logAfter.size : null,
      growthBytes:
        logBefore.exists && logAfter.exists ? Math.max(0, logAfter.size - logBefore.size) : null,
      rotated:
        logBefore.exists &&
        logAfter.exists &&
        logAfter.mtimeMs >= logBefore.mtimeMs &&
        logAfter.size < logBefore.size,
    },
  };
}

/** Captures basic metadata about the MCP HTTP log file. */
async function captureLogSnapshot(path: string | undefined): Promise<PerformanceLogSnapshot> {
  const targetPath = path ?? DEFAULT_HTTP_LOG_PATH;
  try {
    const stats = await stat(targetPath);
    return { exists: true, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      return { exists: false, size: 0, mtimeMs: 0 };
    }
    throw error;
  }
}

/** Computes a percentile using linear interpolation between samples. */
function computePercentile(sortedValues: number[], percentile: number): number | null {
  if (!sortedValues.length) {
    return null;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const clamped = Math.min(Math.max(percentile, 0), 1);
  const position = (sortedValues.length - 1) * clamped;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }

  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

/** Builds deterministic JSON-RPC identifiers for artefact correlation. */
function buildJsonRpcId(
  index: number,
  call: PerformanceCallSpec,
  context: PerformanceCallContext,
): string {
  const attemptLabel = context.batchSize > 1 ? `batch${context.attempt}` : `seq${context.attempt}`;
  return `performance_${index}_${call.name}_${attemptLabel}`;
}

/**
 * Aggregates the number of latency samples expected from the provided call plan.
 * The helper mirrors the execution semantics (`repeat` × `batch`) so validation
 * can flag prematurely aborted runs before producing the final summary.
 */
function computeExpectedLatencySamples(calls: readonly PerformanceCallSpec[]): number {
  let total = 0;
  for (const spec of calls) {
    if (!spec.collectLatency) {
      continue;
    }
    const repeat = Math.max(1, spec.repeat ?? 1);
    const batch = Math.max(1, spec.batch ?? 1);
    total += repeat * batch;
  }
  return total;
}

/** Snapshot describing the target call volume for a given concurrency group. */
interface PerformanceConcurrencyExpectation {
  expectedCalls: number;
  maxBatch: number;
}

/**
 * Builds the expected concurrency footprint for the Stage 10 call plan. Each
 * group tracks the total number of requests plus the largest simultaneous burst
 * so the validator can enforce the "5 enfants simultanés" checklist item.
 */
function computeConcurrencyExpectations(
  calls: readonly PerformanceCallSpec[],
): Map<string, PerformanceConcurrencyExpectation> {
  const expectations = new Map<string, PerformanceConcurrencyExpectation>();
  for (const spec of calls) {
    if (!spec.concurrencyGroup) {
      continue;
    }
    const repeat = Math.max(1, spec.repeat ?? 1);
    const batch = Math.max(1, spec.batch ?? 1);
    const expectedCalls = repeat * batch;
    const entry = expectations.get(spec.concurrencyGroup) ?? { expectedCalls: 0, maxBatch: 0 };
    entry.expectedCalls += expectedCalls;
    entry.maxBatch = Math.max(entry.maxBatch, batch);
    expectations.set(spec.concurrencyGroup, entry);
  }
  return expectations;
}

/**
 * Ensures the Stage 10 performance workflow honoured the latency and
 * concurrency requirements from the checklist. Violations are surfaced as
 * actionable errors so operators immediately understand which probe deviated
 * from expectations.
 */
function validatePerformanceExpectations(
  state: PerformancePhaseState,
  calls: readonly PerformanceCallSpec[],
): void {
  const expectedLatencySamples = computeExpectedLatencySamples(calls);
  if (expectedLatencySamples < 50) {
    throw new Error(
      `Stage 10 requires au moins 50 échantillons de latence mais le plan courant n'en déclenche que ${expectedLatencySamples}. ` +
        "Augmente l'option `sampleSize` ou ajoute des répétitions sur les appels instrumentés.",
    );
  }
  if (state.latencySamples.length !== expectedLatencySamples) {
    throw new Error(
      `Stage 10 attendait ${expectedLatencySamples} échantillons de latence mais seulement ${state.latencySamples.length} ont été collectés. ` +
        "Vérifie les réponses HTTP et les erreurs côté serveur.",
    );
  }

  const expectations = computeConcurrencyExpectations(calls);
  if (!expectations.size) {
    throw new Error(
      "Stage 10 requiert au moins un burst de concurrence (5 appels simultanés) pour valider la stabilité des enfants.",
    );
  }

  for (const [group, expectation] of expectations.entries()) {
    const counters = state.concurrency.get(group);
    if (!counters) {
      throw new Error(
        `Stage 10 attendait ${expectation.expectedCalls} appel(s) pour le groupe de concurrence "${group}" mais aucun résultat n'a été capturé.`,
      );
    }
    if (expectation.maxBatch < 5) {
      throw new Error(
        `Stage 10 requiert au moins 5 appels simultanés pour le groupe "${group}" (batch actuel = ${expectation.maxBatch}).`,
      );
    }
    if (counters.totalCalls !== expectation.expectedCalls) {
      throw new Error(
        `Stage 10 attendait ${expectation.expectedCalls} appel(s) sur le groupe "${group}" mais ${counters.totalCalls} ont été journalisés.`,
      );
    }
    if (counters.failure > 0) {
      throw new Error(
        `Stage 10 a détecté ${counters.failure} échec(s) dans le groupe de concurrence "${group}". Tous les appels doivent réussir pour valider la stabilité.`,
      );
    }
  }
}
