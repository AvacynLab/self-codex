import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';
import type { BaseToolCallSummary, ToolResponseSummary } from './baseTools.js';

import type { GraphDescriptorPayload, GraphGenerateResult, GraphMutateResult } from '../../../src/tools/graphTools.js';
import type {
  ValuesExplainResult,
  ValuesFilterResult,
  ValuesScoreResult,
  ValuesSetResult,
} from '../../../src/tools/valueTools.js';
import type { KgExportResult, KgInsertResult, KgQueryResult } from '../../../src/tools/knowledgeTools.js';
import type {
  PlanCompileBTResult,
  PlanDryRunResult,
  PlanFanoutResult,
  PlanJoinResult,
  PlanReduceResult,
  PlanRunBTResult,
  PlanRunReactiveExecutionSnapshot,
} from '../../../src/tools/planTools.js';
import type { ChildSendResult } from '../../../src/tools/childTools.js';
import type { PlanLifecycleSnapshot } from '../../../src/executor/planLifecycle.js';

/**
 * Summary describing how the plan and values validation stage exercised the MCP
 * surface. The persisted document feeds the final audit report without requiring
 * reprocessing of the raw artefacts emitted by the harness and includes the
 * individual call summaries for Stage 8 consolidation.
 */
export interface PlanningStageReport {
  /** Identifier of the validation run. */
  readonly runId: string;
  /** ISO timestamp describing when the stage finished executing. */
  readonly completedAt: string;
  /** High-level metrics extracted from the captured tool calls. */
  readonly metrics: {
    /** Total number of MCP invocations performed during the stage. */
    readonly totalCalls: number;
    /** Number of calls that returned an MCP-level error. */
    readonly errorCount: number;
  };
  /** Collection of tool call summaries captured during the stage. */
  readonly calls: BaseToolCallSummary[];
  /** Aggregated summary of the complex graph exercised by the stage. */
  readonly graph: {
    readonly graphId: string | null;
    readonly version: number | null;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly mutationCount: number;
    readonly metadataKeys: number;
  };
  /** Summary of the configured values and guard explanation captured. */
  readonly values: {
    readonly configuredValues: number;
    readonly relationships: number;
    readonly defaultThreshold: number | null;
    readonly explanationDecision: string | null;
    readonly explanationAllowed: boolean | null;
    readonly explanationViolations: number | null;
    readonly scoreValue: number | null;
    readonly scoreTotal: number | null;
    readonly scoreAllowed: boolean | null;
    readonly scoreThreshold: number | null;
    readonly filterAllowed: boolean | null;
    readonly filterThreshold: number | null;
    readonly filterScore: number | null;
    readonly filterViolations: number | null;
  };
  /** Summary of the executed plan runs (behaviour tree + reactive lifecycle). */
  readonly plan: {
    readonly bt: {
      readonly runId: string | null;
      readonly status: string | null;
      readonly ticks: number | null;
      readonly idempotent: boolean | null;
    };
    readonly reactive: {
      readonly runId: string | null;
      readonly status: string | null;
      readonly loopTicks: number | null;
      readonly schedulerTicks: number | null;
      readonly pauseState: string | null;
      readonly resumeState: string | null;
      readonly finalState: string | null;
    };
    readonly compiled: {
      readonly treeId: string | null;
      readonly rootType: string | null;
      readonly taskCount: number;
    };
    readonly fanout: {
      readonly runId: string | null;
      readonly opId: string | null;
      readonly childCount: number;
      readonly responsesCaptured: number;
      readonly rejectedCount: number;
      /** Number of children that failed to respond after retries. */
      readonly failedCount: number;
      /** Identifiers of children excluded from joins/reductions due to failures. */
      readonly degradedChildren: ReadonlyArray<string>;
    };
    readonly joins: ReadonlyArray<{
      readonly opId: string | null;
      readonly policy: PlanJoinResult['policy'];
      readonly satisfied: boolean;
      readonly successCount: number;
      readonly failureCount: number;
      readonly winningChild: string | null;
    }>;
    readonly reductions: ReadonlyArray<{
      readonly opId: string | null;
      readonly reducer: PlanReduceResult['reducer'];
      readonly aggregateKind: string;
      readonly childCount: number;
    }>;
  };
  /** Summary of the knowledge graph manipulations exercised. */
  readonly knowledge: {
    readonly inserted: number;
    readonly updated: number;
    readonly totalAfterInsert: number | null;
    readonly queried: number;
    readonly exported: number;
  };
}

/** Options accepted by {@link runPlanningStage}. */
export interface PlanningStageOptions {
  /** Shared validation run context (directories + trace factory). */
  readonly context: RunContext;
  /** Recorder used to persist deterministic tool artefacts. */
  readonly recorder: ArtifactRecorder;
  /** Optional factory injected by tests to control the MCP session lifecycle. */
  readonly createSession?: () => McpSession;
}

/** Result returned by {@link runPlanningStage}. */
export interface PlanningStageResult {
  /** Absolute path of the generated JSON report. */
  readonly reportPath: string;
  /** Collection of tool call summaries captured during the stage. */
  readonly calls: BaseToolCallSummary[];
  /** Snapshot of the mutated graph exercised during the stage. */
  readonly graph: {
    readonly graphId: string | null;
    readonly version: number | null;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly mutationCount: number;
    readonly metadataKeys: number;
    readonly descriptor: GraphDescriptorPayload | null;
  };
  /** Summary of the value guard configuration and explanation. */
  readonly values: {
    readonly configuredValues: number;
    readonly relationships: number;
    readonly defaultThreshold: number | null;
    readonly explanation: ValuesExplainResult | null;
    readonly score: ValuesScoreResult | null;
    readonly filter: ValuesFilterResult | null;
  };
  /** Behaviour tree execution outcome. */
  readonly btPlan: PlanRunBTResult | null;
  /** Reactive plan execution outcome. */
  readonly reactivePlan: {
    readonly run: PlanRunReactiveExecutionSnapshot | null;
    readonly pauseSnapshot: PlanLifecycleSnapshot | null;
    readonly resumeSnapshot: PlanLifecycleSnapshot | null;
    readonly finalSnapshot: PlanLifecycleSnapshot | null;
  };
  /** Knowledge graph activity summary. */
  readonly knowledge: {
    readonly inserted: KgInsertResult | null;
    readonly queried: KgQueryResult | null;
    readonly exported: KgExportResult | null;
  };
  /** Distribution-focused plan orchestration artefacts (fan-out, joins, reduce). */
  readonly orchestration: {
    readonly compiled: PlanCompileBTResult | null;
    readonly fanout: PlanFanoutResult | null;
    readonly joins: PlanJoinResult[];
    readonly reductions: PlanReduceResult[];
    readonly childResponses: Array<{
      readonly childId: string;
      readonly messageType: string | null;
      readonly status: 'fulfilled' | 'error';
      readonly attempts: number;
      readonly errorMessage: string | null;
    }>;
  };
}

/**
 * Extracts the first textual entry from an MCP response and attempts to decode
 * it as JSON. Returning the raw string keeps audit artefacts useful even when
 * the payload does not represent structured data.
 */
function parseTextContent(
  response: ToolCallRecord['response'],
): { parsed?: unknown; errorCode?: string | null; hint?: string | null } {
  const contentEntries = Array.isArray(response.content) ? response.content : [];
  const firstText = contentEntries.find(
    (entry): entry is { type?: string; text?: string } =>
      typeof entry?.text === 'string' && (entry.type === undefined || entry.type === 'text'),
  );
  if (!firstText?.text) {
    return { parsed: undefined, errorCode: null, hint: null };
  }

  try {
    const parsed = JSON.parse(firstText.text);
    const errorCode = typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : null;
    const hint = typeof (parsed as { hint?: unknown }).hint === 'string' ? (parsed as { hint: string }).hint : null;
    return { parsed, errorCode, hint };
  } catch {
    return { parsed: firstText.text, errorCode: null, hint: null };
  }
}

/** Builds a structured summary of the MCP response for the audit report. */
function summariseResponse(response: ToolCallRecord['response']): ToolResponseSummary {
  const { parsed, errorCode, hint } = parseTextContent(response);
  return {
    isError: response.isError ?? false,
    structured: response.structuredContent ?? undefined,
    parsedText: parsed,
    errorCode: errorCode ?? null,
    hint: hint ?? null,
  };
}

/**
 * Counts the number of task leaves contained in a compiled Behaviour Tree.
 * Traversing the structure keeps the stage report informative without
 * serialising the full tree in the summary payload.
 */
function countBehaviorTreeTasks(node: PlanCompileBTResult['root']): number {
  if (node.type === 'task') {
    return 1;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.reduce((total, child) => total + countBehaviorTreeTasks(child), 0);
  }
  if ('child' in node && node.child) {
    return countBehaviorTreeTasks(node.child);
  }
  return 0;
}

/**
 * Provides a compact textual description of the aggregate type returned by the
 * plan reduction helpers. Using a normalised string keeps the report easy to
 * scan while still conveying whether the reducer emitted text, JSON, null…
 */
function describeAggregateKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Extracts a human readable error message from the most recent tool call
 * summary. When the response payload contains structured details the helper
 * prioritises them over generic error codes so the report remains actionable.
 */
function extractLastErrorMessage(summaries: BaseToolCallSummary[]): string | null {
  const last = summaries.at(-1);
  if (!last || !last.response.isError) {
    return null;
  }

  const parsed = last.response.parsedText;
  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim().length > 0) {
      return error;
    }
    const detail = (parsed as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim().length > 0) {
      return detail;
    }
  }

  if (typeof last.response.hint === 'string' && last.response.hint.trim().length > 0) {
    return last.response.hint;
  }
  if (typeof last.response.errorCode === 'string' && last.response.errorCode.trim().length > 0) {
    return last.response.errorCode;
  }
  return null;
}

/**
 * Invokes an MCP tool while pushing the {@link BaseToolCallSummary} into the
 * provided sink. Transport failures are converted into synthetic entries so the
 * stage report still surfaces trace identifiers and artefact paths.
 */
async function callAndRecord(
  session: McpSession,
  toolName: string,
  payload: unknown,
  options: { scenario?: string },
  sink: BaseToolCallSummary[],
): Promise<ToolCallRecord | null> {
  try {
    const call = await session.callTool(toolName, payload);
    sink.push({
      toolName,
      scenario: options.scenario,
      traceId: call.traceId,
      durationMs: call.durationMs,
      artefacts: call.artefacts,
      response: summariseResponse(call.response),
    });
    return call;
  } catch (error) {
    if (error instanceof McpToolCallError) {
      sink.push({
        toolName,
        scenario: options.scenario,
        traceId: error.traceId,
        durationMs: error.durationMs,
        artefacts: error.artefacts,
        response: {
          isError: true,
          structured: undefined,
          parsedText:
            error.cause instanceof Error
              ? { message: error.cause.message, stack: error.cause.stack }
              : { message: String(error.cause) },
          errorCode: 'transport_failure',
          hint: null,
        },
      });
      return null;
    }
    throw error;
  }
}

/**
 * Executes Stage 5 of the validation campaign. The harness focuses on plan
 * execution primitives, value guard evaluation and knowledge graph operations
 * while exercising lifecycle controls (pause/resume) for reactive plans.
 */
export async function runPlanningStage(options: PlanningStageOptions): Promise<PlanningStageResult> {
  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-plans-values',
        clientVersion: '1.0.0',
        featureOverrides: {
          enableBT: true,
          enableReactiveScheduler: true,
          enablePlanLifecycle: true,
          enableBlackboard: true,
          enableStigmergy: true,
          enableAutoscaler: true,
          enableSupervisor: true,
          enableIdempotency: true,
          enableValueGuard: true,
          enableValuesExplain: true,
          enableKnowledge: true,
          enableAssist: true,
          enableEventsBus: true,
        },
      });

  await session.open();

  const calls: BaseToolCallSummary[] = [];

  let mutatedGraph: GraphDescriptorPayload | null = null;
  let mutationCount = 0;
  let valueSummary: ValuesSetResult | null = null;
  let valueScore: ValuesScoreResult | null = null;
  let valueFilter: ValuesFilterResult | null = null;
  let explanation: ValuesExplainResult | null = null;
  let dryRunSummary: PlanDryRunResult | null = null;
  let btResult: PlanRunBTResult | null = null;
  let reactiveResult: PlanRunReactiveExecutionSnapshot | null = null;
  let pauseSnapshot: PlanLifecycleSnapshot | null = null;
  let resumeSnapshot: PlanLifecycleSnapshot | null = null;
  let finalSnapshot: PlanLifecycleSnapshot | null = null;
  let knowledgeInsert: KgInsertResult | null = null;
  let knowledgeQuery: KgQueryResult | null = null;
  let knowledgeExport: KgExportResult | null = null;
  let compiledTree: PlanCompileBTResult | null = null;
  let fanoutPlan: PlanFanoutResult | null = null;
  const joinResults: PlanJoinResult[] = [];
  const reduceResults: PlanReduceResult[] = [];
  const childIdsToCancel: string[] = [];
  const fanoutResponses: Array<{
    childId: string;
    messageType: string | null;
    status: 'fulfilled' | 'error';
    attempts: number;
    errorMessage: string | null;
  }> = [];
  const responsiveChildren: string[] = [];
  const degradedChildren: string[] = [];

  try {
    const valuesSetCall = await callAndRecord(
      session,
      'values_set',
      {
        values: [
          { id: 'safety', label: 'Safety Assurance', weight: 0.6, tolerance: 0.1 },
          { id: 'efficiency', label: 'Operational Efficiency', weight: 0.4, tolerance: 0.2 },
          { id: 'compliance', label: 'Regulatory Compliance', weight: 0.5, tolerance: 0.05 },
        ],
        relationships: [
          { from: 'safety', to: 'compliance', kind: 'supports', weight: 0.7 },
          { from: 'efficiency', to: 'safety', kind: 'conflicts', weight: 0.35 },
        ],
        default_threshold: 0.55,
      },
      { scenario: 'values_set_baseline' },
      calls,
    );
    if (valuesSetCall && !valuesSetCall.response.isError) {
      valueSummary = (valuesSetCall.response.structuredContent ?? valuesSetCall.response) as ValuesSetResult;
    }

    // Define a shared plan impact profile so the guard scoring, filtering and
    // downstream plan simulations operate on consistent rationale entries.
    const scoringImpacts = [
      { value: 'safety', impact: 'support', severity: 0.8, rationale: 'Peer review provides guard rails.' },
      { value: 'efficiency', impact: 'risk', severity: 0.35, rationale: 'Additional validation introduces delay.' },
      { value: 'compliance', impact: 'support', severity: 0.7, rationale: 'Explicit sign-off enforces policy.' },
    ] as const;

    valueScore = await (async () => {
      const scoreCall = await callAndRecord(
        session,
        'values_score',
        {
          id: 'stage5-plan',
          label: 'Stage 5 – Lifecycle Validation',
          impacts: scoringImpacts,
          run_id: 'stage5-values-run',
        },
        { scenario: 'values_score_stage5' },
        calls,
      );
      if (scoreCall && !scoreCall.response.isError) {
        return (scoreCall.response.structuredContent ?? scoreCall.response) as ValuesScoreResult;
      }
      return null;
    })();

    valueFilter = await (async () => {
      const filterCall = await callAndRecord(
        session,
        'values_filter',
        {
          id: 'stage5-plan',
          label: 'Stage 5 – Lifecycle Validation',
          impacts: scoringImpacts,
          threshold: 0.6,
        },
        { scenario: 'values_filter_stage5' },
        calls,
      );
      if (filterCall && !filterCall.response.isError) {
        return (filterCall.response.structuredContent ?? filterCall.response) as ValuesFilterResult;
      }
      return null;
    })();

    const graphGenerateCall = await callAndRecord(
      session,
      'graph_generate',
      {
        name: 'stage5_workflow',
        default_weight: 3,
        tasks: {
          tasks: [
            { id: 'ingest', label: 'Ingest Signals', duration: 4 },
            { id: 'triage', label: 'Triage Alerts', depends_on: ['ingest'], duration: 6 },
            {
              id: 'enrich',
              label: 'Enrich Context',
              depends_on: ['ingest'],
              duration: 5,
              weight: 2,
            },
            {
              id: 'plan',
              label: 'Plan Response',
              depends_on: ['triage', 'enrich'],
              duration: 8,
            },
            {
              id: 'validate',
              label: 'Validate Response',
              depends_on: ['plan'],
              duration: 3,
            },
          ],
        },
      },
      { scenario: 'graph_generate_stage5' },
      calls,
    );

    let generatedGraph: GraphDescriptorPayload | null = null;
    if (graphGenerateCall && !graphGenerateCall.response.isError) {
      const structured = graphGenerateCall.response.structuredContent as GraphGenerateResult | undefined;
      if (structured?.graph) {
        generatedGraph = structured.graph;
      } else {
        const parsed = parseTextContent(graphGenerateCall.response).parsed as Partial<GraphGenerateResult> | undefined;
        if (parsed && typeof parsed === 'object' && parsed && 'graph' in parsed) {
          generatedGraph = (parsed as { graph?: GraphDescriptorPayload }).graph ?? null;
        }
      }
    }

    if (!generatedGraph) {
      throw new Error('graph_generate did not yield a graph descriptor');
    }

    const mutationOperations = [
      {
        op: 'add_node',
        node: {
          id: 'review',
          label: 'Peer Review',
          attributes: { critical: true, sla_minutes: 15 },
        },
      },
      {
        op: 'add_edge',
        edge: {
          from: 'plan',
          to: 'review',
          label: 'requires',
          weight: 1.2,
          attributes: { type: 'quality_gate' },
        },
      },
      {
        op: 'add_edge',
        edge: {
          from: 'review',
          to: 'validate',
          label: 'handoff',
          weight: 0.8,
          attributes: { assurance: 'high' },
        },
      },
      {
        op: 'set_node_attribute',
        id: 'triage',
        key: 'owner',
        value: 'responder_team',
      },
      {
        op: 'patch_metadata',
        set: { stage: 'planning', critical_path: true },
      },
    ] as const;

    const graphMutateCall = await callAndRecord(
      session,
      'graph_mutate',
      {
        graph: generatedGraph,
        operations: mutationOperations,
        op_id: 'stage5-graph-enrichment',
      },
      { scenario: 'graph_mutate_enrichment' },
      calls,
    );

    if (graphMutateCall && !graphMutateCall.response.isError) {
      const structured = graphMutateCall.response.structuredContent as GraphMutateResult | undefined;
      const parsed = structured ?? (parseTextContent(graphMutateCall.response).parsed as GraphMutateResult | undefined);
      if (parsed?.graph) {
        mutatedGraph = parsed.graph;
        mutationCount = Array.isArray(parsed.applied) ? parsed.applied.length : mutationCount;
      }
    }

    if (!mutatedGraph) {
      mutatedGraph = generatedGraph;
    }

    knowledgeInsert = await (async () => {
      const insertCall = await callAndRecord(
        session,
        'kg_insert',
        {
          triples: [
            {
              subject: 'stage5-plan',
              predicate: 'depends_on',
              object: 'knowledge-base',
              source: 'stage5',
              confidence: 0.92,
            },
            {
              subject: 'stage5-plan',
              predicate: 'requires',
              object: 'compliance-check',
              source: 'stage5',
              confidence: 0.88,
            },
          ],
        },
        { scenario: 'kg_insert_stage5' },
        calls,
      );
      if (insertCall && !insertCall.response.isError) {
        return (insertCall.response.structuredContent ?? insertCall.response) as KgInsertResult;
      }
      return null;
    })();

    knowledgeQuery = await (async () => {
      const queryCall = await callAndRecord(
        session,
        'kg_query',
        { subject: 'stage5-plan', limit: 10 },
        { scenario: 'kg_query_stage5' },
        calls,
      );
      if (queryCall && !queryCall.response.isError) {
        return (queryCall.response.structuredContent ?? queryCall.response) as KgQueryResult;
      }
      return null;
    })();

    knowledgeExport = await (async () => {
      const exportCall = await callAndRecord(
        session,
        'kg_export',
        {},
        { scenario: 'kg_export_stage5' },
        calls,
      );
      if (exportCall && !exportCall.response.isError) {
        return (exportCall.response.structuredContent ?? exportCall.response) as KgExportResult;
      }
      return null;
    })();

    dryRunSummary = await (async () => {
      const dryRunCall = await callAndRecord(
        session,
        'plan_dry_run',
        {
          plan_id: 'stage5-plan',
          plan_label: 'Stage 5 – Lifecycle Validation',
          threshold: 0.55,
          graph: mutatedGraph,
          impacts: [
            { value: 'safety', impact: 'support', severity: 0.8, rationale: 'Wait stages include guard rails.' },
            { value: 'efficiency', impact: 'risk', severity: 0.3, rationale: 'Peer review adds overhead.' },
            { value: 'compliance', impact: 'support', severity: 0.7, rationale: 'Explicit validation step.' },
          ],
        },
        { scenario: 'plan_dry_run_stage5' },
        calls,
      );
      if (dryRunCall && !dryRunCall.response.isError) {
        return (dryRunCall.response.structuredContent ?? dryRunCall.response) as PlanDryRunResult;
      }
      return null;
    })();

    explanation = await (async () => {
      const explainCall = await callAndRecord(
        session,
        'values_explain',
        {
          plan: {
            id: 'stage5-plan',
            label: 'Stage 5 – Lifecycle Validation',
            impacts: [
              { value: 'safety', impact: 'support', severity: 0.8, rationale: 'Aligned with review gate.' },
              { value: 'efficiency', impact: 'risk', severity: 0.35, rationale: 'Additional peer review.' },
              { value: 'compliance', impact: 'support', severity: 0.7, rationale: 'Validations enforced.' },
            ],
            threshold: 0.55,
          },
        },
        { scenario: 'values_explain_stage5' },
        calls,
      );
      if (explainCall && !explainCall.response.isError) {
        return (explainCall.response.structuredContent ?? explainCall.response) as ValuesExplainResult;
      }
      return null;
    })();

    // --- Behaviour tree compilation and distributed orchestration -----------
    compiledTree = await (async () => {
      const compileGraph = {
        id: 'stage5-compile-hier',
        nodes: [
          {
            id: 'compile-ingest',
            kind: 'task' as const,
            label: 'Ingest inputs',
            attributes: { bt_tool: 'noop', bt_input_key: 'ingest_payload' },
          },
          {
            id: 'compile-plan',
            kind: 'task' as const,
            label: 'Plan tasks',
            attributes: { bt_tool: 'wait', bt_input_key: 'plan_wait' },
          },
          {
            id: 'compile-validate',
            kind: 'task' as const,
            label: 'Validate outputs',
            attributes: { bt_tool: 'noop' },
          },
        ],
        edges: [
          { id: 'edge-ingest-plan', from: { nodeId: 'compile-ingest' }, to: { nodeId: 'compile-plan' }, label: 'sequence' },
          { id: 'edge-plan-validate', from: { nodeId: 'compile-plan' }, to: { nodeId: 'compile-validate' }, label: 'sequence' },
        ],
      } satisfies Record<string, unknown>;

      const compileCall = await callAndRecord(
        session,
        'plan_compile_bt',
        { graph: compileGraph },
        { scenario: 'plan_compile_bt_stage5' },
        calls,
      );
      if (compileCall && !compileCall.response.isError) {
        const structured = compileCall.response.structuredContent as PlanCompileBTResult | undefined;
        return structured ?? (parseTextContent(compileCall.response).parsed as PlanCompileBTResult | undefined) ?? null;
      }
      return null;
    })();

    fanoutPlan = await (async () => {
      const fanoutCall = await callAndRecord(
        session,
        'plan_fanout',
        {
          goal: 'Coordonner la validation Stage 5',
          prompt_template: {
            system: 'Clone {{child_name}} : objectif {{goal}}',
            user: [
              'Indice: {{child_index}}',
              'Focalisation: {{focus}}',
            ],
          },
          children_spec: {
            list: [
              { name: 'alpha', prompt_variables: { focus: 'analyse' } },
              { name: 'beta', prompt_variables: { focus: 'implementation' } },
              { name: 'gamma', prompt_variables: { focus: 'validation' } },
            ],
          },
          parallelism: 2,
          run_label: 'stage5-fanout',
        },
        { scenario: 'plan_fanout_stage5' },
        calls,
      );
      if (fanoutCall && !fanoutCall.response.isError) {
        const structured = fanoutCall.response.structuredContent as PlanFanoutResult | undefined;
        const parsed = structured ?? (parseTextContent(fanoutCall.response).parsed as PlanFanoutResult | undefined);
        if (parsed) {
          childIdsToCancel.push(...parsed.child_ids);
          return parsed;
        }
      }
      return null;
    })();

    if (fanoutPlan && fanoutPlan.child_ids.length > 0) {

      const maxSendAttempts = 2;
      for (const [index, childId] of fanoutPlan.child_ids.entries()) {
        const promptContent = `Stage 5 follow-up for ${childId} (#${index + 1})`;
        let attempts = 0;
        let sendResult: ChildSendResult | null = null;
        let awaitedType: string | null = null;
        let lastErrorMessage: string | null = null;

        while (attempts < maxSendAttempts && !sendResult) {
          attempts += 1;
          const scenarioBase = `plan_fanout_child_prompt_${index + 1}`;
          const scenario = attempts === 1 ? scenarioBase : `${scenarioBase}_retry${attempts - 1}`;
          const sendCall = await callAndRecord(
            session,
            'child_send',
            {
              child_id: childId,
              payload: { type: 'prompt', content: promptContent },
              expect: 'final',
              timeout_ms: 2_000,
            },
            { scenario },
            calls,
          );
          if (sendCall && !sendCall.response.isError) {
            const structured = sendCall.response.structuredContent as ChildSendResult | undefined;
            const parsed = structured ?? (parseTextContent(sendCall.response).parsed as ChildSendResult | undefined);
            if (parsed) {
              const awaited = parsed.awaited_message as { parsed?: { type?: unknown } | null } | null | undefined;
              const awaitedRaw =
                awaited && typeof awaited === 'object' && awaited?.parsed && typeof awaited.parsed === 'object'
                  ? (awaited.parsed as { type?: unknown }).type
                  : null;
              awaitedType = typeof awaitedRaw === 'string' ? awaitedRaw : null;
              sendResult = parsed;
            }
          } else {
            lastErrorMessage = extractLastErrorMessage(calls) ?? lastErrorMessage;
            if (attempts < maxSendAttempts) {
              await delay(125);
            }
          }
        }

        if (sendResult) {
          responsiveChildren.push(childId);
          fanoutResponses.push({
            childId,
            messageType: awaitedType,
            status: 'fulfilled',
            attempts,
            errorMessage: null,
          });
        } else {
          degradedChildren.push(childId);
          fanoutResponses.push({
            childId,
            messageType: null,
            status: 'error',
            attempts,
            errorMessage: lastErrorMessage,
          });
        }
      }

      const joinTargets = responsiveChildren.length > 0 ? responsiveChildren : fanoutPlan.child_ids;
      const consensusWeights = Object.fromEntries(joinTargets.map((childId, index) => [childId, index + 1] as const));
      const joinAllScenario = responsiveChildren.length > 0 && responsiveChildren.length < fanoutPlan.child_ids.length
        ? 'plan_join_all_stage5_degraded'
        : 'plan_join_all_stage5';
      const joinAllCall = await callAndRecord(
        session,
        'plan_join',
        {
          children: joinTargets,
          join_policy: 'all',
          timeout_sec: 2,
        },
        { scenario: joinAllScenario },
        calls,
      );
      if (joinAllCall && !joinAllCall.response.isError) {
        const structured = joinAllCall.response.structuredContent as PlanJoinResult | undefined;
        const parsed = structured ?? (parseTextContent(joinAllCall.response).parsed as PlanJoinResult | undefined);
        if (parsed) {
          joinResults.push(parsed);
        }
      }

      const joinQuorumCall = await callAndRecord(
        session,
        'plan_join',
        {
          children: joinTargets,
          join_policy: 'quorum',
          quorum_count: Math.max(1, Math.ceil(joinTargets.length / 2)),
          timeout_sec: 2,
          consensus: { mode: 'weighted', weights: consensusWeights, prefer_value: 'success' },
        },
        { scenario: 'plan_join_quorum_stage5' },
        calls,
      );
      if (joinQuorumCall && !joinQuorumCall.response.isError) {
        const structured = joinQuorumCall.response.structuredContent as PlanJoinResult | undefined;
        const parsed = structured ?? (parseTextContent(joinQuorumCall.response).parsed as PlanJoinResult | undefined);
        if (parsed) {
          joinResults.push(parsed);
        }
      }

      const reduceConcatCall = await callAndRecord(
        session,
        'plan_reduce',
        {
          children: joinTargets,
          reducer: 'concat',
        },
        { scenario: 'plan_reduce_concat_stage5' },
        calls,
      );
      if (reduceConcatCall && !reduceConcatCall.response.isError) {
        const structured = reduceConcatCall.response.structuredContent as PlanReduceResult | undefined;
        const parsed = structured ?? (parseTextContent(reduceConcatCall.response).parsed as PlanReduceResult | undefined);
        if (parsed) {
          reduceResults.push(parsed);
        }
      }

      const reduceMergeCall = await callAndRecord(
        session,
        'plan_reduce',
        {
          children: joinTargets,
          reducer: 'merge_json',
        },
        { scenario: 'plan_reduce_merge_json_stage5' },
        calls,
      );
      if (reduceMergeCall && !reduceMergeCall.response.isError) {
        const structured = reduceMergeCall.response.structuredContent as PlanReduceResult | undefined;
        const parsed = structured ?? (parseTextContent(reduceMergeCall.response).parsed as PlanReduceResult | undefined);
        if (parsed) {
          reduceResults.push(parsed);
        }
      }

      const reduceVoteCall = await callAndRecord(
        session,
        'plan_reduce',
        {
          children: joinTargets,
          reducer: 'vote',
          spec: {
            mode: 'majority',
            prefer_value: 'success',
            quorum: Math.max(1, Math.ceil(joinTargets.length / 2)),
          },
        },
        { scenario: 'plan_reduce_vote_stage5' },
        calls,
      );
      if (reduceVoteCall && !reduceVoteCall.response.isError) {
        const structured = reduceVoteCall.response.structuredContent as PlanReduceResult | undefined;
        const parsed = structured ?? (parseTextContent(reduceVoteCall.response).parsed as PlanReduceResult | undefined);
        if (parsed) {
          reduceResults.push(parsed);
        }
      }

      for (const [index, childId] of childIdsToCancel.entries()) {
        await callAndRecord(
          session,
          'child_cancel',
          { child_id: childId, signal: 'SIGINT', timeout_ms: 1_000 },
          { scenario: `plan_fanout_child_cancel_${index + 1}` },
          calls,
        );
      }
      childIdsToCancel.length = 0;
    }

    btResult = await (async () => {
      const btCall = await callAndRecord(
        session,
        'plan_run_bt',
        {
          tree: {
            id: 'stage5-bt-sequence',
            root: {
              type: 'sequence',
              id: 'bt-root',
              children: [
                {
                  type: 'cancellable',
                  id: 'guarded-wait',
                  child: { type: 'task', id: 'bt-wait', node_id: 'wait-node', tool: 'wait', input_key: 'wait_params' },
                },
                {
                  type: 'task',
                  id: 'bt-noop',
                  node_id: 'noop-node',
                  tool: 'noop',
                  input_key: 'noop_payload',
                },
              ],
            },
          },
          variables: {
            wait_params: { duration_ms: 1_500 },
            noop_payload: { result: 'stage5-bt-complete' },
          },
          run_id: 'stage5-bt-run',
          op_id: 'stage5-bt-op',
          graph_id: mutatedGraph.graph_id ?? generatedGraph.graph_id ?? null,
          timeout_ms: 10_000,
        },
        { scenario: 'plan_run_bt_stage5' },
        calls,
      );
      if (btCall && !btCall.response.isError) {
        return (btCall.response.structuredContent ?? btCall.response) as PlanRunBTResult;
      }
      return null;
    })();

    const reactiveRunId = 'stage5-reactive-run';
    const reactiveOpId = 'stage5-reactive-op';
    const reactiveCallPromise = callAndRecord(
      session,
      'plan_run_reactive',
      {
        tree: {
          id: 'stage5-reactive-tree',
          root: {
            type: 'sequence',
            id: 'reactive-root',
            children: [
              { type: 'task', id: 'reactive-wait-1', node_id: 'reactive-wait-1', tool: 'wait', input_key: 'wait_one' },
              {
                type: 'task',
                id: 'reactive-wait-2',
                node_id: 'reactive-wait-2',
                tool: 'wait',
                input_key: 'wait_two',
              },
              {
                type: 'task',
                id: 'reactive-noop',
                node_id: 'reactive-noop',
                tool: 'noop',
                input_key: 'reactive_noop',
              },
            ],
          },
        },
        variables: {
          wait_one: { duration_ms: 2_000 },
          wait_two: { duration_ms: 1_000 },
          reactive_noop: { result: 'reactive-finished' },
        },
        tick_ms: 100,
        timeout_ms: 20_000,
        run_id: reactiveRunId,
        op_id: reactiveOpId,
        graph_id: mutatedGraph.graph_id ?? generatedGraph.graph_id ?? null,
      },
      { scenario: 'plan_run_reactive_stage5' },
      calls,
    );

    await delay(200);

    const pauseCall = await callAndRecord(
      session,
      'plan_pause',
      { run_id: reactiveRunId },
      { scenario: 'plan_pause_reactive' },
      calls,
    );
    if (pauseCall && !pauseCall.response.isError) {
      pauseSnapshot = (pauseCall.response.structuredContent ?? pauseCall.response) as PlanLifecycleSnapshot;
    }

    const pausedStatusCall = await callAndRecord(
      session,
      'plan_status',
      { run_id: reactiveRunId },
      { scenario: 'plan_status_paused' },
      calls,
    );
    if (pausedStatusCall && !pausedStatusCall.response.isError) {
      pauseSnapshot = pauseSnapshot ?? ((pausedStatusCall.response.structuredContent ?? pausedStatusCall.response) as PlanLifecycleSnapshot);
    }

    await delay(150);

    const resumeCall = await callAndRecord(
      session,
      'plan_resume',
      { run_id: reactiveRunId },
      { scenario: 'plan_resume_reactive' },
      calls,
    );
    if (resumeCall && !resumeCall.response.isError) {
      resumeSnapshot = (resumeCall.response.structuredContent ?? resumeCall.response) as PlanLifecycleSnapshot;
    }

    const resumedStatusCall = await callAndRecord(
      session,
      'plan_status',
      { run_id: reactiveRunId },
      { scenario: 'plan_status_resumed' },
      calls,
    );
    if (resumedStatusCall && !resumedStatusCall.response.isError) {
      resumeSnapshot = resumeSnapshot ?? ((resumedStatusCall.response.structuredContent ?? resumedStatusCall.response) as PlanLifecycleSnapshot);
    }

    const reactiveCall = await reactiveCallPromise;
    if (reactiveCall && !reactiveCall.response.isError) {
      reactiveResult = (reactiveCall.response.structuredContent ?? reactiveCall.response) as PlanRunReactiveExecutionSnapshot;
    }

    const finalStatusCall = await callAndRecord(
      session,
      'plan_status',
      { run_id: reactiveRunId },
      { scenario: 'plan_status_completed' },
      calls,
    );
    if (finalStatusCall && !finalStatusCall.response.isError) {
      finalSnapshot = (finalStatusCall.response.structuredContent ?? finalStatusCall.response) as PlanLifecycleSnapshot;
    }
  } finally {
    await session.close().catch(() => {});
  }

  const graphNodeCount = mutatedGraph?.nodes?.length ?? 0;
  const graphEdgeCount = mutatedGraph?.edges?.length ?? 0;
  const graphMetadataKeys = mutatedGraph?.metadata ? Object.keys(mutatedGraph.metadata).length : 0;

  const compiledSummary = compiledTree
    ? {
        treeId: compiledTree.id,
        rootType: compiledTree.root.type,
        taskCount: countBehaviorTreeTasks(compiledTree.root),
      }
    : { treeId: null, rootType: null, taskCount: 0 };

  const successfulResponses = fanoutResponses.filter((entry) => entry.status === 'fulfilled').length;
  const failedResponses = fanoutResponses.filter((entry) => entry.status === 'error').length;
  const fanoutSummary = {
    runId: fanoutPlan?.run_id ?? null,
    opId: fanoutPlan?.op_id ?? null,
    childCount: fanoutPlan?.child_ids.length ?? 0,
    responsesCaptured: successfulResponses,
    rejectedCount: fanoutPlan?.rejected_plans?.length ?? 0,
    failedCount: failedResponses,
    degradedChildren: [...degradedChildren],
  };

  const joinSummary = joinResults.map((join) => ({
    opId: join.op_id ?? null,
    policy: join.policy,
    satisfied: join.satisfied,
    successCount: join.success_count,
    failureCount: join.failure_count,
    winningChild: join.winning_child_id ?? null,
  }));

  const reductionSummary = reduceResults.map((reduce) => ({
    opId: reduce.op_id ?? null,
    reducer: reduce.reducer,
    aggregateKind: describeAggregateKind(reduce.aggregate),
    childCount: Array.isArray(reduce.trace?.per_child) ? reduce.trace.per_child.length : 0,
  }));

  const report: PlanningStageReport = {
    runId: options.context.runId,
    completedAt: new Date().toISOString(),
    metrics: {
      totalCalls: calls.length,
      errorCount: calls.filter((entry) => entry.response.isError).length,
    },
    calls,
    graph: {
      graphId: mutatedGraph?.graph_id ?? null,
      version: mutatedGraph?.graph_version ?? null,
      nodeCount: graphNodeCount,
      edgeCount: graphEdgeCount,
      mutationCount,
      metadataKeys: graphMetadataKeys,
    },
    values: {
      configuredValues: valueSummary?.summary.values ?? 0,
      relationships: valueSummary?.summary.relationships ?? 0,
      defaultThreshold: valueSummary?.summary.default_threshold ?? null,
      explanationDecision: explanation ? (explanation.decision.allowed ? 'accepted' : 'rejected') : null,
      explanationAllowed: explanation?.decision.allowed ?? null,
      explanationViolations: explanation ? explanation.violations.length : null,
      scoreValue: valueScore?.decision.score ?? null,
      scoreTotal: valueScore?.decision.total ?? null,
      scoreAllowed: valueScore?.decision.allowed ?? null,
      scoreThreshold: valueScore?.decision.threshold ?? null,
      filterAllowed: valueFilter?.allowed ?? null,
      filterThreshold: valueFilter?.threshold ?? null,
      filterScore: valueFilter?.score ?? null,
      filterViolations: valueFilter ? valueFilter.violations.length : null,
    },
    plan: {
      bt: {
        runId: btResult?.run_id ?? null,
        status: btResult?.status ?? null,
        ticks: btResult?.ticks ?? null,
        idempotent: btResult ? btResult.idempotent : null,
      },
      reactive: {
        runId: reactiveResult?.run_id ?? pauseSnapshot?.run_id ?? resumeSnapshot?.run_id ?? finalSnapshot?.run_id ?? null,
        status: reactiveResult?.status ?? finalSnapshot?.state ?? null,
        loopTicks: reactiveResult?.loop_ticks ?? null,
        schedulerTicks: reactiveResult?.scheduler_ticks ?? null,
        pauseState: pauseSnapshot?.state ?? null,
        resumeState: resumeSnapshot?.state ?? null,
        finalState: finalSnapshot?.state ?? null,
      },
      compiled: compiledSummary,
      fanout: fanoutSummary,
      joins: joinSummary,
      reductions: reductionSummary,
    },
    knowledge: {
      inserted: knowledgeInsert?.inserted.length ?? 0,
      updated: knowledgeInsert?.updated ?? 0,
      totalAfterInsert: knowledgeInsert?.total ?? null,
      queried: knowledgeQuery?.triples.length ?? 0,
      exported: knowledgeExport?.triples.length ?? 0,
    },
  };

  const reportPath = path.join(options.context.directories.report, 'step05-plans-values.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    reportPath,
    calls,
    graph: {
      graphId: report.graph.graphId,
      version: report.graph.version,
      nodeCount: graphNodeCount,
      edgeCount: graphEdgeCount,
      mutationCount,
      metadataKeys: graphMetadataKeys,
      descriptor: mutatedGraph,
    },
    values: {
      configuredValues: report.values.configuredValues,
      relationships: report.values.relationships,
      defaultThreshold: report.values.defaultThreshold,
      explanation,
      score: valueScore,
      filter: valueFilter,
    },
    btPlan: btResult,
    reactivePlan: {
      run: reactiveResult,
      pauseSnapshot,
      resumeSnapshot,
      finalSnapshot,
    },
    knowledge: {
      inserted: knowledgeInsert,
      queried: knowledgeQuery,
      exported: knowledgeExport,
    },
    orchestration: {
      compiled: compiledTree,
      fanout: fanoutPlan,
      joins: joinResults,
      reductions: reduceResults,
      childResponses: fanoutResponses.map((entry) => ({ ...entry })),
    },
  };
}
