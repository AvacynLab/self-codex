import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';
import type { BaseToolCallSummary, ToolResponseSummary } from './baseTools.js';

import type { TxBeginResult, TxApplyResult, TxCommitResult } from '../../../src/tools/txTools.js';
import type { GraphPatchResult, GraphDiffResult } from '../../../src/tools/graphDiffTools.js';
import type { GraphDescriptorPayload } from '../../../src/tools/graphTools.js';
import type { GraphLockResult, GraphUnlockResult } from '../../../src/tools/graphLockTools.js';

/**
 * Descriptor of the aggregated signals captured while executing the transaction
 * validation stage. The structure is persisted to disk as JSON so downstream
 * reporting (Stages 7–8) can correlate metrics without re-processing raw
 * artefacts.
 */
export interface TransactionsStageReport {
  /** Identifier of the validation run. */
  readonly runId: string;
  /** ISO timestamp describing when the stage finished executing. */
  readonly completedAt: string;
  /** Graph identifier targeted by the transaction scenarios. */
  readonly graphId: string;
  /** Summaries for every tool invocation recorded during the stage. */
  readonly calls: BaseToolCallSummary[];
  /** High-level metrics extracted from the tool calls. */
  readonly metrics: {
    /** Total number of MCP calls issued while running the stage. */
    readonly totalCalls: number;
    /** Number of calls that yielded an MCP error response. */
    readonly errorCount: number;
    /** Version returned by the initial transaction commit. */
    readonly committedVersion: number;
    /** Version returned by the successful graph_patch invocation. */
    readonly patchedVersion: number | null;
  };
  /** Summary of the graph diff executed after the first commit. */
  readonly diff: {
    readonly traceId: string;
    readonly changed: boolean;
    readonly operations: number;
  } | null;
  /** Snapshot of the patch workflow (success + expected failure). */
  readonly patch: {
    readonly successTraceId: string;
    readonly failureTraceId: string | null;
    readonly failureCode: string | null;
  };
  /** Summary of the cooperative locking scenario. */
  readonly locks: {
    readonly acquiredTraceId: string;
    readonly lockId: string;
    readonly conflictTraceId: string | null;
    readonly conflictCode: string | null;
    readonly releasedTraceId: string | null;
  };
  /** Summary of the idempotency replay check. */
  readonly idempotency: {
    readonly key: string;
    readonly initialTraceId: string;
    readonly replayTraceId: string;
    readonly identicalPayload: boolean;
    readonly initialFlag: boolean;
    readonly replayFlag: boolean;
    readonly txId: string;
  };
  /** Absolute path where the final committed graph descriptor was stored. */
  readonly finalGraphPath: string | null;
}

/** Options accepted by {@link runTransactionsStage}. */
export interface TransactionsStageOptions {
  /** Shared validation run context. */
  readonly context: RunContext;
  /** Recorder in charge of persisting artefacts (inputs/outputs/events/logs). */
  readonly recorder: ArtifactRecorder;
  /** Optional factory injected by tests to override the MCP session. */
  readonly createSession?: () => McpSession;
}

/** Result returned by {@link runTransactionsStage}. */
export interface TransactionsStageResult {
  /** Path of the JSON report generated for the stage. */
  readonly reportPath: string;
  /** Absolute path of the latest committed graph descriptor. */
  readonly finalGraphPath: string | null;
  /** Collected summaries for each MCP call performed by the stage. */
  readonly calls: BaseToolCallSummary[];
  /** Identifier of the graph exercised by the scenarios. */
  readonly graphId: string;
  /** Version returned by the successful patch invocation (if any). */
  readonly patchedVersion: number | null;
}

/**
 * Extracts the first textual entry from an MCP response and attempts to parse
 * it as JSON. The helper mirrors the Stage 2 behaviour so error payloads remain
 * comparable across reports.
 */
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

/** Extract a stable error code from the summary, falling back to structured payloads. */
function resolveErrorCode(summary: ToolResponseSummary): string | null {
  if (summary.errorCode) {
    return summary.errorCode;
  }
  const structured = summary.structured;
  if (structured && typeof structured === 'object' && structured !== null) {
    const candidate = (structured as { error?: unknown }).error;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  const parsed = summary.parsedText;
  if (parsed && typeof parsed === 'object' && parsed !== null) {
    const candidate = (parsed as { error?: unknown }).error;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return null;
}

/**
 * Calls an MCP tool while capturing the {@link BaseToolCallSummary}. Transport
 * errors are converted into synthetic entries to keep traceability intact.
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
 * Executes the third checklist stage that focuses on transaction flows,
 * cooperative locks, diff/patch invariants and idempotency guarantees. The
 * function orchestrates the required MCP tool calls, persists their artefacts
 * and aggregates a compact report consumed by later phases of the audit.
 */
export async function runTransactionsStage(options: TransactionsStageOptions): Promise<TransactionsStageResult> {
  const graphId = 'G_TEST';
  const baseGraph: GraphDescriptorPayload = {
    name: 'Stage 3 validation graph',
    graph_id: graphId,
    graph_version: 1,
    metadata: {
      stage: 'transactions',
      enforce_dag: true,
      release_channel: 'alpha',
    },
    nodes: [
      { id: 'ingest', label: 'Ingest', attributes: { max_out_degree: 3 } },
      { id: 'analyse', label: 'Analyse' },
    ],
    edges: [{ from: 'ingest', to: 'analyse', label: 'next', attributes: { lane: 'primary' } }],
  };

  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-transactions',
        clientVersion: '1.0.0',
        featureOverrides: {
          enableTx: true,
          enableDiffPatch: true,
          enableLocks: true,
          enableResources: true,
          enableIdempotency: true,
        },
      });

  await session.open();

  const calls: BaseToolCallSummary[] = [];

  try {
    const beginCall = await callAndRecord(
      session,
      'tx_begin',
      {
        graph_id: graphId,
        owner: 'stage3-harness',
        note: 'seed baseline descriptor',
        ttl_ms: 5_000,
        graph: baseGraph,
      },
      { scenario: 'tx_begin_initial' },
      calls,
    );
    if (!beginCall) {
      throw new Error('tx_begin did not return a response');
    }
    const beginResult = (beginCall.response.structuredContent ?? beginCall.response) as TxBeginResult;

    const applyCall = await callAndRecord(
      session,
      'tx_apply',
      {
        tx_id: beginResult.tx_id,
        operations: [
          { op: 'add_node', node: { id: 'ship', label: 'Ship', attributes: { lane: 'delivery' } } },
          { op: 'add_edge', edge: { from: 'analyse', to: 'ship', label: 'handoff' } },
          { op: 'set_node_attribute', id: 'analyse', key: 'phase', value: 'inspection' },
        ],
      },
      { scenario: 'tx_apply_enrichment' },
      calls,
    );
    if (!applyCall) {
      throw new Error('tx_apply failed before receiving a response');
    }
    const applyResult = (applyCall.response.structuredContent ?? applyCall.response) as TxApplyResult;

    const commitCall = await callAndRecord(
      session,
      'tx_commit',
      { tx_id: beginResult.tx_id },
      { scenario: 'tx_commit_initial' },
      calls,
    );
    if (!commitCall) {
      throw new Error('tx_commit failed before receiving a response');
    }
    const commitResult = (commitCall.response.structuredContent ?? commitCall.response) as TxCommitResult;

    const diffCall = await callAndRecord(
      session,
      'graph_diff',
      {
        graph_id: graphId,
        from: { graph: baseGraph },
        to: { latest: true },
      },
      { scenario: 'graph_diff_post_commit' },
      calls,
    );
    const diffResult = diffCall
      ? ((diffCall.response.structuredContent ?? diffCall.response) as GraphDiffResult)
      : null;

    const commitGraph = commitResult.graph as GraphDescriptorPayload;
    const enrichedNodes = commitGraph.nodes.map((node) =>
      node.id === 'ship'
        ? {
            ...node,
            attributes: { ...(node.attributes ?? {}), status: 'ready', lane: node.attributes?.lane ?? 'delivery' },
          }
        : { ...node },
    );
    if (!enrichedNodes.some((node) => node.id === 'deliver')) {
      enrichedNodes.push({ id: 'deliver', label: 'Deliver', attributes: { lane: 'customer' } });
    }
    const enrichedEdges = commitGraph.edges.map((edge) => ({ ...edge }));
    if (!enrichedEdges.some((edge) => edge.from === 'ship' && edge.to === 'deliver')) {
      enrichedEdges.push({ from: 'ship', to: 'deliver', label: 'finalise' });
    }
    const enrichedGraph: GraphDescriptorPayload = {
      ...commitGraph,
      graph_id: graphId,
      metadata: { ...(commitGraph.metadata ?? {}), release_channel: 'beta', release_candidate: true },
      nodes: enrichedNodes,
      edges: enrichedEdges,
    };

    const patchPlanCall = await callAndRecord(
      session,
      'graph_diff',
      {
        graph_id: graphId,
        from: { latest: true },
        to: { graph: enrichedGraph },
      },
      { scenario: 'graph_diff_patch_plan' },
      calls,
    );
    const patchPlan = patchPlanCall
      ? ((patchPlanCall.response.structuredContent ?? patchPlanCall.response) as GraphDiffResult)
      : null;
    const patchOperations = patchPlan?.operations ?? [];
    if (patchOperations.length === 0) {
      throw new Error('graph_diff did not produce patch operations');
    }

    const patchCall = await callAndRecord(
      session,
      'graph_patch',
      {
        graph_id: graphId,
        base_version: commitResult.version,
        owner: 'stage3-harness',
        note: 'extend workflow',
        patch: patchOperations,
      },
      { scenario: 'graph_patch_success' },
      calls,
    );
    const patchResult = patchCall
      ? ((patchCall.response.structuredContent ?? patchCall.response) as GraphPatchResult)
      : null;
    if (!patchResult) {
      throw new Error('graph_patch did not return a structured response');
    }

    const patchedGraph = patchResult.graph as GraphDescriptorPayload;

    const cycleGraph: GraphDescriptorPayload = {
      ...patchedGraph,
      graph_id: graphId,
      edges: patchedGraph.edges.concat({ from: 'deliver', to: 'ingest', label: 'cycle' }),
    };

    const invalidPlanCall = await callAndRecord(
      session,
      'graph_diff',
      {
        graph_id: graphId,
        from: { latest: true },
        to: { graph: cycleGraph },
      },
      { scenario: 'graph_diff_cycle_plan' },
      calls,
    );
    const invalidPlan = invalidPlanCall
      ? ((invalidPlanCall.response.structuredContent ?? invalidPlanCall.response) as GraphDiffResult)
      : null;
    const invalidOperations = invalidPlan?.operations ?? [{ op: 'add', path: '/edges/-', value: { from: 'deliver', to: 'ingest', label: 'cycle' } }];

    const invalidPatchCall = await callAndRecord(
      session,
      'graph_patch',
      {
        graph_id: graphId,
        base_version: patchResult.committed_version ?? commitResult.version,
        owner: 'stage3-harness',
        note: 'induce cycle for invariant check',
        patch: invalidOperations,
      },
      { scenario: 'graph_patch_invariant_violation' },
      calls,
    );

    const lockCall = await callAndRecord(
      session,
      'graph_lock',
      {
        graph_id: graphId,
        holder: 'stage3-harness',
        ttl_ms: 5_000,
      },
      { scenario: 'graph_lock_acquire' },
      calls,
    );
    const lockResult = lockCall
      ? ((lockCall.response.structuredContent ?? lockCall.response) as GraphLockResult)
      : null;

    const conflictLockCall = await callAndRecord(
      session,
      'graph_lock',
      {
        graph_id: graphId,
        holder: 'stage3-intruder',
      },
      { scenario: 'graph_lock_conflict' },
      calls,
    );

    const unlockCall = lockResult
      ? await callAndRecord(
          session,
          'graph_unlock',
          { lock_id: lockResult.lock_id },
          { scenario: 'graph_unlock_release' },
          calls,
        )
      : null;
    const unlockResult = unlockCall
      ? ((unlockCall.response.structuredContent ?? unlockCall.response) as GraphUnlockResult)
      : null;

    const idempotencyKey = 'stage3-idempotent-begin';
    const idempotentBeginCall = await callAndRecord(
      session,
      'tx_begin',
      {
        graph_id: graphId,
        owner: 'stage3-idempotency',
        note: 'idempotency check',
        idempotency_key: idempotencyKey,
      },
      { scenario: 'tx_begin_idempotency_initial' },
      calls,
    );
    if (!idempotentBeginCall) {
      throw new Error('tx_begin idempotency probe failed on initial call');
    }
    const idempotentBeginResult = (idempotentBeginCall.response.structuredContent ?? idempotentBeginCall.response) as TxBeginResult;

    const idempotentReplayCall = await callAndRecord(
      session,
      'tx_begin',
      {
        graph_id: graphId,
        owner: 'stage3-idempotency',
        note: 'idempotency check',
        idempotency_key: idempotencyKey,
      },
      { scenario: 'tx_begin_idempotency_replay' },
      calls,
    );
    if (!idempotentReplayCall) {
      throw new Error('tx_begin idempotency replay did not yield a response');
    }
    const idempotentReplayResult = (idempotentReplayCall.response.structuredContent ?? idempotentReplayCall.response) as TxBeginResult;

    await callAndRecord(
      session,
      'tx_rollback',
      { tx_id: idempotentBeginResult.tx_id },
      { scenario: 'tx_rollback_idempotency_cleanup' },
      calls,
    );

    if (idempotentBeginResult.tx_id !== idempotentReplayResult.tx_id) {
      throw new Error('idempotent tx_begin returned a different transaction identifier');
    }
    const { idempotent: initialFlag, ...initialComparable } = idempotentBeginResult;
    const { idempotent: replayFlag, ...replayComparable } = idempotentReplayResult;
    const identicalPayload = JSON.stringify(initialComparable) === JSON.stringify(replayComparable);

    const invalidPatchSummary = calls.find(
      (entry) => entry.toolName === 'graph_patch' && entry.scenario === 'graph_patch_invariant_violation',
    );
    const failureCode = invalidPatchSummary ? resolveErrorCode(invalidPatchSummary.response) : null;

    const report: TransactionsStageReport = {
      runId: options.context.runId,
      completedAt: new Date().toISOString(),
      graphId,
      calls,
      metrics: {
        totalCalls: calls.length,
        errorCount: calls.filter((entry) => entry.response.isError).length,
        committedVersion: commitResult.version,
        patchedVersion: patchResult?.committed_version ?? null,
      },
      diff: diffResult
        ? {
            traceId: diffCall!.traceId,
            changed: diffResult.changed,
            operations: diffResult.operations.length,
          }
        : null,
      patch: {
        successTraceId: patchCall?.traceId ?? 'unknown',
        failureTraceId: invalidPatchCall?.traceId ?? null,
        failureCode,
      },
      locks: {
        acquiredTraceId: lockCall?.traceId ?? 'unknown',
        lockId: lockResult?.lock_id ?? 'unknown',
        conflictTraceId: conflictLockCall?.traceId ?? null,
        conflictCode: conflictLockCall?.response.errorCode ?? null,
        releasedTraceId: unlockResult ? unlockCall?.traceId ?? null : null,
      },
      idempotency: {
        key: idempotencyKey,
        initialTraceId: idempotentBeginCall.traceId,
        replayTraceId: idempotentReplayCall.traceId,
        identicalPayload,
        initialFlag: initialFlag ?? false,
        replayFlag: replayFlag ?? false,
        txId: idempotentReplayResult.tx_id,
      },
      finalGraphPath: null,
    };

    const reportPath = path.join(options.context.directories.report, 'step03-transactions.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    let finalGraphPath: string | null = null;
    if (patchResult.graph) {
      finalGraphPath = path.join(options.context.directories.resources, 'stage03-transaction-graph.json');
      await writeFile(finalGraphPath, `${JSON.stringify(patchResult.graph, null, 2)}\n`, 'utf8');
      report.finalGraphPath = finalGraphPath;
    }

    // Rewrite the report with the resolved final graph path when available.
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    return {
      reportPath,
      finalGraphPath,
      calls,
      graphId,
      patchedVersion: patchResult?.committed_version ?? null,
    };
  } finally {
    await session.close();
  }
}
