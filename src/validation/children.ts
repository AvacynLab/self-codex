import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
  type HttpCheckArtefactTargets,
} from "./runSetup.js";

/**
 * Stage 5 validation helpers covering the Codex child orchestration workflow.
 *
 * The module mirrors the previous validation stages by exposing a reusable
 * runner that executes a deterministic JSON-RPC call plan, persists artefacts
 * inside the canonical `runs/<id>/` layout, and aggregates a concise summary for
 * operators. Each helper includes extensive documentation so future agents can
 * adapt the workflow to bespoke environments without re-learning the
 * expectations captured in `AGENTS.md`.
 */

/** Relative JSONL artefacts dedicated to the child validation workflow. */
export const CHILDREN_JSONL_FILES = {
  inputs: "inputs/05_children.jsonl",
  outputs: "outputs/05_children.jsonl",
  events: "events/05_children.jsonl",
  log: "logs/children_http.json",
} as const;

/** Internal target mapping reused for every HTTP snapshot. */
const CHILDREN_TARGETS: HttpCheckArtefactTargets = {
  inputs: CHILDREN_JSONL_FILES.inputs,
  outputs: CHILDREN_JSONL_FILES.outputs,
};

/** Directory (relative to the validation run root) storing child artefacts. */
const CHILDREN_ARTIFACT_DIR = "artifacts/children";

/** Filename of the persisted child conversation transcript. */
const CHILDREN_CONVERSATION_FILENAME = "conversation.json";

/** Filename of the summarised lifecycle document stored under `report/`. */
const CHILDREN_SUMMARY_FILENAME = "children_summary.json";

/** Goal forwarded to the spawn tool when callers do not override it. */
const DEFAULT_CHILD_GOAL = "Collect telemetry for validation stage 5";

/** Prompt used when pinging the child via `child_send`. */
const DEFAULT_CHILD_PROMPT = "Provide a short status update for the validation harness.";

/**
 * Default resource envelope forwarded to the spawn tool. The values remain
 * conservative so the sample automation can succeed on constrained hosts while
 * still exercising the limit management flow (stage 5 requires tightening the
 * quotas after attachment).
 */
const DEFAULT_INITIAL_LIMITS = {
  cpu_ms: 4_000,
  memory_mb: 128,
  wall_ms: 120_000,
} as const;

/** Limits applied after `child_set_limits` to trigger the monitoring hooks. */
const DEFAULT_REDUCED_LIMITS = {
  cpu_ms: 1_500,
  memory_mb: 96,
  wall_ms: 60_000,
} as const;

/** Structured representation of child resource limits. */
export interface ChildLimits {
  readonly cpu_ms: number;
  readonly memory_mb: number;
  readonly wall_ms: number;
}

/** Context propagated to parameter factories during the workflow. */
export interface ChildCallContext {
  readonly environment: HttpEnvironmentSummary;
  readonly previousCalls: readonly ChildCallOutcome[];
}

/** Function signature for dynamic parameter generation. */
export type ChildParamsFactory = (context: ChildCallContext) => unknown;

/**
 * Specification of a JSON-RPC call executed during the child validation phase.
 */
export interface ChildCallSpec {
  /** Logical scenario bucket advertised in artefacts (spawn/attach/limits/…). */
  readonly scenario: string;
  /** Friendly identifier persisted in JSONL entries. */
  readonly name: string;
  /** JSON-RPC method executed against the MCP endpoint. */
  readonly method: string;
  /** Optional params object or factory invoked before dispatching the request. */
  readonly params?: unknown | ChildParamsFactory;
  /** When false, events extracted from the response are not recorded. */
  readonly captureEvents?: boolean;
  /** Optional hook invoked after the call completes to persist artefacts. */
  readonly afterExecute?: ChildCallAfterHook;
}

/** Representation of a call after the params factory resolved to JSON values. */
export type ExecutedChildCall = Omit<ChildCallSpec, "params"> & { readonly params?: unknown };

/** Outcome persisted for each call executed during the workflow. */
export interface ChildCallOutcome {
  readonly call: ExecutedChildCall;
  readonly check: HttpCheckSnapshot;
  readonly events: unknown[];
}

/** Hook signature exposed to {@link ChildCallSpec.afterExecute}. */
export type ChildCallAfterHook = (context: ChildCallAfterHookContext) => Promise<void> | void;

/** Context forwarded to {@link ChildCallAfterHook}. */
export interface ChildCallAfterHookContext {
  readonly runRoot: string;
  readonly environment: HttpEnvironmentSummary;
  readonly outcome: ChildCallOutcome;
  readonly previousCalls: readonly ChildCallOutcome[];
}

/**
 * Configuration accepted by {@link buildDefaultChildrenCalls}. CLI callers can
 * override the defaults without re-implementing the entire call plan.
 */
export interface DefaultChildPlanOptions {
  readonly goal?: string;
  readonly prompt?: string;
  readonly initialLimits?: ChildLimits;
  readonly reducedLimits?: ChildLimits;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Options accepted by {@link runChildrenPhase}. Providing a custom call list is
 * primarily useful for unit tests whereas production callers typically rely on
 * the default plan.
 */
export interface ChildPhaseOptions {
  readonly calls?: ChildCallSpec[];
  readonly plan?: DefaultChildPlanOptions;
}

/** Structured summary document persisted under `report/children_summary.json`. */
export interface ChildrenPhaseSummaryDocument {
  readonly capturedAt: string;
  readonly childId: string | null;
  readonly goal: string | null;
  readonly initialLimits: ChildLimits | null;
  readonly updatedLimits: ChildLimits | null;
  readonly prompt: string | null;
  readonly replyText: string | null;
  readonly calls: Array<{
    readonly scenario: string;
    readonly name: string;
    readonly method: string;
    readonly status: number;
    readonly durationMs: number;
  }>;
  readonly events: {
    readonly total: number;
    readonly types: Record<string, number>;
    readonly samples: unknown[];
  };
  readonly artefacts: {
    readonly requestsJsonl: string;
    readonly responsesJsonl: string;
    readonly eventsJsonl: string;
    readonly httpLog: string;
    readonly conversation?: string;
  };
}

/**
 * Aggregated result returned by {@link runChildrenPhase}. Exposing the summary
 * path enables CLI callers to provide actionable console hints.
 */
export interface ChildrenPhaseResult {
  readonly outcomes: ChildCallOutcome[];
  readonly summary: ChildrenPhaseSummaryDocument;
  readonly summaryPath: string;
  readonly conversationPath?: string;
}

/**
 * Builds the default JSON-RPC call sequence for stage 5. The plan intentionally
 * covers both the happy path (spawn/attach/send) and the quota tightening step
 * requested by the validation checklist.
 */
export function buildDefaultChildrenCalls(options: DefaultChildPlanOptions = {}): ChildCallSpec[] {
  const goal = options.goal ?? DEFAULT_CHILD_GOAL;
  const prompt = options.prompt ?? DEFAULT_CHILD_PROMPT;
  const initialLimits = options.initialLimits ?? DEFAULT_INITIAL_LIMITS;
  const reducedLimits = options.reducedLimits ?? DEFAULT_REDUCED_LIMITS;
  const metadata = options.metadata ?? { stage: "children-validation" };

  return [
    {
      scenario: "spawn",
      name: "child_spawn_codex",
      method: "child_spawn_codex",
      params: {
        name: "validation-child",
        goal,
        metadata,
        limits: initialLimits,
      },
    },
    {
      scenario: "attach",
      name: "child_attach",
      method: "child_attach",
      params: ({ previousCalls }: ChildCallContext) => {
        const spawnResult = requireResult(previousCalls, "child_spawn_codex");
        const childId = extractChildId(spawnResult);
        if (!childId) {
          throw new Error("child_attach requires child_spawn_codex to return a child identifier");
        }
        return {
          child_id: childId,
          channels: ["control", "events"],
        };
      },
    },
    {
      scenario: "limits",
      name: "child_set_limits",
      method: "child_set_limits",
      params: ({ previousCalls }: ChildCallContext) => {
        const childId = requireChildId(previousCalls);
        return {
          child_id: childId,
          limits: reducedLimits,
          reason: "tighten quotas for validation",
        };
      },
    },
    {
      scenario: "interaction",
      name: "child_send_prompt",
      method: "child_send",
      params: ({ previousCalls }: ChildCallContext) => {
        const childId = requireChildId(previousCalls);
        return {
          child_id: childId,
          message: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
          options: { expect_events: true },
        };
      },
      afterExecute: async ({ runRoot, outcome }) => {
        const conversationPath = join(runRoot, CHILDREN_ARTIFACT_DIR, CHILDREN_CONVERSATION_FILENAME);
        await writeJsonFile(conversationPath, {
          capturedAt: new Date().toISOString(),
          request: outcome.call.params ?? null,
          response: outcome.check.response.body,
        });
      },
    },
    {
      scenario: "teardown",
      name: "child_kill",
      method: "child_kill",
      params: ({ previousCalls }: ChildCallContext) => {
        const childId = requireChildId(previousCalls);
        return {
          child_id: childId,
          reason: "validation_run_complete",
        };
      },
    },
  ];
}

/** Convenience helper extracting the JSON-RPC `result` payload. */
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

/** Retrieves the child identifier from a JSON-RPC result payload when present. */
function extractChildId(result: Record<string, unknown>): string | null {
  const directId = result.child_id;
  if (typeof directId === "string" && directId) {
    return directId;
  }

  const child = result.child;
  if (child && typeof child === "object" && !Array.isArray(child)) {
    const nestedId = (child as { id?: unknown }).id;
    if (typeof nestedId === "string" && nestedId) {
      return nestedId;
    }
  }

  const session = result.session;
  if (session && typeof session === "object" && !Array.isArray(session)) {
    const sessionChildId = (session as { child_id?: unknown }).child_id;
    if (typeof sessionChildId === "string" && sessionChildId) {
      return sessionChildId;
    }
  }

  return null;
}

/** Ensures a previous call exposed the child identifier before proceeding. */
function requireChildId(previousCalls: readonly ChildCallOutcome[]): string {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    const result = extractJsonRpcResult(outcome.check.response.body);
    if (result) {
      const childId = extractChildId(result);
      if (childId) {
        return childId;
      }
    }
  }
  throw new Error("Expected a prior call to return a child identifier");
}

/** Helper returning the result payload of a previous call by name. */
function requireResult(previousCalls: readonly ChildCallOutcome[], name: string): Record<string, unknown> {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.name === name) {
      const result = extractJsonRpcResult(outcome.check.response.body);
      if (!result) {
        throw new Error(`Call '${name}' did not expose a JSON-RPC result payload`);
      }
      return result;
    }
  }
  throw new Error(`Expected call '${name}' to be executed before building dependent params`);
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
async function appendChildEvents(runRoot: string, call: ExecutedChildCall, events: unknown[]): Promise<void> {
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
  await writeFile(join(runRoot, CHILDREN_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/**
 * Executes the child validation workflow end-to-end and persists artefacts.
 */
export async function runChildrenPhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: ChildPhaseOptions = {},
): Promise<ChildrenPhaseResult> {
  if (!runRoot) {
    throw new Error("runChildrenPhase requires a run root directory");
  }
  if (!environment || !environment.baseUrl) {
    throw new Error("runChildrenPhase requires a valid HTTP environment");
  }

  const calls = options.calls ?? buildDefaultChildrenCalls(options.plan);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const outcomes: ChildCallOutcome[] = [];
  let conversationPath: string | undefined;

  for (let index = 0; index < calls.length; index += 1) {
    const spec = calls[index];
    const params = typeof spec.params === "function"
      ? (spec.params as ChildParamsFactory)({ environment, previousCalls: outcomes })
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

    const executedCall: ExecutedChildCall = {
      scenario: spec.scenario,
      name: spec.name,
      method: spec.method,
      captureEvents: spec.captureEvents,
      params,
    };

    await appendHttpCheckArtefactsToFiles(runRoot, CHILDREN_TARGETS, check, CHILDREN_JSONL_FILES.log);

    const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
    if (events.length) {
      await appendChildEvents(runRoot, executedCall, events);
    }

    const outcome: ChildCallOutcome = { call: executedCall, check, events };
    if (spec.afterExecute) {
      await spec.afterExecute({ runRoot, environment, outcome, previousCalls: outcomes });
      if (executedCall.name === "child_send_prompt") {
        conversationPath = join(runRoot, CHILDREN_ARTIFACT_DIR, CHILDREN_CONVERSATION_FILENAME);
      }
    }

    outcomes.push(outcome);
  }

  const summary = buildChildrenSummary(runRoot, outcomes, {
    prompt: options.plan?.prompt ?? DEFAULT_CHILD_PROMPT,
    conversationPath,
  });
  const summaryPath = join(runRoot, "report", CHILDREN_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);

  return { outcomes, summary, summaryPath, conversationPath };
}

/**
 * Builds the lifecycle summary persisted alongside the raw artefacts. The
 * helper computes lightweight statistics (latency per call, event frequencies)
 * and points operators to the conversation transcript when available.
 */
export function buildChildrenSummary(
  runRoot: string,
  outcomes: readonly ChildCallOutcome[],
  context: { prompt?: string; conversationPath?: string } = {},
): ChildrenPhaseSummaryDocument {
  let childId: string | null = null;
  let goal: string | null = null;
  let initialLimits: ChildLimits | null = null;
  let updatedLimits: ChildLimits | null = null;
  let replyText: string | null = null;

  for (const outcome of outcomes) {
    const result = extractJsonRpcResult(outcome.check.response.body);
    if (!result) {
      continue;
    }

    const potentialId = extractChildId(result);
    if (potentialId && !childId) {
      childId = potentialId;
    }

    if (!goal) {
      const child = result.child;
      if (child && typeof child === "object" && !Array.isArray(child)) {
        const maybeGoal = (child as { goal?: unknown }).goal;
        if (typeof maybeGoal === "string") {
          goal = maybeGoal;
        }
      }
      const metaGoal = result.goal;
      if (typeof metaGoal === "string") {
        goal = metaGoal;
      }
    }

    if (!initialLimits) {
      const limits = extractLimits(result);
      if (limits) {
        initialLimits = limits;
      }
    } else if (outcome.call.name === "child_set_limits") {
      const limits = extractLimits(result);
      if (limits) {
        updatedLimits = limits;
      }
    }

    if (outcome.call.name === "child_send_prompt" && !replyText) {
      replyText = extractReplyText(result);
    }
  }

  const events = outcomes.flatMap((outcome) => outcome.events);
  const eventStats: Record<string, number> = {};
  for (const event of events) {
    const type = extractEventType(event);
    eventStats[type] = (eventStats[type] ?? 0) + 1;
  }

  const calls = outcomes.map((outcome) => ({
    scenario: outcome.call.scenario,
    name: outcome.call.name,
    method: outcome.call.method,
    status: outcome.check.response.status,
    durationMs: outcome.check.durationMs,
  }));

  const conversationAbsolute = context.conversationPath ?? undefined;

  return {
    capturedAt: new Date().toISOString(),
    childId,
    goal,
    initialLimits,
    updatedLimits,
    prompt: context.prompt ?? null,
    replyText,
    calls,
    events: {
      total: events.length,
      types: eventStats,
      samples: events.slice(0, 5),
    },
    artefacts: {
      requestsJsonl: join(runRoot, CHILDREN_JSONL_FILES.inputs),
      responsesJsonl: join(runRoot, CHILDREN_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, CHILDREN_JSONL_FILES.events),
      httpLog: join(runRoot, CHILDREN_JSONL_FILES.log),
      conversation: conversationAbsolute,
    },
  };
}

/** Extracts limits from a JSON-RPC result payload. */
function extractLimits(result: Record<string, unknown>): ChildLimits | null {
  const limitsCandidate = result.limits ?? (result.child && typeof result.child === "object" && !Array.isArray(result.child)
    ? (result.child as { limits?: unknown }).limits
    : undefined);
  if (!limitsCandidate || typeof limitsCandidate !== "object" || Array.isArray(limitsCandidate)) {
    return null;
  }
  const payload = limitsCandidate as Record<string, unknown>;
  const cpu = payload.cpu_ms;
  const memory = payload.memory_mb;
  const wall = payload.wall_ms;
  if (typeof cpu === "number" && typeof memory === "number" && typeof wall === "number") {
    return { cpu_ms: cpu, memory_mb: memory, wall_ms: wall };
  }
  return null;
}

/** Extracts a human readable reply from a child message response. */
function extractReplyText(result: Record<string, unknown>): string | null {
  const reply = result.reply ?? result.response ?? result.message;
  if (!reply || typeof reply !== "object") {
    return null;
  }
  if (Array.isArray(reply)) {
    const firstText = reply
      .map((entry) => extractTextFromContent(entry))
      .find((value) => value !== null);
    return firstText ?? null;
  }
  const replyRecord = reply as Record<string, unknown>;
  if (Array.isArray(replyRecord.content)) {
    const firstText = replyRecord.content
      .map((entry) => extractTextFromContent(entry))
      .find((value) => value !== null);
    if (firstText) {
      return firstText;
    }
  }
  const directText = replyRecord.text;
  if (typeof directText === "string" && directText) {
    return directText;
  }
  return null;
}

/** Attempts to extract textual content from a reply entry. */
function extractTextFromContent(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const type = (entry as { type?: unknown }).type;
  if (type === "text") {
    const text = (entry as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return null;
}

/** Extracts the event `type` for statistics, falling back to `unknown`. */
function extractEventType(event: unknown): string {
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const type = (event as { type?: unknown }).type;
    if (typeof type === "string" && type) {
      return type;
    }
  }
  return "unknown";
}

/** Builds a deterministic JSON-RPC identifier for child calls. */
function buildJsonRpcId(index: number, spec: ChildCallSpec): string {
  const scenarioToken = spec.scenario.replace(/[^a-zA-Z0-9]+/g, "-");
  const nameToken = spec.name.replace(/[^a-zA-Z0-9]+/g, "-");
  return `children_${index}_${scenarioToken}_${nameToken}`;
}
