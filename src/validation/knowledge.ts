import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckArtefactTargets,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
} from "./runSetup.js";

/** JSONL artefacts dedicated to the knowledge & values validation phase. */
export const KNOWLEDGE_JSONL_FILES = {
  inputs: "inputs/08_knowledge.jsonl",
  outputs: "outputs/08_knowledge.jsonl",
  events: "events/08_knowledge.jsonl",
  log: "logs/knowledge_http.json",
} as const;

/** Directory that collects artefacts produced by Stage 8 tooling. */
const KNOWLEDGE_ARTIFACTS_DIR = "artifacts/knowledge";

/** File persisted when the `values_graph_export` tool succeeds. */
const VALUES_GRAPH_ARTIFACT = "values_graph_export.json";

/** File persisted when the `causal_export` tool succeeds for values. */
const VALUES_CAUSAL_ARTIFACT = "causal_export.json";

/** File persisted under `report/` to expose the aggregated highlights. */
const KNOWLEDGE_SUMMARY_FILENAME = "knowledge_summary.json";

/** Internal mapping reused when persisting HTTP request/response artefacts. */
const KNOWLEDGE_TARGETS: HttpCheckArtefactTargets = {
  inputs: KNOWLEDGE_JSONL_FILES.inputs,
  outputs: KNOWLEDGE_JSONL_FILES.outputs,
};

/** Snapshot describing the JSON-RPC payload executed during the validation. */
export interface KnowledgeCallContext {
  /** HTTP environment used to reach the MCP endpoint. */
  readonly environment: HttpEnvironmentSummary;
  /** Chronological collection of outcomes recorded so far. */
  readonly previousCalls: readonly KnowledgeCallOutcome[];
}

/** Function signature used to compute dynamic JSON-RPC parameters. */
export type KnowledgeParamsFactory = (context: KnowledgeCallContext) => unknown;

/**
 * Specification of a JSON-RPC call executed during the knowledge workflow.
 * Each entry corresponds to a line appended in the JSONL artefacts.
 */
export interface KnowledgeCallSpec {
  /** Logical scenario advertised in the artefacts (assist/plan/subgraph/values). */
  readonly scenario: string;
  /** Friendly identifier persisted alongside the request artefacts. */
  readonly name: string;
  /** JSON-RPC method invoked against the MCP endpoint. */
  readonly method: string;
  /** Optional params object or factory invoked before dispatching the request. */
  readonly params?: unknown | KnowledgeParamsFactory;
  /** When false, response events are not appended to `events/08_knowledge.jsonl`. */
  readonly captureEvents?: boolean;
  /** Optional callback invoked after the call completes to persist artefacts. */
  readonly afterExecute?: KnowledgeCallAfterHook;
}

/** Representation of a call after parameter factories resolved to JSON values. */
export type ExecutedKnowledgeCall = Omit<KnowledgeCallSpec, "params"> & {
  readonly params?: unknown;
};

/** Outcome persisted for each JSON-RPC call executed during the workflow. */
export interface KnowledgeCallOutcome {
  readonly call: ExecutedKnowledgeCall;
  readonly check: HttpCheckSnapshot;
  readonly events: unknown[];
}

/** Shared state collected while executing the knowledge workflow. */
export interface KnowledgePhaseState {
  valuesGraphExportPath: string | null;
  causalExportPath: string | null;
}

/** Context forwarded to {@link KnowledgeCallAfterHook}. */
export interface KnowledgeCallAfterHookContext {
  readonly runRoot: string;
  readonly environment: HttpEnvironmentSummary;
  readonly outcome: KnowledgeCallOutcome;
  readonly previousCalls: readonly KnowledgeCallOutcome[];
  readonly state: KnowledgePhaseState;
}

/** Hook signature allowing callers to persist supplementary artefacts. */
export type KnowledgeCallAfterHook = (
  context: KnowledgeCallAfterHookContext,
) => Promise<void> | void;

/**
 * Configuration accepted by {@link buildDefaultKnowledgeCalls}. Callers can
 * override the identifiers/values used by the canned validation scenario
 * without rewriting the entire call plan.
 */
export interface DefaultKnowledgeOptions {
  /** Prompt forwarded to `kg_assist` for the primary knowledge query. */
  readonly assistQuery?: string;
  /** Context forwarded alongside the knowledge query. */
  readonly assistContext?: string;
  /** Goal advertised when requesting a suggested plan. */
  readonly planGoal?: string;
  /** Node identifiers extracted from the subgraph during validation. */
  readonly subgraphNodes?: readonly string[];
  /** Topic forwarded to the values surface. */
  readonly valuesTopic?: string;
}

/** Options accepted by {@link runKnowledgePhase}. */
export interface KnowledgePhaseOptions {
  readonly calls?: KnowledgeCallSpec[];
  readonly knowledge?: DefaultKnowledgeOptions;
}

/** Result returned by {@link runKnowledgePhase}. */
export interface KnowledgePhaseResult {
  readonly outcomes: readonly KnowledgeCallOutcome[];
  readonly summary: KnowledgeSummary;
  readonly summaryPath: string;
  readonly valuesGraphExportPath: string | null;
  readonly causalExportPath: string | null;
}

/** Summary structure persisted in `report/knowledge_summary.json`. */
export interface KnowledgeSummary {
  readonly artefacts: {
    readonly inputsJsonl: string;
    readonly outputsJsonl: string;
    readonly eventsJsonl: string;
    readonly httpSnapshotLog: string;
    readonly valuesGraphExport?: string | null;
    readonly causalExport?: string | null;
  };
  readonly knowledge: {
    readonly assistQuery?: string;
    readonly answerPreview?: string;
    readonly citationCount?: number;
    readonly planTitle?: string;
    readonly planSteps?: number;
    readonly subgraphNodes?: number;
    readonly subgraphEdges?: number;
  };
  readonly values: {
    readonly topic?: string;
    readonly explanationPreview?: string;
    readonly explanationConsistent: boolean;
    readonly citationCount?: number;
  };
}

/**
 * Executes the Stage 8 knowledge & values validation call plan while persisting
 * all artefacts expected by the operator checklist.
 */
export async function runKnowledgePhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: KnowledgePhaseOptions = {},
): Promise<KnowledgePhaseResult> {
  const calls = options.calls ?? buildDefaultKnowledgeCalls(options.knowledge);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const outcomes: KnowledgeCallOutcome[] = [];
  const state: KnowledgePhaseState = { valuesGraphExportPath: null, causalExportPath: null };

  for (let index = 0; index < calls.length; index += 1) {
    const spec = calls[index];
    const params =
      typeof spec.params === "function"
        ? (spec.params as KnowledgeParamsFactory)({ environment, previousCalls: outcomes })
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

    const executedCall: ExecutedKnowledgeCall = {
      scenario: spec.scenario,
      name: spec.name,
      method: spec.method,
      captureEvents: spec.captureEvents,
      params,
    };

    await appendHttpCheckArtefactsToFiles(runRoot, KNOWLEDGE_TARGETS, check, KNOWLEDGE_JSONL_FILES.log);

    const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
    if (events.length) {
      await appendKnowledgeEvents(runRoot, executedCall, events);
    }

    const outcome: KnowledgeCallOutcome = { call: executedCall, check, events };
    if (spec.afterExecute) {
      await spec.afterExecute({ runRoot, environment, outcome, previousCalls: outcomes, state });
    }
    outcomes.push(outcome);
  }

  const summary = buildKnowledgeSummary(runRoot, outcomes, state);
  const summaryPath = join(runRoot, "report", KNOWLEDGE_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);

  return {
    outcomes,
    summary,
    summaryPath,
    valuesGraphExportPath: state.valuesGraphExportPath,
    causalExportPath: state.causalExportPath,
  };
}

/**
 * Builds the default call plan covering assistive knowledge queries, plan
 * suggestions, subgraph inspection and values reasoning expected by Stage 8.
 */
export function buildDefaultKnowledgeCalls(
  options: DefaultKnowledgeOptions = {},
): KnowledgeCallSpec[] {
  const assistQuery =
    options.assistQuery ?? "Quels sont les risques principaux lors de la validation multi-agent ?";
  const assistContext =
    options.assistContext ??
    "Nous voulons auditer Self-Codex : liste les pièges connus côté MCP et instrumentation.";
  const planGoal =
    options.planGoal ?? "Préparer un plan de validation knowledge/values pour Self-Codex.";
  const subgraphNodes = options.subgraphNodes ?? ["root", "values", "knowledge"];
  const valuesTopic = options.valuesTopic ?? "gouvernance des connaissances";

  return [
    {
      scenario: "knowledge",
      name: "kg_assist_primary",
      method: "kg_assist",
      params: {
        query: assistQuery,
        context: assistContext,
      },
    },
    {
      scenario: "knowledge",
      name: "kg_suggest_plan",
      method: "kg_suggest_plan",
      params: {
        goal: planGoal,
        constraints: ["Couverture latence", "Validation redaction"],
      },
    },
    {
      scenario: "knowledge",
      name: "kg_get_subgraph",
      method: "kg_get_subgraph",
      params: {
        node_ids: subgraphNodes,
        depth: 2,
      },
    },
    {
      scenario: "values",
      name: "values_explain_primary",
      method: "values_explain",
      params: {
        topic: valuesTopic,
        perspective: "opérateur validation",
      },
    },
    {
      scenario: "values",
      name: "values_explain_repeat",
      method: "values_explain",
      params: ({ previousCalls }: KnowledgeCallContext) => ({
        topic: valuesTopic,
        perspective: "opérateur validation",
        reference_answer: extractExplanation(previousCalls, "values_explain_primary"),
      }),
    },
    {
      scenario: "values",
      name: "values_graph_export_snapshot",
      method: "values_graph_export",
      captureEvents: false,
      params: {
        format: "json",
        include_annotations: true,
      },
      afterExecute: async ({ runRoot, outcome, state }) => {
        const path = await persistValuesGraphArtefact(runRoot, outcome);
        state.valuesGraphExportPath = path;
      },
    },
    {
      scenario: "values",
      name: "values_causal_export_snapshot",
      method: "causal_export",
      captureEvents: false,
      params: {
        namespace: "values",
        scope: { latest_only: true },
      },
      afterExecute: async ({ runRoot, outcome, state }) => {
        const path = await persistCausalExportArtefact(runRoot, outcome);
        state.causalExportPath = path;
      },
    },
  ];
}

/** Builds a deterministic JSON-RPC identifier for knowledge calls. */
function buildJsonRpcId(index: number, call: KnowledgeCallSpec): string {
  const scenarioToken = call.scenario.replace(/[^a-zA-Z0-9]+/g, "-");
  const nameToken = call.name.replace(/[^a-zA-Z0-9]+/g, "-");
  return `knowledge_${index}_${scenarioToken}_${nameToken}`;
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
async function appendKnowledgeEvents(
  runRoot: string,
  call: ExecutedKnowledgeCall,
  events: unknown[],
): Promise<void> {
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
  await writeFile(join(runRoot, KNOWLEDGE_JSONL_FILES.events), payload, {
    encoding: "utf8",
    flag: "a",
  });
}

/** Extracts an explanation string from previous values calls (if available). */
function extractExplanation(previousCalls: readonly KnowledgeCallOutcome[], method: string): string | undefined {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== method) {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    const explanation = result?.explanation;
    if (typeof explanation === "string" && explanation.length > 0) {
      return explanation;
    }
  }
  return undefined;
}

/**
 * Persists the payload returned by the `values_graph_export` tool so operators
 * can inspect the knowledge graph snapshot without replaying the JSON-RPC call.
 */
async function persistValuesGraphArtefact(
  runRoot: string,
  outcome: KnowledgeCallOutcome,
): Promise<string | null> {
  const result = extractJsonRpcResult(outcome.check.response.body);
  if (!result) {
    return null;
  }
  const target = join(runRoot, KNOWLEDGE_ARTIFACTS_DIR, VALUES_GRAPH_ARTIFACT);
  await writeJsonFile(target, result);
  return target;
}

/**
 * Persists the payload returned by `causal_export` so operators can inspect the
 * causal memory snapshot dedicated to values reasoning.
 */
async function persistCausalExportArtefact(
  runRoot: string,
  outcome: KnowledgeCallOutcome,
): Promise<string | null> {
  const result = extractJsonRpcResult(outcome.check.response.body);
  if (!result) {
    return null;
  }
  const target = join(runRoot, KNOWLEDGE_ARTIFACTS_DIR, VALUES_CAUSAL_ARTIFACT);
  await writeJsonFile(target, result);
  return target;
}

/**
 * Aggregates the execution outcomes into a concise report consumed by operators
 * to confirm the Stage 8 automation exercised the expected behaviour.
 */
export function buildKnowledgeSummary(
  runRoot: string,
  outcomes: readonly KnowledgeCallOutcome[],
  state: KnowledgePhaseState,
): KnowledgeSummary {
  const outcomesByName = new Map<string, KnowledgeCallOutcome>();
  for (const outcome of outcomes) {
    outcomesByName.set(outcome.call.name, outcome);
  }

  const assistOutcome = outcomesByName.get("kg_assist_primary");
  const assistParams = assistOutcome?.call.params as { query?: string } | undefined;
  const assistResult = extractJsonRpcResult(assistOutcome?.check.response.body ?? null);
  const answerPreview = typeof assistResult?.answer === "string" ? assistResult.answer : undefined;
  const assistCitations = Array.isArray(assistResult?.citations)
    ? (assistResult!.citations as unknown[]).length
    : undefined;

  const planOutcome = outcomesByName.get("kg_suggest_plan");
  const planResult = extractJsonRpcResult(planOutcome?.check.response.body ?? null);
  const planTitle = typeof planResult?.plan === "object" && planResult.plan
    ? (planResult.plan as { title?: unknown }).title
    : undefined;
  const planSteps = Array.isArray((planResult?.plan as { steps?: unknown })?.steps)
    ? ((planResult!.plan as { steps?: unknown }).steps as unknown[]).length
    : undefined;

  const subgraphOutcome = outcomesByName.get("kg_get_subgraph");
  const subgraphResult = extractJsonRpcResult(subgraphOutcome?.check.response.body ?? null);
  const nodeCount = Array.isArray((subgraphResult?.graph as { nodes?: unknown })?.nodes)
    ? ((subgraphResult!.graph as { nodes?: unknown }).nodes as unknown[]).length
    : undefined;
  const edgeCount = Array.isArray((subgraphResult?.graph as { edges?: unknown })?.edges)
    ? ((subgraphResult!.graph as { edges?: unknown }).edges as unknown[]).length
    : undefined;

  const valuesPrimary = extractJsonRpcResult(
    outcomesByName.get("values_explain_primary")?.check.response.body ?? null,
  );
  const valuesRepeat = extractJsonRpcResult(
    outcomesByName.get("values_explain_repeat")?.check.response.body ?? null,
  );

  const topic = typeof valuesPrimary?.topic === "string" ? valuesPrimary.topic : undefined;
  const explanationA = typeof valuesPrimary?.explanation === "string" ? valuesPrimary.explanation : undefined;
  const explanationB = typeof valuesRepeat?.explanation === "string" ? valuesRepeat.explanation : undefined;
  const explanationConsistent = Boolean(explanationA && explanationB && explanationA === explanationB);
  const valuesCitations = Array.isArray(valuesPrimary?.citations)
    ? (valuesPrimary!.citations as unknown[]).length
    : undefined;

  return {
    artefacts: {
      inputsJsonl: join(runRoot, KNOWLEDGE_JSONL_FILES.inputs),
      outputsJsonl: join(runRoot, KNOWLEDGE_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, KNOWLEDGE_JSONL_FILES.events),
      httpSnapshotLog: join(runRoot, KNOWLEDGE_JSONL_FILES.log),
      valuesGraphExport: state.valuesGraphExportPath,
      causalExport: state.causalExportPath,
    },
    knowledge: {
      assistQuery: typeof assistParams?.query === "string" ? assistParams.query : undefined,
      answerPreview,
      citationCount: assistCitations,
      planTitle: typeof planTitle === "string" ? planTitle : undefined,
      planSteps,
      subgraphNodes: nodeCount,
      subgraphEdges: edgeCount,
    },
    values: {
      topic,
      explanationPreview: explanationA,
      explanationConsistent,
      citationCount: valuesCitations,
    },
  };
}
