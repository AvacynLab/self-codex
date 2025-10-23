// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/**
 * Stage 6 validation helpers targeting the Behaviour Tree planning workflow.
 *
 * The module mirrors previous validation phases by exposing a deterministic
 * JSON-RPC call plan that exercises Behaviour Tree compilation, blocking and
 * reactive execution, lifecycle controls (status/pause/resume), and cooperative
 * cancellation. Each helper documents the expected artefacts so operators can
 * trace every HTTP interaction when reviewing the generated validation run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
  type HttpCheckArtefactTargets,
} from "./runSetup.js";
import { coerceNullToUndefined, omitUndefinedEntries } from "../utils/object.js";

/** JSONL artefacts dedicated to the Behaviour Tree planning validation phase. */
export const PLAN_JSONL_FILES = {
  inputs: "inputs/06_plans.jsonl",
  outputs: "outputs/06_plans.jsonl",
  events: "events/06_plans.jsonl",
  log: "logs/plans_http.json",
} as const;

/** Internal mapping reused for every HTTP snapshot captured during the phase. */
const PLAN_TARGETS: HttpCheckArtefactTargets = {
  inputs: PLAN_JSONL_FILES.inputs,
  outputs: PLAN_JSONL_FILES.outputs,
};

/** Summary filename persisted under the `report/` directory for quick reviews. */
const PLAN_SUMMARY_FILENAME = "plans_summary.json";

/** Graph identifier used by the default Behaviour Tree sample. */
const DEFAULT_PLAN_GRAPH_ID = "validation_plan_bt";

/**
 * Default hierarchical plan compiled during the validation workflow. The graph
 * features three sequential tasks (collect → transform → persist) and relies on
 * the `noop` MCP tool so the automation can run in constrained environments.
 */
const DEFAULT_PLAN_GRAPH = {
  id: DEFAULT_PLAN_GRAPH_ID,
  nodes: [
    {
      id: "collect",
      kind: "task",
      label: "Collect data",
      attributes: { bt_tool: "noop", bt_input_key: "payload" },
    },
    {
      id: "transform",
      kind: "task",
      label: "Transform data",
      attributes: { bt_tool: "noop", bt_input_key: "payload" },
    },
    {
      id: "persist",
      kind: "task",
      label: "Persist data",
      attributes: { bt_tool: "noop", bt_input_key: "payload" },
    },
  ],
  edges: [
    { id: "collect_to_transform", from: { nodeId: "collect" }, to: { nodeId: "transform" } },
    { id: "transform_to_persist", from: { nodeId: "transform" }, to: { nodeId: "persist" } },
  ],
} as const;

/** Variables forwarded to Behaviour Tree runs when callers do not override them. */
const DEFAULT_PLAN_VARIABLES = {
  payload: {
    stage: "plans",
    objective: "validation",
    created_at: () => new Date().toISOString(),
  },
} as const;

/** Reactive execution defaults (tick cadence and overall timeout). */
const DEFAULT_REACTIVE_SETTINGS = {
  tickMs: 100,
  timeoutMs: 1_000,
} as const;

/** Snapshot describing the JSON-RPC payloads executed during the validation. */
export interface PlanCallContext {
  /** HTTP environment used to reach the MCP endpoint. */
  readonly environment: HttpEnvironmentSummary;
  /** Chronological collection of outcomes recorded so far. */
  readonly previousCalls: readonly PlanCallOutcome[];
}

/** Function signature used to compute dynamic JSON-RPC parameters. */
export type PlanParamsFactory = (context: PlanCallContext) => unknown;

/**
 * Specification of a JSON-RPC call executed during the planning validation
 * phase. Each entry corresponds to a line appended in the JSONL artefacts.
 */
export interface PlanCallSpec {
  /** Logical scenario advertised in the artefacts (compile/run/pause/cancel…). */
  readonly scenario: string;
  /** Friendly identifier persisted alongside the request artefacts. */
  readonly name: string;
  /** JSON-RPC method invoked against the MCP endpoint. */
  readonly method: string;
  /** Optional params object or factory invoked before dispatching the request. */
  readonly params?: unknown | PlanParamsFactory;
  /** When false, response events are not appended to `events/06_plans.jsonl`. */
  readonly captureEvents?: boolean;
  /** Optional callback invoked after the call completes to persist artefacts. */
  readonly afterExecute?: PlanCallAfterHook;
}

/** Representation of a call after parameter factories resolved to JSON values. */
export type ExecutedPlanCall = Omit<PlanCallSpec, "params"> & { readonly params?: unknown };

/** Outcome persisted for each JSON-RPC call executed during the workflow. */
export interface PlanCallOutcome {
  readonly call: ExecutedPlanCall;
  readonly check: HttpCheckSnapshot;
  readonly events: unknown[];
}

/** Context forwarded to {@link PlanCallAfterHook}. */
export interface PlanCallAfterHookContext {
  readonly runRoot: string;
  readonly environment: HttpEnvironmentSummary;
  readonly outcome: PlanCallOutcome;
  readonly previousCalls: readonly PlanCallOutcome[];
}

/** Hook signature allowing callers to persist supplementary artefacts. */
export type PlanCallAfterHook = (context: PlanCallAfterHookContext) => Promise<void> | void;

/**
 * Configuration accepted by {@link buildDefaultPlanCalls}. Callers can override
 * the hierarchical graph, runtime variables, or reactive scheduling settings
 * without re-implementing the entire call plan.
 */
export interface DefaultPlanOptions {
  readonly graph?: typeof DEFAULT_PLAN_GRAPH;
  readonly variables?: Record<string, unknown>;
  readonly reactive?: {
    readonly tickMs?: number;
    readonly timeoutMs?: number;
  };
}

/** Options accepted by {@link runPlanPhase}. */
export interface PlanPhaseOptions {
  readonly calls?: PlanCallSpec[];
  readonly plan?: DefaultPlanOptions;
}

/** Shape of the summary persisted under `report/plans_summary.json`. */
export interface PlanPhaseSummaryDocument {
  readonly capturedAt: string;
  readonly graphId: string | null;
  readonly compile: {
    readonly success: boolean;
    readonly error?: string;
  };
  readonly runBt: {
    readonly status: string | null;
    readonly ticks: number | null;
    readonly runId: string | null;
    readonly opId: string | null;
  };
  readonly runReactive: {
    readonly status: string | null;
    readonly loopTicks: number | null;
    readonly runId: string | null;
    readonly opId: string | null;
    readonly cancelled: boolean;
    readonly cancellationError?: string;
  };
  readonly lifecycle: {
    readonly statusSnapshot?: Record<string, unknown> | null;
    readonly pauseResult?: Record<string, unknown> | null;
    readonly resumeResult?: Record<string, unknown> | null;
    readonly cancelResult?: Record<string, unknown> | null;
  };
  readonly opCancel: {
    readonly ok: boolean;
    readonly outcome: string | null;
    readonly reason: string | null;
    readonly runId: string | null;
    readonly opId: string | null;
    readonly progress: number | null;
    readonly error?: string;
  };
  readonly events: {
    readonly total: number;
    readonly types: Record<string, number>;
  };
  readonly artefacts: {
    readonly requestsJsonl: string;
    readonly responsesJsonl: string;
    readonly eventsJsonl: string;
    readonly httpLog: string;
  };
}

/** Result returned by {@link runPlanPhase}. */
export interface PlanPhaseResult {
  readonly outcomes: readonly PlanCallOutcome[];
  readonly summary: PlanPhaseSummaryDocument;
  readonly summaryPath: string;
}

/**
 * Executes the planning validation workflow and persists JSONL/summary artefacts.
 */
export async function runPlanPhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: PlanPhaseOptions = {},
): Promise<PlanPhaseResult> {
  const calls = options.calls ?? buildDefaultPlanCalls(options.plan);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const outcomes: PlanCallOutcome[] = [];

  for (let index = 0; index < calls.length; index += 1) {
    const spec = calls[index];
    const params = typeof spec.params === "function"
      ? (spec.params as PlanParamsFactory)({ environment, previousCalls: outcomes })
      : spec.params;

    const requestBody: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: buildJsonRpcId(index, spec),
      method: spec.method,
    };
    if (params !== undefined) {
      requestBody.params = params;
    }

    const check = await performHttpCheck(`${spec.scenario}:${spec.name}`, {
      method: "POST",
      url: environment.baseUrl,
      headers,
      body: requestBody,
    });

    // Avoid serialising `undefined` optional fields so future strict optional
    // typing treats recorded artefacts as compliant.
    const executedCall: ExecutedPlanCall = {
      scenario: spec.scenario,
      name: spec.name,
      method: spec.method,
      ...(spec.captureEvents !== undefined ? { captureEvents: spec.captureEvents } : {}),
      ...(params !== undefined ? { params } : {}),
    };

    await appendHttpCheckArtefactsToFiles(runRoot, PLAN_TARGETS, check, PLAN_JSONL_FILES.log);

    const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
    if (events.length) {
      await appendPlanEvents(runRoot, executedCall, events);
    }

    const outcome: PlanCallOutcome = { call: executedCall, check, events };
    validatePlanOutcome(outcome, outcomes);

    if (spec.afterExecute) {
      await spec.afterExecute({ runRoot, environment, outcome, previousCalls: outcomes });
    }

    outcomes.push(outcome);
  }

  const summary = buildPlanSummary(runRoot, outcomes);
  const summaryPath = join(runRoot, "report", PLAN_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);

  return { outcomes, summary, summaryPath };
}

/**
 * Builds the default call plan covering compilation, execution, lifecycle
 * controls and cooperative cancellation.
 */
export function buildDefaultPlanCalls(options: DefaultPlanOptions = {}): PlanCallSpec[] {
  const graph = options.graph ?? DEFAULT_PLAN_GRAPH;
  const variables = normalisePlanVariables(options.variables ?? DEFAULT_PLAN_VARIABLES);
  const reactiveSettings = {
    tickMs: options.reactive?.tickMs ?? DEFAULT_REACTIVE_SETTINGS.tickMs,
    timeoutMs: options.reactive?.timeoutMs ?? DEFAULT_REACTIVE_SETTINGS.timeoutMs,
  };

  return [
    {
      scenario: "compile",
      name: "compile_bt",
      method: "plan_compile_bt",
      params: { graph },
    },
    {
      scenario: "run_bt",
      name: "plan_run_bt",
      method: "plan_run_bt",
      params: ({ previousCalls }: PlanCallContext) => ({
        tree: requireCompiledTree(previousCalls),
        variables,
        correlation: { run_id: "validation_bt_run" },
      }),
    },
    {
      scenario: "reactive",
      name: "plan_run_reactive",
      method: "plan_run_reactive",
      params: ({ previousCalls }: PlanCallContext) => ({
        tree: requireCompiledTree(previousCalls),
        variables,
        tick_ms: reactiveSettings.tickMs,
        timeout_ms: reactiveSettings.timeoutMs,
        correlation: { run_id: "validation_reactive_run" },
      }),
    },
    {
      scenario: "lifecycle",
      name: "plan_status",
      method: "plan_status",
      params: ({ previousCalls }: PlanCallContext) => ({ run_id: requireReactiveRunId(previousCalls) }),
    },
    {
      scenario: "lifecycle",
      name: "plan_pause",
      method: "plan_pause",
      params: ({ previousCalls }: PlanCallContext) => ({ run_id: requireReactiveRunId(previousCalls) }),
    },
    {
      scenario: "lifecycle",
      name: "plan_resume",
      method: "plan_resume",
      params: ({ previousCalls }: PlanCallContext) => ({ run_id: requireReactiveRunId(previousCalls) }),
    },
    {
      scenario: "cancellation",
      name: "plan_cancel",
      method: "plan_cancel",
      params: ({ previousCalls }: PlanCallContext) => ({
        run_id: requireReactiveRunId(previousCalls),
        op_id: requireReactiveOpId(previousCalls),
      }),
    },
    {
      scenario: "cancellation",
      name: "op_cancel",
      method: "op_cancel",
      params: ({ previousCalls }: PlanCallContext) => ({
        op_id: requireReactiveOpId(previousCalls),
        reason: "validation-stage-6",
      }),
      captureEvents: false,
    },
  ];
}

/**
 * Normalises plan variables so dynamic timestamps are evaluated before dispatch.
 */
function normalisePlanVariables(variables: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "function") {
      resolved[key] = value();
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      resolved[key] = normalisePlanVariables(value as Record<string, unknown>);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Builds a deterministic JSON-RPC identifier for plan calls. The helper mirrors
 * the behaviour adopted by other validation stages to simplify cross-referencing.
 */
function buildJsonRpcId(index: number, call: PlanCallSpec): string {
  const scenarioToken = call.scenario.replace(/[^a-zA-Z0-9]+/g, "-");
  const nameToken = call.name.replace(/[^a-zA-Z0-9]+/g, "-");
  return `plans_${index}_${scenarioToken}_${nameToken}`;
}

/** Extracts the `result` payload from a JSON-RPC response when available. */
function extractJsonRpcResult(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  return result as Record<string, unknown>;
}

/** Extracts response events (if any) from a JSON-RPC body. */
function extractEvents(body: unknown): unknown[] {
  const result = extractJsonRpcResult(body);
  if (!result) {
    return [];
  }
  const events = result.events;
  if (Array.isArray(events)) {
    return events;
  }
  return [];
}

/** Appends captured events to the phase-specific `.jsonl` artefact. */
async function appendPlanEvents(runRoot: string, call: ExecutedPlanCall, events: unknown[]): Promise<void> {
  if (!events.length) {
    return;
  }
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
  await writeFile(join(runRoot, PLAN_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/**
 * Retrieves the compiled Behaviour Tree from a previous call outcome.
 */
function requireCompiledTree(previousCalls: readonly PlanCallOutcome[]): Record<string, unknown> {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== "plan_compile_bt") {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    if (!result) {
      break;
    }
    const tree = result.tree ?? result;
    if (tree && typeof tree === "object" && !Array.isArray(tree)) {
      return tree as Record<string, unknown>;
    }
    if (result.id && result.root) {
      return result;
    }
  }
  throw new Error("Expected plan_compile_bt to provide a compiled tree before execution");
}

/** Extracts the reactive run identifier from previous outcomes. */
function requireReactiveRunId(previousCalls: readonly PlanCallOutcome[]): string {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== "plan_run_reactive") {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    if (result) {
      const runId = result.run_id;
      if (typeof runId === "string" && runId.length > 0) {
        return runId;
      }
    }
  }
  throw new Error("Expected plan_run_reactive to expose a run identifier before lifecycle calls");
}

/** Extracts the reactive operation identifier from previous outcomes. */
function requireReactiveOpId(previousCalls: readonly PlanCallOutcome[]): string {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== "plan_run_reactive") {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    if (result) {
      const opId = result.op_id;
      if (typeof opId === "string" && opId.length > 0) {
        return opId;
      }
    }
  }
  throw new Error("Expected plan_run_reactive to expose an operation identifier before cancellation");
}

/** Builds the lifecycle summary persisted alongside the raw artefacts. */
export function buildPlanSummary(
  runRoot: string,
  outcomes: readonly PlanCallOutcome[],
): PlanPhaseSummaryDocument {
  let graphId: string | null = null;
  let btRunStatus: string | null = null;
  let btRunTicks: number | null = null;
  let btRunId: string | null = null;
  let btOpId: string | null = null;
  let reactiveStatus: string | null = null;
  let reactiveLoopTicks: number | null = null;
  let reactiveRunId: string | null = null;
  let reactiveOpId: string | null = null;
  let reactiveCancelled = false;
  let reactiveCancellationError: string | undefined;
  let statusSnapshot: Record<string, unknown> | null | undefined;
  let pauseResult: Record<string, unknown> | null | undefined;
  let resumeResult: Record<string, unknown> | null | undefined;
  let cancelResult: Record<string, unknown> | null | undefined;
  let compileError: string | undefined;
  let opCancelOk = false;
  let opCancelOutcome: string | null = null;
  let opCancelReason: string | null = null;
  let opCancelRunId: string | null = null;
  let opCancelOpId: string | null = null;
  let opCancelProgress: number | null = null;
  let opCancelError: string | undefined;

  const eventStats: Record<string, number> = {};
  let totalEvents = 0;

  for (const outcome of outcomes) {
    for (const event of outcome.events) {
      const type = extractEventType(event);
      if (!eventStats[type]) {
        eventStats[type] = 0;
      }
      eventStats[type] += 1;
      totalEvents += 1;
    }

    const result = extractJsonRpcResult(outcome.check.response.body);
    if (!result) {
      const error = extractJsonRpcError(outcome.check.response.body);
      if (outcome.call.method === "plan_compile_bt" && error) {
        compileError = error;
      }
      if (outcome.call.method === "plan_cancel" && error) {
        reactiveCancelled = error.includes("cancelled");
        reactiveCancellationError = error;
      }
      if (outcome.call.method === "op_cancel" && error) {
        opCancelError = error;
      }
      continue;
    }

    if (outcome.call.method === "plan_compile_bt") {
      const id = typeof result.graph_id === "string" ? result.graph_id : typeof result.id === "string" ? result.id : null;
      if (id) {
        graphId = id;
      }
    } else if (outcome.call.method === "plan_run_bt") {
      btRunStatus = typeof result.status === "string" ? result.status : null;
      btRunTicks = typeof result.ticks === "number" ? result.ticks : null;
      btRunId = typeof result.run_id === "string" ? result.run_id : null;
      btOpId = typeof result.op_id === "string" ? result.op_id : null;
    } else if (outcome.call.method === "plan_run_reactive") {
      reactiveStatus = typeof result.status === "string" ? result.status : null;
      reactiveLoopTicks = typeof result.loop_ticks === "number" ? result.loop_ticks : null;
      reactiveRunId = typeof result.run_id === "string" ? result.run_id : null;
      reactiveOpId = typeof result.op_id === "string" ? result.op_id : null;
      reactiveCancelled = (result.status as string | undefined) === "cancelled";
    } else if (outcome.call.method === "plan_status") {
      statusSnapshot = result;
    } else if (outcome.call.method === "plan_pause") {
      pauseResult = result;
    } else if (outcome.call.method === "plan_resume") {
      resumeResult = result;
    } else if (outcome.call.method === "plan_cancel") {
      cancelResult = result;
      if (result.cancelled === true) {
        reactiveCancelled = true;
      }
      if (typeof result.error === "string") {
        reactiveCancellationError = result.error;
      }
    } else if (outcome.call.method === "op_cancel") {
      opCancelOk = result.ok === true;
      opCancelOutcome = typeof result.outcome === "string" ? result.outcome : opCancelOutcome;
      opCancelReason = typeof result.reason === "string" ? result.reason : opCancelReason;
      opCancelRunId = typeof result.run_id === "string" ? result.run_id : opCancelRunId;
      opCancelOpId = typeof result.op_id === "string" ? result.op_id : opCancelOpId;
      if (typeof result.progress === "number") {
        opCancelProgress = result.progress;
      }
      if (result.error && typeof result.error === "string") {
        opCancelError = result.error;
      }
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    graphId,
    compile: {
      success: !compileError,
      ...omitUndefinedEntries({ error: compileError }),
    },
    runBt: {
      status: btRunStatus,
      ticks: btRunTicks,
      runId: btRunId,
      opId: btOpId,
    },
    runReactive: {
      status: reactiveStatus,
      loopTicks: reactiveLoopTicks,
      runId: reactiveRunId,
      opId: reactiveOpId,
      cancelled: reactiveCancelled,
      ...omitUndefinedEntries({ cancellationError: reactiveCancellationError }),
    },
    // Lifecycle transitions occasionally omit extended payloads (snapshot,
    // pause/resume confirmations, cancellation details). Converting null-ish
    // placeholders to `undefined` before applying `omitUndefinedEntries`
    // prevents serialising empty optional fields once
    // `exactOptionalPropertyTypes` enforces strict omission semantics.
    lifecycle:
      omitUndefinedEntries({
        statusSnapshot: coerceNullToUndefined(statusSnapshot),
        pauseResult: coerceNullToUndefined(pauseResult),
        resumeResult: coerceNullToUndefined(resumeResult),
        cancelResult: coerceNullToUndefined(cancelResult),
      }) satisfies PlanPhaseSummaryDocument["lifecycle"],
    opCancel: {
      ok: opCancelOk,
      outcome: opCancelOutcome,
      reason: opCancelReason,
      runId: opCancelRunId,
      opId: opCancelOpId,
      progress: opCancelProgress,
      ...omitUndefinedEntries({ error: opCancelError }),
    },
    events: {
      total: totalEvents,
      types: eventStats,
    },
    artefacts: {
      requestsJsonl: join(runRoot, PLAN_JSONL_FILES.inputs),
      responsesJsonl: join(runRoot, PLAN_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, PLAN_JSONL_FILES.events),
      httpLog: join(runRoot, PLAN_JSONL_FILES.log),
    },
  };
}

/** Extracts the JSON-RPC error message when available. */
function extractJsonRpcError(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

/** Derives an event type string from an arbitrary payload. */
function extractEventType(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "unknown";
  }
  const type = (event as { type?: unknown }).type;
  if (typeof type === "string" && type.length > 0) {
    return type;
  }
  const phase = (event as { phase?: unknown }).phase;
  if (typeof phase === "string" && phase.length > 0) {
    return `phase:${phase}`;
  }
  return "unknown";
}

/**
 * Ensures each call outcome recorded during the planning phase satisfies the
 * behavioural expectations documented in Stage 6 of the checklist. The
 * validation intentionally errs on the side of strictness so regressions in the
 * MCP lifecycle (missing paused state, absent cancellation metadata, …) are
 * caught immediately when operators replay the workflow.
 */
function validatePlanOutcome(outcome: PlanCallOutcome, previousCalls: readonly PlanCallOutcome[]): void {
  const result = extractJsonRpcResult(outcome.check.response.body);
  const error = extractJsonRpcError(outcome.check.response.body);

  switch (outcome.call.method) {
    case "plan_compile_bt": {
      if (!result) {
        throw new Error("plan_compile_bt did not return a JSON-RPC result");
      }
      const tree = result.tree ?? result;
      if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
        throw new Error("plan_compile_bt response did not contain a compiled tree");
      }
      break;
    }
    case "plan_run_bt": {
      if (!result) {
        throw new Error("plan_run_bt failed: expected a JSON-RPC result");
      }
      const status = typeof result.status === "string" ? result.status.toLowerCase() : "";
      if (!status || (status !== "success" && status !== "running")) {
        throw new Error(`plan_run_bt returned an unexpected status: ${status || "<empty>"}`);
      }
      const ticks = typeof result.ticks === "number" ? result.ticks : null;
      if (ticks === null || ticks <= 0) {
        throw new Error(`plan_run_bt reported ${ticks ?? "no"} ticks (expected > 0)`);
      }
      if (!outcome.events.length) {
        throw new Error("plan_run_bt did not emit any events (expected scheduler journal)");
      }
      break;
    }
    case "plan_run_reactive": {
      if (!result) {
        throw new Error("plan_run_reactive failed: expected a JSON-RPC result");
      }
      const runId = typeof result.run_id === "string" ? result.run_id : "";
      const opId = typeof result.op_id === "string" ? result.op_id : "";
      if (!runId) {
        throw new Error("plan_run_reactive did not expose a run_id for lifecycle calls");
      }
      if (!opId) {
        throw new Error("plan_run_reactive did not expose an op_id for cancellation");
      }
      if (!outcome.events.length) {
        throw new Error("plan_run_reactive did not emit scheduler events");
      }
      break;
    }
    case "plan_status": {
      if (!result) {
        throw new Error("plan_status failed: expected a JSON-RPC result");
      }
      const state = typeof result.state === "string" ? result.state : "";
      if (!state) {
        throw new Error("plan_status response missing a lifecycle state");
      }
      break;
    }
    case "plan_pause": {
      if (!result) {
        throw new Error("plan_pause failed: expected a JSON-RPC result");
      }
      const state = typeof result.state === "string" ? result.state.toLowerCase() : "";
      const supportsResume = result.supports_resume === true;
      if (!state.includes("pause") && !supportsResume) {
        throw new Error(`plan_pause did not confirm a paused state (state=${state || "<empty>"})`);
      }
      break;
    }
    case "plan_resume": {
      if (!result) {
        throw new Error("plan_resume failed: expected a JSON-RPC result");
      }
      const state = typeof result.state === "string" ? result.state.toLowerCase() : "";
      const allowedStates = new Set(["running", "success", "completed"]);
      if (!allowedStates.has(state)) {
        throw new Error(`plan_resume returned unexpected state: ${state || "<empty>"}`);
      }
      break;
    }
    case "plan_cancel": {
      const expectedRunId = requireReactiveRunId(previousCalls);
      if (result) {
        const cancelled = result.cancelled === true || typeof result.status === "string" && result.status.toLowerCase() === "cancelled";
        const runIdMatches = typeof result.run_id !== "string" || result.run_id === expectedRunId;
        if (!cancelled) {
          throw new Error("plan_cancel response did not confirm cancellation");
        }
        if (!runIdMatches) {
          throw new Error("plan_cancel response referenced an unexpected run_id");
        }
      } else if (!error || !/cancel/i.test(error)) {
        throw new Error("plan_cancel failed without providing a cancellation error message");
      }
      break;
    }
    case "op_cancel": {
      if (!result) {
        throw new Error("op_cancel failed: expected a JSON-RPC result");
      }
      if (result.ok !== true) {
        throw new Error("op_cancel did not acknowledge the cancellation request");
      }
      const expectedOpId = requireReactiveOpId(previousCalls);
      if (typeof result.op_id === "string" && result.op_id !== expectedOpId) {
        throw new Error("op_cancel response referenced a different op_id than plan_run_reactive");
      }
      break;
    }
    default:
      break;
  }
}
