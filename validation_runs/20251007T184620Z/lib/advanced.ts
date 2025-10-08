import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';
import type { BaseToolCallSummary, ToolResponseSummary } from './baseTools.js';

import type { PlanRunBTResult } from '../../../src/tools/planTools.js';
import type { CausalExportResult, CausalExplainResult } from '../../../src/tools/causalTools.js';
import type {
  StigMarkResult,
  StigDecayResult,
  StigBatchResult,
  StigSnapshotResult,
  ConsensusVoteResult,
  CnpAnnounceResult,
  CnpRefreshBoundsResult,
  CnpWatcherTelemetryResult,
} from '../../../src/tools/coordTools.js';
import type { KgInsertResult, KgSuggestPlanResult } from '../../../src/tools/knowledgeTools.js';

/**
 * Structured entry returned by the `logs_tail` tool. Replicated here so the
 * validation harness can reason about filtered journal slices without reaching
 * into server internals.
 */
interface LogsTailEntry extends Record<string, unknown> {
  readonly seq: number;
  readonly ts: number;
  readonly stream: string;
  readonly bucket_id: string;
  readonly level: string;
  readonly message: string;
  readonly data: Record<string, unknown> | null;
  readonly job_id: string | null;
  readonly run_id: string | null;
  readonly op_id: string | null;
  readonly graph_id: string | null;
  readonly node_id: string | null;
  readonly child_id: string | null;
}

/** Snapshot returned by the `logs_tail` tool. */
interface LogsTailResult extends Record<string, unknown> {
  readonly stream: string;
  readonly bucket_id: string;
  readonly entries: LogsTailEntry[];
  readonly next_seq: number | null;
  readonly levels: string[] | null;
  readonly filters: Record<string, unknown> | null;
}

/**
 * JSON payload persisted by {@link runAdvancedFunctionsStage}. Stage 7 exercises
 * the causal, stigmergic, consensus, contract-net, assistance and logging
 * surfaces, therefore the summary captures representative metrics for each
 * subsystem and also preserves the detailed call summaries so Stage 8 can
 * compile the final audit without replaying the tooling.
 */
export interface AdvancedFunctionsStageReport {
  readonly runId: string;
  readonly completedAt: string;
  readonly metrics: {
    readonly totalCalls: number;
    readonly errorCount: number;
  };
  readonly calls: BaseToolCallSummary[];
  readonly plan: {
    readonly runId: string | null;
    readonly status: string | null;
    readonly ticks: number | null;
  };
  readonly knowledge: {
    readonly goal: string;
    readonly inserted: number;
    readonly updated: number;
    readonly total: number;
    readonly fragmentsSuggested: number;
    readonly rationaleCount: number;
  };
  readonly causal: {
    readonly exportedEvents: number;
    readonly explainedOutcomeId: string | null;
    readonly explanationDepth: number | null;
    readonly ancestorCount: number | null;
  };
  readonly stigmergy: {
    readonly nodeId: string | null;
    readonly markIntensity: number | null;
    readonly decayedPoints: number;
    readonly remainingIntensity: number | null;
    readonly batchApplied: number;
    readonly batchNodes: number;
    readonly snapshotPoints: number;
    readonly snapshotTotals: number;
    readonly heatmapCells: number;
    readonly snapshotGeneratedAt: number | null;
  };
  readonly consensus: {
    readonly outcome: string | null;
    readonly mode: string | null;
    readonly satisfied: boolean | null;
    readonly totalWeight: number | null;
    readonly votes: number | null;
  };
  readonly contractNet: {
    readonly callId: string | null;
    readonly awardedAgent: string | null;
    readonly bidCount: number;
    readonly autoBidEnabled: boolean | null;
    readonly idempotentReplay: boolean | null;
    readonly boundsRefreshed: boolean | null;
    readonly refreshedAgents: number | null;
    readonly telemetryEnabled: boolean | null;
    readonly telemetryEmissions: number | null;
  };
  readonly logs: {
    readonly stream: string | null;
    readonly bucketId: string | null;
    readonly entries: number;
    readonly nextSeq: number | null;
  };
}

/** Options accepted by {@link runAdvancedFunctionsStage}. */
export interface AdvancedFunctionsStageOptions {
  readonly context: RunContext;
  readonly recorder: ArtifactRecorder;
  readonly createSession?: () => McpSession;
}

/** Result returned by {@link runAdvancedFunctionsStage}. */
export interface AdvancedFunctionsStageResult {
  readonly reportPath: string;
  readonly calls: BaseToolCallSummary[];
  readonly plan: AdvancedFunctionsStageReport['plan'];
  readonly knowledge: AdvancedFunctionsStageReport['knowledge'];
  readonly causal: AdvancedFunctionsStageReport['causal'];
  readonly stigmergy: AdvancedFunctionsStageReport['stigmergy'];
  readonly consensus: AdvancedFunctionsStageReport['consensus'];
  readonly contractNet: AdvancedFunctionsStageReport['contractNet'];
  readonly logs: AdvancedFunctionsStageReport['logs'];
}

/** Extracts the first textual entry from an MCP response and attempts to decode it as JSON. */
function parseTextContent(response: ToolCallRecord['response']): {
  parsed?: unknown;
  errorCode?: string | null;
  hint?: string | null;
} {
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

/** Records a tool invocation while pushing a summary of the response to the provided sink. */
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
 * Executes Stage 7 of the validation campaign. The harness exercises advanced
 * orchestration helpers (causal explanations, stigmergy, consensus, Contract-Net,
 * plan assistance and journal introspection) and persists a structured report
 * describing the captured outcomes.
 */
export async function runAdvancedFunctionsStage(
  options: AdvancedFunctionsStageOptions,
): Promise<AdvancedFunctionsStageResult> {
  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-advanced',
        clientVersion: '1.0.0',
        featureOverrides: {
          enableBT: true,
          enableReactiveScheduler: true,
          enablePlanLifecycle: true,
          enableCausalMemory: true,
          enableKnowledge: true,
          enableAssist: true,
          enableStigmergy: true,
          enableConsensus: true,
          enableCNP: true,
          enableBlackboard: true,
          enableEventsBus: true,
          enableAutoscaler: true,
          enableSupervisor: true,
          enableIdempotency: true,
        },
      });

  await session.open();

  const calls: BaseToolCallSummary[] = [];
  const goalId = 'stage7-plan';
  const planRunId = 'stage7-causal-plan';

  let planSummary: PlanRunBTResult | null = null;
  let knowledgeInsert: KgInsertResult | null = null;
  let assistSummary: KgSuggestPlanResult | null = null;
  let causalExport: CausalExportResult | null = null;
  let causalExplain: CausalExplainResult | null = null;
  let stigMarkSummary: StigMarkResult | null = null;
  let stigDecaySummary: StigDecayResult | null = null;
  let stigBatchSummary: StigBatchResult | null = null;
  let stigSnapshotSummary: StigSnapshotResult | null = null;
  let consensusSummary: ConsensusVoteResult | null = null;
  let contractNetSummary: CnpAnnounceResult | null = null;
  let cnpRefreshSummary: CnpRefreshBoundsResult | null = null;
  let cnpWatcherSummary: CnpWatcherTelemetryResult | null = null;
  let logsTailSummary: LogsTailResult | null = null;

  try {
    const knowledgeCall = await callAndRecord(
      session,
      'kg_insert',
      {
        triples: [
          { subject: goalId, predicate: 'includes', object: 'stage7-task-analyse', source: 'stage7', confidence: 0.94 },
          { subject: goalId, predicate: 'includes', object: 'stage7-task-integrate', source: 'stage7', confidence: 0.91 },
          { subject: goalId, predicate: 'includes', object: 'stage7-task-validate', source: 'stage7', confidence: 0.88 },
          { subject: 'task:stage7-task-analyse', predicate: 'label', object: 'Analyser le contexte', source: 'stage7' },
          { subject: 'task:stage7-task-integrate', predicate: 'label', object: 'Intégrer les fonctionnalités', source: 'stage7' },
          { subject: 'task:stage7-task-validate', predicate: 'label', object: 'Valider les résultats', source: 'stage7' },
          { subject: 'task:stage7-task-integrate', predicate: 'depends_on', object: 'stage7-task-analyse', source: 'stage7' },
          { subject: 'task:stage7-task-validate', predicate: 'depends_on', object: 'stage7-task-integrate', source: 'stage7' },
        ],
      },
      { scenario: 'kg_insert_stage7_seed' },
      calls,
    );
    if (knowledgeCall && !knowledgeCall.response.isError) {
      knowledgeInsert = (knowledgeCall.response.structuredContent ?? knowledgeCall.response) as KgInsertResult;
    }

    const planCall = await callAndRecord(
      session,
      'plan_run_bt',
      {
        tree: {
          id: 'stage7-bt-tree',
          root: {
            type: 'sequence',
            id: 'stage7-root',
            children: [
              { type: 'task', id: 'stage7-wait-a', node_id: 'stage7-node-a', tool: 'wait', input_key: 'wait_a' },
              { type: 'task', id: 'stage7-wait-b', node_id: 'stage7-node-b', tool: 'wait', input_key: 'wait_b' },
            ],
          },
        },
        variables: {
          wait_a: { duration_ms: 50 },
          wait_b: { duration_ms: 50 },
        },
        timeout_ms: 5_000,
        run_id: planRunId,
        op_id: 'stage7-plan-op',
        graph_id: null,
      },
      { scenario: 'plan_run_bt_causal_seed' },
      calls,
    );
    if (planCall && !planCall.response.isError) {
      planSummary = (planCall.response.structuredContent ?? planCall.response) as PlanRunBTResult;
    }

    const exportCall = await callAndRecord(
      session,
      'causal_export',
      {},
      { scenario: 'causal_export_full' },
      calls,
    );
    if (exportCall && !exportCall.response.isError) {
      causalExport = (exportCall.response.structuredContent ?? exportCall.response) as CausalExportResult;
    }

    const outcomeId = causalExport?.events.length ? causalExport.events[causalExport.events.length - 1]?.id ?? null : null;
    if (outcomeId) {
      const explainCall = await callAndRecord(
        session,
        'causal_explain',
        { outcome_id: outcomeId, max_depth: 6 },
        { scenario: 'causal_explain_outcome' },
        calls,
      );
      if (explainCall && !explainCall.response.isError) {
        causalExplain = (explainCall.response.structuredContent ?? explainCall.response) as CausalExplainResult;
      }
    }

    const stigMarkCall = await callAndRecord(
      session,
      'stig_mark',
      {
        op_id: 'stage7-stig-op',
        node_id: 'stage7-node-a',
        type: 'focus',
        intensity: 7.5,
      },
      { scenario: 'stig_mark_primary' },
      calls,
    );
    if (stigMarkCall && !stigMarkCall.response.isError) {
      stigMarkSummary = (stigMarkCall.response.structuredContent ?? stigMarkCall.response) as StigMarkResult;
    }

    const stigDecayCall = await callAndRecord(
      session,
      'stig_decay',
      {
        op_id: 'stage7-stig-decay',
        half_life_ms: 1_000,
      },
      { scenario: 'stig_decay_halflife' },
      calls,
    );
    if (stigDecayCall && !stigDecayCall.response.isError) {
      stigDecaySummary = (stigDecayCall.response.structuredContent ?? stigDecayCall.response) as StigDecayResult;
    }

    const stigBatchCall = await callAndRecord(
      session,
      'stig_batch',
      {
        op_id: 'stage7-stig-batch',
        entries: [
          { node_id: 'stage7-node-b', type: 'focus', intensity: 4.5 },
          { node_id: 'stage7-node-c', type: 'support', intensity: 3.2 },
        ],
      },
      { scenario: 'stig_batch_reseed' },
      calls,
    );
    if (stigBatchCall && !stigBatchCall.response.isError) {
      stigBatchSummary = (stigBatchCall.response.structuredContent ?? stigBatchCall.response) as StigBatchResult;
    }

    const stigSnapshotCall = await callAndRecord(
      session,
      'stig_snapshot',
      { op_id: 'stage7-stig-snapshot' },
      { scenario: 'stig_snapshot_overview' },
      calls,
    );
    if (stigSnapshotCall && !stigSnapshotCall.response.isError) {
      stigSnapshotSummary = (stigSnapshotCall.response.structuredContent ?? stigSnapshotCall.response) as StigSnapshotResult;
    }

    const consensusCall = await callAndRecord(
      session,
      'consensus_vote',
      {
        op_id: 'stage7-consensus-op',
        votes: [
          { voter: 'agent-alpha', value: 'approve' },
          { voter: 'agent-beta', value: 'approve' },
          { voter: 'agent-gamma', value: 'reject' },
        ],
        config: {
          mode: 'weighted',
          quorum: 4,
          weights: { 'agent-alpha': 2, 'agent-beta': 2, 'agent-gamma': 1 },
          prefer_value: 'approve',
          tie_breaker: 'prefer',
        },
      },
      { scenario: 'consensus_vote_weighted' },
      calls,
    );
    if (consensusCall && !consensusCall.response.isError) {
      consensusSummary = (consensusCall.response.structuredContent ?? consensusCall.response) as ConsensusVoteResult;
    }

    const contractNetCall = await callAndRecord(
      session,
      'cnp_announce',
      {
        op_id: 'stage7-cnp-op',
        task_id: 'stage7-contract',
        payload: { goal: goalId, priority: 'high' },
        tags: ['stage7', 'advanced'],
        metadata: { stage: 7, scenario: 'advanced' },
        auto_bid: false,
        manual_bids: [
          { agent_id: 'agent-alpha', cost: 5, metadata: { notes: 'baseline' } },
          { agent_id: 'agent-beta', cost: 3, metadata: { notes: 'fastest' } },
          { agent_id: 'agent-gamma', cost: 7, metadata: { notes: 'backup' } },
        ],
      },
      { scenario: 'cnp_announce_manual_bids' },
      calls,
    );
    if (contractNetCall && !contractNetCall.response.isError) {
      contractNetSummary = (contractNetCall.response.structuredContent ?? contractNetCall.response) as CnpAnnounceResult;
    }

    cnpRefreshSummary = await (async () => {
      if (!contractNetSummary?.call_id) {
        return null;
      }
      const refreshCall = await callAndRecord(
        session,
        'cnp_refresh_bounds',
        {
          call_id: contractNetSummary.call_id,
          bounds: { min_intensity: 0.1, max_intensity: 6, normalisation_ceiling: 10 },
          include_new_agents: true,
          refresh_auto_bids: true,
        },
        { scenario: 'cnp_refresh_bounds_stage7' },
        calls,
      );
      if (refreshCall && !refreshCall.response.isError) {
        return (refreshCall.response.structuredContent ?? refreshCall.response) as CnpRefreshBoundsResult;
      }
      return null;
    })();

    const cnpWatcherCall = await callAndRecord(
      session,
      'cnp_watcher_telemetry',
      { op_id: 'stage7-cnp-telemetry' },
      { scenario: 'cnp_watcher_telemetry_snapshot' },
      calls,
    );
    if (cnpWatcherCall && !cnpWatcherCall.response.isError) {
      cnpWatcherSummary = (cnpWatcherCall.response.structuredContent ?? cnpWatcherCall.response) as CnpWatcherTelemetryResult;
    }

    const assistCall = await callAndRecord(
      session,
      'kg_suggest_plan',
      {
        goal: goalId,
        context: { preferred_sources: ['stage7'], max_fragments: 3 },
      },
      { scenario: 'kg_suggest_plan_goal' },
      calls,
    );
    if (assistCall && !assistCall.response.isError) {
      assistSummary = (assistCall.response.structuredContent ?? assistCall.response) as KgSuggestPlanResult;
    }

    const logsCall = await callAndRecord(
      session,
      'logs_tail',
      {
        stream: 'orchestrator',
        limit: 20,
        levels: ['info'],
        filters: {
          run_ids: [planRunId],
        },
      },
      { scenario: 'logs_tail_recent' },
      calls,
    );
    if (logsCall && !logsCall.response.isError) {
      logsTailSummary = (logsCall.response.structuredContent ?? logsCall.response) as LogsTailResult;
    }
  } finally {
    await session.close().catch(() => {});
  }

  const knowledgeSummary: AdvancedFunctionsStageReport['knowledge'] = {
    goal: goalId,
    inserted: knowledgeInsert?.inserted.length ?? 0,
    updated: knowledgeInsert?.updated ?? 0,
    total: knowledgeInsert?.total ?? 0,
    fragmentsSuggested: assistSummary?.fragments.length ?? 0,
    rationaleCount: assistSummary?.rationale.length ?? 0,
  };

  const planReport: AdvancedFunctionsStageReport['plan'] = {
    runId: planSummary?.run_id ?? null,
    status: planSummary?.status ?? null,
    ticks: planSummary?.ticks ?? null,
  };

  const causalReport: AdvancedFunctionsStageReport['causal'] = {
    exportedEvents: causalExport?.events.length ?? 0,
    explainedOutcomeId: causalExplain?.outcome.id ?? null,
    explanationDepth: causalExplain?.depth ?? null,
    ancestorCount: causalExplain?.ancestors.length ?? null,
  };

  const stigmergyReport: AdvancedFunctionsStageReport['stigmergy'] = {
    nodeId: stigMarkSummary?.point.node_id ?? null,
    markIntensity: stigMarkSummary?.point.intensity ?? null,
    decayedPoints: stigDecaySummary?.changes.length ?? 0,
    remainingIntensity:
      stigDecaySummary?.changes[0]?.node_total.intensity ?? stigMarkSummary?.node_total.intensity ?? null,
    batchApplied: stigBatchSummary?.changes.length ?? 0,
    batchNodes: stigBatchSummary
      ? new Set(stigBatchSummary.changes.map((change) => change.point.node_id)).size
      : 0,
    snapshotPoints: stigSnapshotSummary?.points.length ?? 0,
    snapshotTotals: stigSnapshotSummary?.totals.length ?? 0,
    heatmapCells: stigSnapshotSummary?.heatmap.cells.length ?? 0,
    snapshotGeneratedAt: stigSnapshotSummary?.generated_at ?? null,
  };

  const consensusReport: AdvancedFunctionsStageReport['consensus'] = {
    outcome: consensusSummary?.outcome ?? null,
    mode: consensusSummary?.mode ?? null,
    satisfied: typeof consensusSummary?.satisfied === 'boolean' ? consensusSummary.satisfied : null,
    totalWeight: typeof consensusSummary?.total_weight === 'number' ? consensusSummary.total_weight : null,
    votes: typeof consensusSummary?.votes === 'number' ? consensusSummary.votes : null,
  };

  const contractNetReport: AdvancedFunctionsStageReport['contractNet'] = {
    callId: contractNetSummary?.call_id ?? null,
    awardedAgent: contractNetSummary?.awarded_agent_id ?? null,
    bidCount: contractNetSummary?.bids.length ?? 0,
    autoBidEnabled:
      typeof contractNetSummary?.auto_bid_enabled === 'boolean' ? contractNetSummary.auto_bid_enabled : null,
    idempotentReplay:
      typeof contractNetSummary?.idempotent === 'boolean' ? contractNetSummary.idempotent : null,
    boundsRefreshed:
      typeof cnpRefreshSummary?.auto_bid_refreshed === 'boolean' ? cnpRefreshSummary.auto_bid_refreshed : null,
    refreshedAgents: cnpRefreshSummary ? cnpRefreshSummary.refreshed_agents.length : null,
    telemetryEnabled:
      typeof cnpWatcherSummary?.telemetry_enabled === 'boolean' ? cnpWatcherSummary.telemetry_enabled : null,
    telemetryEmissions:
      typeof cnpWatcherSummary?.emissions === 'number' ? cnpWatcherSummary.emissions : null,
  };

  const logsReport: AdvancedFunctionsStageReport['logs'] = {
    stream: logsTailSummary?.stream ?? null,
    bucketId: logsTailSummary?.bucket_id ?? null,
    entries: logsTailSummary?.entries.length ?? 0,
    nextSeq: logsTailSummary?.next_seq ?? null,
  };

  const report: AdvancedFunctionsStageReport = {
    runId: options.context.runId,
    completedAt: new Date().toISOString(),
    metrics: {
      totalCalls: calls.length,
      errorCount: calls.filter((entry) => entry.response.isError).length,
    },
    calls,
    plan: planReport,
    knowledge: knowledgeSummary,
    causal: causalReport,
    stigmergy: stigmergyReport,
    consensus: consensusReport,
    contractNet: contractNetReport,
    logs: logsReport,
  };

  const reportPath = path.join(options.context.directories.report, 'step07-advanced-functions.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    reportPath,
    calls,
    plan: planReport,
    knowledge: knowledgeSummary,
    causal: causalReport,
    stigmergy: stigmergyReport,
    consensus: consensusReport,
    contractNet: contractNetReport,
    logs: logsReport,
  };
}
