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
      captureEvents: spec.captureEvents,
      group: spec.group,
      params,
      meta,
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
  const capturedAt = new Date().toISOString();
  const payload = events
    .map((event) =>
      toJsonlLine({
        scenario: call.scenario,
        name: call.name,
        capturedAt,
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
  if (typeof (error as { code?: unknown }).code === "number") {
    result.code = (error as { code?: number }).code;
  }
  if (typeof (error as { message?: unknown }).message === "string") {
    result.message = (error as { message?: string }).message;
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
    return (result as { events?: unknown[] }).events ?? [];
  }
  const error = extractJsonRpcError(body);
  if (error?.data && Array.isArray((error.data as { events?: unknown }).events)) {
    return (error.data as { events?: unknown[] }).events ?? [];
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
    return {
      scenario: outcome.call.scenario,
      name: outcome.call.name,
      method: outcome.call.method,
      status: outcome.check.response.status,
      statusText: outcome.check.response.statusText,
      errorCode: error?.code,
      errorMessage: error?.message,
      idempotent: typeof (result as { idempotent?: unknown })?.idempotent === "boolean"
        ? ((result as { idempotent?: boolean }).idempotent as boolean)
        : undefined,
      idempotencyKey: extractIdempotencyKey(outcome.check.response.body) ?? undefined,
    };
  });

  const idempotency = computeIdempotencySummary(outcomes);
  const crashSimulation = computeCrashSummary(outcomes);
  const timeout = computeTimeoutSummary(outcomes);

  return {
    artefacts: {
      inputsJsonl: join(runRoot, ROBUSTNESS_JSONL_FILES.inputs),
      outputsJsonl: join(runRoot, ROBUSTNESS_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, ROBUSTNESS_JSONL_FILES.events),
      httpSnapshotLog: join(runRoot, ROBUSTNESS_JSONL_FILES.log),
    },
    checks,
    idempotency: idempotency ?? undefined,
    crashSimulation: crashSimulation ?? undefined,
    timeout: timeout ?? undefined,
  };
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

  return {
    group: IDEMPOTENCY_GROUP,
    idempotencyKey: extractIdempotencyKey(first.check.response.body) ?? undefined,
    consistent,
    firstStatus: first.check.response.status,
    secondStatus: second.check.response.status,
    mismatchReason,
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
    errorCode: error?.code,
    errorMessage: error?.message,
    eventCount: crashOutcome.events.length,
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
  const timedOut =
    Boolean((result as { status?: unknown })?.status === "timeout") ||
    Boolean((error?.data as { status?: unknown })?.status === "timeout");
  const message =
    (typeof (result as { message?: unknown })?.message === "string"
      ? ((result as { message?: string }).message as string)
      : undefined) ??
    (typeof error?.message === "string" ? error.message : undefined);
  return {
    status: timeoutOutcome.check.response.status,
    timedOut,
    message,
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
