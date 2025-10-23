import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckArtefactTargets,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import { coerceNullToUndefined, omitUndefinedEntries } from "../utils/object.js";

/** JSONL artefacts associated with the Stage 9 robustness validation workflow. */
export const ROBUSTNESS_JSONL_FILES = {
  inputs: "inputs/09_robustness.jsonl",
  outputs: "outputs/09_robustness.jsonl",
  events: "events/09_robustness.jsonl",
  log: "logs/robustness_http.json",
} as const;

/** Relative filename of the summary persisted under the `report/` directory. */
const ROBUSTNESS_SUMMARY_FILENAME = "robustness_summary.json";

/** Internal mapping reused when persisting HTTP request/response artefacts. */
const ROBUSTNESS_TARGETS: HttpCheckArtefactTargets = {
  inputs: ROBUSTNESS_JSONL_FILES.inputs,
  outputs: ROBUSTNESS_JSONL_FILES.outputs,
};

/** Context forwarded to parameter/meta factories when building the call plan. */
export interface RobustnessCallContext {
  readonly environment: HttpEnvironmentSummary;
  readonly previousCalls: readonly RobustnessCallOutcome[];
  readonly state: RobustnessPhaseState;
}

/** Function signature used to produce dynamic JSON-RPC params. */
export type RobustnessParamsFactory = (context: RobustnessCallContext) => unknown;

/** Function signature used to produce dynamic JSON-RPC meta attributes. */
export type RobustnessMetaFactory = (context: RobustnessCallContext) => Record<string, unknown>;

/** Callback executed after a call completes to persist supplementary artefacts. */
export type RobustnessCallAfterHook = (context: {
  readonly runRoot: string;
  readonly environment: HttpEnvironmentSummary;
  readonly outcome: RobustnessCallOutcome;
  readonly previousCalls: readonly RobustnessCallOutcome[];
  readonly state: RobustnessPhaseState;
}) => Promise<void> | void;

/**
 * Specification of a JSON-RPC call executed during the robustness workflow.
 * Each entry produces one line in the inputs/outputs JSONL artefacts.
 */
export interface RobustnessCallSpec {
  /** Logical scenario advertised in the artefacts (invalid, unknown, timeout…). */
  readonly scenario: string;
  /** Friendly identifier persisted alongside the request artefacts. */
  readonly name: string;
  /** JSON-RPC method invoked against the MCP endpoint. */
  readonly method: string;
  /** Optional params object or factory invoked before dispatching the request. */
  readonly params?: unknown | RobustnessParamsFactory;
  /** Optional meta object (idempotency keys, timeouts…) or factory builder. */
  readonly meta?: Record<string, unknown> | RobustnessMetaFactory;
  /** When false, response events are not appended to `events/09_robustness.jsonl`. */
  readonly captureEvents?: boolean;
  /** Optional group identifier (used to correlate idempotency checks, etc.). */
  readonly group?: string;
  /** Optional callback invoked once the HTTP snapshot has been persisted. */
  readonly afterExecute?: RobustnessCallAfterHook;
}

/** Representation of a call after parameter and meta factories resolved to JSON values. */
export type ExecutedRobustnessCall = Omit<RobustnessCallSpec, "params" | "meta"> & {
  readonly params?: unknown;
  readonly meta?: Record<string, unknown>;
};

/** Outcome persisted for each JSON-RPC call executed during the workflow. */
export interface RobustnessCallOutcome {
  readonly call: ExecutedRobustnessCall;
  readonly check: HttpCheckSnapshot;
  readonly events: unknown[];
}

/** Mutable state shared across the workflow (allows hooks to persist metadata). */
export interface RobustnessPhaseState {
  /** Map of artefact labels to absolute file paths captured during hooks. */
  readonly artefacts: Map<string, string>;
}

/** Options accepted by {@link runRobustnessPhase}. */
export interface RobustnessPhaseOptions {
  readonly calls?: RobustnessCallSpec[];
  readonly defaults?: DefaultRobustnessOptions;
}

/** Additional knobs exposed when building the default call plan. */
export interface DefaultRobustnessOptions {
  /** Idempotency key reused across the two `tx_begin` calls. */
  readonly idempotencyKey?: string;
  /** Optional override for the invalid schema payload. */
  readonly invalidSchemaParams?: Record<string, unknown>;
  /** Optional override for the unknown tool/method invoked. */
  readonly unknownMethod?: string;
  /** Custom command forwarded to the crash simulation call. */
  readonly crashCommand?: string;
  /** Timeout forwarded to the reactive plan run (milliseconds). */
  readonly reactiveTimeoutMs?: number;
}

/** Result returned by {@link runRobustnessPhase}. */
export interface RobustnessPhaseResult {
  readonly outcomes: readonly RobustnessCallOutcome[];
  readonly summary: RobustnessSummary;
  readonly summaryPath: string;
}

/** Summary structure persisted in `report/robustness_summary.json`. */
export interface RobustnessSummary {
  readonly artefacts: {
    readonly inputsJsonl: string;
    readonly outputsJsonl: string;
    readonly eventsJsonl: string;
    readonly httpSnapshotLog: string;
  };
  readonly checks: readonly {
    readonly scenario: string;
    readonly name: string;
    readonly method: string;
    readonly status: number;
    readonly statusText: string;
    readonly errorCode?: number;
    readonly errorMessage?: string;
    readonly idempotent?: boolean;
    readonly idempotencyKey?: string;
  }[];
  readonly idempotency?: {
    readonly group: string;
    readonly idempotencyKey?: string;
    readonly consistent: boolean;
    readonly firstStatus: number;
    readonly secondStatus: number;
    readonly mismatchReason?: string;
  };
  readonly crashSimulation?: {
    readonly status: number;
    readonly errorCode?: number;
    readonly errorMessage?: string;
    readonly eventCount: number;
  };
  readonly timeout?: {
    readonly status: number;
    readonly timedOut: boolean;
    readonly message?: string;
    readonly statusToken?: string | null;
  };
}

/** Identifier attached to the idempotency verification group. */
const IDEMPOTENCY_GROUP = "idempotency_tx_begin";

/** Identifier used for the child crash simulation scenario. */
const CRASH_SCENARIO_NAME = "child_spawn_failure";

/** Identifier used for the timeout verification scenario. */
const TIMEOUT_SCENARIO_NAME = "plan_reactive_timeout";

/**
 * Executes the robustness validation workflow and persists artefacts.
 */
export async function runRobustnessPhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: RobustnessPhaseOptions = {},
): Promise<RobustnessPhaseResult> {
  if (!runRoot) {
    throw new Error("runRobustnessPhase requires a run root directory");
  }
  if (!environment || !environment.baseUrl) {
    throw new Error("runRobustnessPhase requires a valid HTTP environment");
  }

  const state: RobustnessPhaseState = { artefacts: new Map<string, string>() };
  const calls = options.calls ?? buildDefaultRobustnessCalls(options.defaults);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const outcomes: RobustnessCallOutcome[] = [];

  for (let index = 0; index < calls.length; index += 1) {
    const spec = calls[index];
    const context: RobustnessCallContext = { environment, previousCalls: outcomes, state };
    const params = typeof spec.params === "function" ? (spec.params as RobustnessParamsFactory)(context) : spec.params;
    const meta = typeof spec.meta === "function" ? (spec.meta as RobustnessMetaFactory)(context) : spec.meta;

    const requestBody: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: buildJsonRpcId(index, spec),
      method: spec.method,
    };
    if (params !== undefined) {
      requestBody.params = params;
    }
    if (meta !== undefined) {
      requestBody.meta = meta;
    }

    const check = await performHttpCheck(`${spec.scenario}:${spec.name}`, {
      method: "POST",
      url: environment.baseUrl,
      headers,
      body: requestBody,
    });

    const executedCall: ExecutedRobustnessCall = {
      scenario: spec.scenario,
      name: spec.name,
      method: spec.method,
      ...(spec.captureEvents !== undefined ? { captureEvents: spec.captureEvents } : {}),
      ...(spec.group !== undefined ? { group: spec.group } : {}),
      ...(params !== undefined ? { params } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };

    await appendHttpCheckArtefactsToFiles(runRoot, ROBUSTNESS_TARGETS, check, ROBUSTNESS_JSONL_FILES.log);

    const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
    if (events.length) {
      await appendRobustnessEvents(runRoot, executedCall, events);
    }

    const outcome: RobustnessCallOutcome = { call: executedCall, check, events };
    if (spec.afterExecute) {
      await spec.afterExecute({ runRoot, environment, outcome, previousCalls: outcomes, state });
    }
    outcomes.push(outcome);
  }

  const summary = buildRobustnessSummary(runRoot, outcomes);
  enforceRobustnessInvariants(outcomes, summary);
  const summaryPath = join(runRoot, "report", ROBUSTNESS_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);

  return { outcomes, summary, summaryPath };
}

/**
 * Builds the default call plan exercising error handling, idempotency and
 * timeout scenarios.
 */
export function buildDefaultRobustnessCalls(
  options: DefaultRobustnessOptions = {},
): RobustnessCallSpec[] {
  const idempotencyKey = options.idempotencyKey ?? "robustness-tx";
  const invalidSchemaParams =
    options.invalidSchemaParams ?? ({ graph_id: 42 } as Record<string, unknown>);
  const unknownMethod = options.unknownMethod ?? "tool_unknown_method";
  const crashCommand = options.crashCommand ?? "validate-robustness";
  const reactiveTimeoutMs = options.reactiveTimeoutMs ?? 100;

  return [
    {
      scenario: "invalid-schema",
      name: "graph_diff_invalid",
      method: "graph_diff",
      params: invalidSchemaParams,
    },
    {
      scenario: "unknown-tool",
      name: "tool_unknown",
      method: unknownMethod,
      params: { foo: "bar" },
    },
    {
      scenario: "idempotency",
      name: "tx_begin_first",
      method: "tx_begin",
      group: IDEMPOTENCY_GROUP,
      params: { graph_id: "robustness", operations: [] },
      meta: { idempotency_key: idempotencyKey },
    },
    {
      scenario: "idempotency",
      name: "tx_begin_repeat",
      method: "tx_begin",
      group: IDEMPOTENCY_GROUP,
      params: { graph_id: "robustness", operations: [] },
      meta: { idempotency_key: idempotencyKey },
    },
    {
      scenario: "child-crash",
      name: CRASH_SCENARIO_NAME,
      method: "child_spawn_codex",
      params: {
        prompt: {
          user: [
            "Simule une tâche qui crashe pour tester la collecte des erreurs.",
            `Commande: ${crashCommand}`,
          ],
        },
        limits: {
          cpu_ms: 10,
          memory_mb: 16,
          wallclock_ms: 20,
        },
      },
    },
    {
      scenario: "timeout",
      name: TIMEOUT_SCENARIO_NAME,
      method: "plan_run_reactive",
      params: {
        plan_id: "robustness-reactive",
        tick_ms: 5,
        timeout_ms: reactiveTimeoutMs,
      },
      meta: ({ previousCalls }: RobustnessCallContext) => {
        const lastTx = findLastOutcome(previousCalls, IDEMPOTENCY_GROUP);
        const key = extractIdempotencyKey(lastTx?.check.response.body);
        return key ? { idempotency_key: key } : {};
      },
    },
  ];
}

/** Appends captured events to the robustness-specific `.jsonl` artefact. */
async function appendRobustnessEvents(
  runRoot: string,
  call: ExecutedRobustnessCall,
  events: unknown[],
): Promise<void> {
  // Stage 9 robustness artefacts must omit placeholder payloads (`undefined` or
  // `null`) so the JSONL stream stays compatible with `exactOptionalPropertyTypes`.
  // Filtering up-front also prevents us from emitting empty log entries when the
  // backend surfaces sparse event arrays.
  const definedEvents = events.filter(
    (event): event is unknown => event !== undefined && event !== null,
  );
  if (!definedEvents.length) {
    return;
  }

  const capturedAt = new Date().toISOString();
  const payload = definedEvents
    .map((event) =>
      toJsonlLine({
        scenario: call.scenario,
        name: call.name,
        capturedAt,
        // The event payload is guaranteed to be defined thanks to the filtering
        // above, which keeps the artefacts free of `undefined` placeholders.
        event,
      }),
    )
    .join("");
  await writeFile(join(runRoot, ROBUSTNESS_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/** Builds a deterministic JSON-RPC identifier for robustness calls. */
function buildJsonRpcId(index: number, spec: RobustnessCallSpec): string {
  const scenarioToken = spec.scenario.replace(/[^a-zA-Z0-9]+/g, "-");
  const nameToken = spec.name.replace(/[^a-zA-Z0-9]+/g, "-");
  return `robustness_${index}_${scenarioToken}_${nameToken}`;
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
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") {
    // Avoid storing an explicit `undefined` on optional properties so the helper stays compatible
    // with `exactOptionalPropertyTypes`.
    result.code = code;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    result.message = message;
  }
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object") {
    result.data = data as Record<string, unknown>;
  }
  return result;
}

/** Extracts events embedded in JSON-RPC responses or error payloads. */
function extractEvents(body: unknown): unknown[] {
  const result = extractJsonRpcResult(body);
  if (result && Array.isArray((result as { events?: unknown }).events)) {
    return ((result as { events?: unknown[] }).events ?? []).filter(
      (event): event is unknown => event !== undefined && event !== null,
    );
  }
  const error = extractJsonRpcError(body);
  if (error?.data && Array.isArray((error.data as { events?: unknown }).events)) {
    return ((error.data as { events?: unknown[] }).events ?? []).filter(
      (event): event is unknown => event !== undefined && event !== null,
    );
  }
  return [];
}

/** Builds a summary document aggregating the robustness outcomes. */
function buildRobustnessSummary(
  runRoot: string,
  outcomes: readonly RobustnessCallOutcome[],
): RobustnessSummary {
  const checks = outcomes.map((outcome) => {
    const error = extractJsonRpcError(outcome.check.response.body);
    const result = extractJsonRpcResult(outcome.check.response.body);
    const idempotentValue =
      typeof (result as { idempotent?: unknown })?.idempotent === "boolean"
        ? ((result as { idempotent?: boolean }).idempotent as boolean)
        : undefined;
    const idempotencyKey = extractIdempotencyKey(outcome.check.response.body);
    return {
      scenario: outcome.call.scenario,
      name: outcome.call.name,
      method: outcome.call.method,
      status: outcome.check.response.status,
      statusText: outcome.check.response.statusText,
      ...omitUndefinedEntries({
        errorCode: error?.code,
        errorMessage: error?.message,
        idempotent: idempotentValue,
      }),
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
    };
  });

  const idempotency = computeIdempotencySummary(outcomes);
  const crashSimulation = computeCrashSummary(outcomes);
  const timeout = computeTimeoutSummary(outcomes);

  // NOTE: Optional summary sections are only attached when the corresponding
  // scenarios are executed successfully; omitting unused keys keeps the payload
  // compliant once `exactOptionalPropertyTypes` enforces strict undefined
  // handling. Converting potential `null` placeholders into `undefined`
  // beforehand lets `omitUndefinedEntries` strip them deterministically.
  const summary = {
    artefacts: {
      inputsJsonl: join(runRoot, ROBUSTNESS_JSONL_FILES.inputs),
      outputsJsonl: join(runRoot, ROBUSTNESS_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, ROBUSTNESS_JSONL_FILES.events),
      httpSnapshotLog: join(runRoot, ROBUSTNESS_JSONL_FILES.log),
    },
    checks,
    ...omitUndefinedEntries({
      idempotency: coerceNullToUndefined(idempotency),
      crashSimulation: coerceNullToUndefined(crashSimulation),
      timeout: coerceNullToUndefined(timeout),
    }),
  } satisfies RobustnessSummary;

  return summary;
}

/** Computes the idempotency summary if the call plan executed the relevant group. */
function computeIdempotencySummary(
  outcomes: readonly RobustnessCallOutcome[],
): RobustnessSummary["idempotency"] | null {
  const candidates = outcomes.filter((outcome) => outcome.call.group === IDEMPOTENCY_GROUP);
  if (candidates.length < 2) {
    return null;
  }
  const first = candidates[0];
  const second = candidates[1];
  const firstBody = JSON.stringify(first.check.response.body ?? null);
  const secondBody = JSON.stringify(second.check.response.body ?? null);
  const consistent =
    first.check.response.status === second.check.response.status &&
    firstBody === secondBody;

  let mismatchReason: string | undefined;
  if (!consistent) {
    mismatchReason = "Response mismatch across idempotent calls";
  }

  const idempotencyKey = extractIdempotencyKey(first.check.response.body);
  // NOTE: Idempotency metadata is absent when the backend does not surface the
  // diagnostic key; we avoid serialising `undefined` so the future strict flag
  // can distinguish between missing and null values.
  return {
    group: IDEMPOTENCY_GROUP,
    consistent,
    firstStatus: first.check.response.status,
    secondStatus: second.check.response.status,
    ...(idempotencyKey !== null ? { idempotencyKey } : {}),
    ...(mismatchReason ? { mismatchReason } : {}),
  };
}

/** Computes the crash simulation summary if the scenario was executed. */
function computeCrashSummary(
  outcomes: readonly RobustnessCallOutcome[],
): RobustnessSummary["crashSimulation"] | null {
  const crashOutcome = outcomes.find((outcome) => outcome.call.name === CRASH_SCENARIO_NAME);
  if (!crashOutcome) {
    return null;
  }
  const error = extractJsonRpcError(crashOutcome.check.response.body);
  return {
    status: crashOutcome.check.response.status,
    eventCount: crashOutcome.events.length,
    ...omitUndefinedEntries({
      errorCode: error?.code,
      errorMessage: error?.message,
    }),
  };
}

/** Computes the timeout summary if the scenario was executed. */
function computeTimeoutSummary(
  outcomes: readonly RobustnessCallOutcome[],
): RobustnessSummary["timeout"] | null {
  const timeoutOutcome = outcomes.find((outcome) => outcome.call.name === TIMEOUT_SCENARIO_NAME);
  if (!timeoutOutcome) {
    return null;
  }
  const result = extractJsonRpcResult(timeoutOutcome.check.response.body);
  const error = extractJsonRpcError(timeoutOutcome.check.response.body);
  const statusToken =
    typeof (result as { status?: unknown })?.status === "string"
      ? ((result as { status?: string }).status as string)
      : typeof (error?.data as { status?: unknown })?.status === "string"
        ? (((error?.data as { status?: string })?.status as string) ?? null)
        : null;
  const timedOut = statusToken === "timeout" || statusToken === "cancelled";
  const message =
    (typeof (result as { message?: unknown })?.message === "string"
      ? ((result as { message?: string }).message as string)
      : undefined) ??
    (typeof error?.message === "string" ? error.message : undefined);
  // NOTE: With `exactOptionalPropertyTypes` enabled we must omit optional
  // fields instead of forwarding `undefined`, hence the conditional spread.
  return {
    status: timeoutOutcome.check.response.status,
    timedOut,
    statusToken,
    ...(message !== undefined ? { message } : {}),
  };
}

/** Extracts the idempotency key from either result or error payloads. */
function extractIdempotencyKey(body: unknown): string | null {
  const result = extractJsonRpcResult(body);
  if (result && typeof (result as { idempotency_key?: unknown }).idempotency_key === "string") {
    return (result as { idempotency_key?: string }).idempotency_key ?? null;
  }
  const error = extractJsonRpcError(body);
  if (error?.data && typeof (error.data as { idempotency_key?: unknown }).idempotency_key === "string") {
    return (error.data as { idempotency_key?: string }).idempotency_key ?? null;
  }
  return null;
}

/** Returns the last outcome executed for a given group identifier. */
function findLastOutcome(
  outcomes: readonly RobustnessCallOutcome[],
  group: string,
): RobustnessCallOutcome | null {
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index];
    if (outcome.call.group === group) {
      return outcome;
    }
  }
  return null;
}

/**
 * Ensures the Stage 9 robustness workflow observed the expected behaviours.
 * Throws an explicit error when a requirement is not satisfied so operators
 * can diagnose regressions rapidly.
 */
function enforceRobustnessInvariants(
  outcomes: readonly RobustnessCallOutcome[],
  summary: RobustnessSummary,
): void {
  const invalidSchema = findOutcomeByName(outcomes, "graph_diff_invalid");
  if (!invalidSchema) {
    throw new Error("Robustness validation missing the invalid-schema scenario");
  }
  if (invalidSchema.check.response.status !== 400) {
    throw new Error(
      `Expected invalid schema request to return HTTP 400, received ${invalidSchema.check.response.status}`,
    );
  }
  const invalidError = extractJsonRpcError(invalidSchema.check.response.body);
  if (!invalidError?.message || invalidError.message.trim().length === 0) {
    throw new Error("Invalid schema response must contain a descriptive error message");
  }

  const unknownTool = findOutcomeByScenario(outcomes, "unknown-tool");
  if (!unknownTool) {
    throw new Error("Robustness validation missing the unknown-tool scenario");
  }
  if (unknownTool.check.response.status !== 404) {
    throw new Error(
      `Expected unknown tool request to return HTTP 404, received ${unknownTool.check.response.status}`,
    );
  }
  const unknownError = extractJsonRpcError(unknownTool.check.response.body);
  if (!unknownError?.message || unknownError.message.trim().length === 0) {
    throw new Error("Unknown tool response must contain a descriptive error message");
  }

  if (!summary.idempotency || summary.idempotency.consistent !== true) {
    throw new Error("Idempotency check failed: responses for tx_begin were not identical");
  }

  const crashOutcome = findOutcomeByName(outcomes, CRASH_SCENARIO_NAME);
  if (!crashOutcome) {
    throw new Error("Robustness validation missing the child crash simulation scenario");
  }
  if (crashOutcome.events.length === 0) {
    throw new Error("Child crash scenario must emit at least one event to confirm telemetry");
  }
  const crashError = extractJsonRpcError(crashOutcome.check.response.body);
  if (!crashError?.message || crashError.message.trim().length === 0) {
    throw new Error("Child crash scenario must expose an error message describing the failure");
  }

  if (!summary.timeout || summary.timeout.timedOut !== true) {
    throw new Error("Reactive plan did not report a timeout or cancellation status");
  }
  if (summary.timeout.statusToken !== "timeout" && summary.timeout.statusToken !== "cancelled") {
    throw new Error(
      `Reactive plan reported unexpected status token: ${summary.timeout.statusToken ?? "<missing>"}`,
    );
  }
}

/** Locates an outcome by its logical scenario identifier. */
function findOutcomeByScenario(
  outcomes: readonly RobustnessCallOutcome[],
  scenario: string,
): RobustnessCallOutcome | null {
  return outcomes.find((outcome) => outcome.call.scenario === scenario) ?? null;
}

/** Locates an outcome by its friendly call name. */
function findOutcomeByName(
  outcomes: readonly RobustnessCallOutcome[],
  name: string,
): RobustnessCallOutcome | null {
  return outcomes.find((outcome) => outcome.call.name === name) ?? null;
}
