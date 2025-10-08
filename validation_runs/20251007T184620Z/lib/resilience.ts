import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';
import type { BaseToolCallSummary, ToolResponseSummary } from './baseTools.js';

import type { PlanRunBTResult } from '../../../src/tools/planTools.js';
import type { PlanLifecycleSnapshot } from '../../../src/executor/planLifecycle.js';

/**
 * Summary describing how a long running operation reacted when an explicit
 * cancellation request was issued. The structure feeds the stage report so the
 * final audit can reason about resilience without replaying the raw artefacts.
 */
export interface LongOperationCancellationSummary {
  /** Operation identifier attached to the long running plan. */
  readonly opId: string;
  /** Optional plan run identifier correlated with the operation. */
  readonly runId: string | null;
  /** Outcome reported by the `op_cancel` tool (requested, already_cancelled…). */
  readonly cancelOutcome: string | null;
  /** Human readable reason attached to the cancellation, when present. */
  readonly cancelReason: string | null;
  /** Final status reported by the behaviour tree execution (success, failure…). */
  readonly planStatus: string | null;
  /** Error code extracted from the plan response when cancellation propagated. */
  readonly planErrorCode: string | null;
  /** Trace identifier of the cancellation request. */
  readonly cancelTraceId: string | null;
  /** Trace identifier of the plan execution. */
  readonly planTraceId: string | null;
  /** Wall-clock duration (milliseconds) spent waiting for the plan response. */
  readonly planDurationMs: number | null;
}

/**
 * Structured summary capturing the effect of a bulk plan cancellation request
 * issued via `plan_cancel`. Persisting the lifecycle state helps validate that
 * downstream operations observe the stop signal promptly.
 */
export interface PlanRunCancellationSummary {
  /** Identifier of the cancelled plan run. */
  readonly runId: string;
  /** Reason communicated to the cancellation registry, if any. */
  readonly reason: string | null;
  /** Lifecycle state observed immediately after issuing the cancellation. */
  readonly lifecycleState: string | null;
  /** Progress percentage surfaced by the lifecycle snapshot. */
  readonly lifecycleProgress: number | null;
  /** Trace identifier correlated with the `plan_cancel` request. */
  readonly cancelTraceId: string | null;
  /** Trace identifier of the cancelled plan run. */
  readonly planTraceId: string | null;
  /** Error code returned by the plan execution when cancellation propagated. */
  readonly planErrorCode: string | null;
  /** Status reported by a subsequent `plan_status` call. */
  readonly statusAfterCancel: string | null;
  /**
   * Operations affected by the cancellation request, mirroring the payload
   * returned by the MCP tool for auditability.
   */
  readonly operations: ReadonlyArray<{
    readonly opId: string;
    readonly outcome: string | null;
  }>;
}

/**
 * Summary of an error probe executed during the resilience stage. Error probes
 * intentionally trigger invalid scenarios (unknown identifiers, malformed
 * inputs…) to ensure the server returns actionable metadata.
 */
export interface ErrorProbeSummary {
  /** Name of the tool that was exercised. */
  readonly toolName: string;
  /** Scenario identifier assigned by the harness. */
  readonly scenario: string;
  /** Trace identifier used when executing the probe. */
  readonly traceId: string | null;
  /** Whether the MCP response flagged the call as an error. */
  readonly isError: boolean;
  /** Normalised error code extracted from the response payload, if any. */
  readonly errorCode: string | null;
  /** Optional remediation hint surfaced by the server. */
  readonly hint: string | null;
  /** Duration (in milliseconds) spent waiting for the response. */
  readonly durationMs: number | null;
}

/**
 * JSON payload persisted by {@link runResilienceStage}. The report captures the
 * cancellation outcomes, the behaviour of error probes and the per-call
 * summaries so Stage 8 can compile an aggregate picture without re-running the
 * tooling.
 */
export interface ResilienceStageReport {
  readonly runId: string;
  readonly completedAt: string;
  readonly metrics: {
    readonly totalCalls: number;
    readonly errorCount: number;
    readonly cancellationsIssued: number;
  };
  readonly calls: BaseToolCallSummary[];
  readonly longOperation: LongOperationCancellationSummary | null;
  readonly planCancellation: PlanRunCancellationSummary | null;
  readonly errorProbes: {
    readonly invalidOpCancel: ErrorProbeSummary | null;
    readonly invalidPlanCancel: ErrorProbeSummary | null;
    readonly timeout: ErrorProbeSummary | null;
    readonly invalidParameters: ErrorProbeSummary | null;
    readonly missingDependency: ErrorProbeSummary | null;
  };
}

/** Options accepted by {@link runResilienceStage}. */
export interface ResilienceStageOptions {
  /** Shared validation run context (directories + trace factory). */
  readonly context: RunContext;
  /** Recorder used to persist deterministic tool artefacts. */
  readonly recorder: ArtifactRecorder;
  /** Optional factory injected by tests to control the MCP session lifecycle. */
  readonly createSession?: () => McpSession;
}

/** Result returned by {@link runResilienceStage}. */
export interface ResilienceStageResult {
  /** Absolute path of the generated JSON report. */
  readonly reportPath: string;
  /** Collection of tool call summaries captured during the stage. */
  readonly calls: BaseToolCallSummary[];
  /** Structured summary of the long running plan cancellation. */
  readonly longOperation: LongOperationCancellationSummary | null;
  /** Structured summary of the bulk plan cancellation scenario. */
  readonly planCancellation: PlanRunCancellationSummary | null;
  /** Error probes executed to validate resilience in the face of failures. */
  readonly errorProbes: ResilienceStageReport['errorProbes'];
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

/** Helper converting a captured call summary into an {@link ErrorProbeSummary}. */
function toProbeSummary(call: BaseToolCallSummary | undefined): ErrorProbeSummary | null {
  if (!call) {
    return null;
  }
  return {
    toolName: call.toolName,
    scenario: call.scenario ?? 'default',
    traceId: call.traceId,
    isError: call.response.isError,
    errorCode: call.response.errorCode ?? null,
    hint: call.response.hint ?? null,
    durationMs: Number.isFinite(call.durationMs) ? call.durationMs : null,
  };
}

/** Retrieves a call summary matching the provided tool and scenario identifiers. */
function findCall(
  calls: readonly BaseToolCallSummary[],
  toolName: string,
  scenario: string,
): BaseToolCallSummary | undefined {
  return calls.find((entry) => entry.toolName === toolName && entry.scenario === scenario);
}

/**
 * Executes Stage 6 of the validation campaign. The harness stresses resilience
 * by triggering cooperative cancellations (`op_cancel`, `plan_cancel`) and by
 * probing error scenarios (unknown identifiers, invalid payloads, feature
 * toggles). The captured artefacts support downstream reliability analysis.
 */
export async function runResilienceStage(options: ResilienceStageOptions): Promise<ResilienceStageResult> {
  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-resilience',
        clientVersion: '1.0.0',
        featureOverrides: {
          enableBT: true,
          enableReactiveScheduler: true,
          enablePlanLifecycle: true,
          enableCancellation: true,
          enableStigmergy: true,
          enableAutoscaler: true,
          enableSupervisor: true,
          enableIdempotency: true,
        },
      });

  await session.open();

  const calls: BaseToolCallSummary[] = [];
  let longOperationSummary: LongOperationCancellationSummary | null = null;
  let planCancellationSummary: PlanRunCancellationSummary | null = null;

  try {
    const longRunId = 'stage6-long-run';
    const longOpId = 'stage6-long-op';
    const longPlanPromise = callAndRecord(
      session,
      'plan_run_bt',
      {
        tree: {
          id: 'stage6-long-tree',
          root: {
            type: 'cancellable',
            id: 'stage6-long-wrapper',
            child: {
              type: 'task',
              id: 'stage6-long-wait',
              node_id: 'stage6-long-node',
              tool: 'wait',
              input_key: 'long_wait',
            },
          },
        },
        variables: {
          long_wait: { duration_ms: 5_000 },
        },
        timeout_ms: 20_000,
        run_id: longRunId,
        op_id: longOpId,
        graph_id: null,
      },
      { scenario: 'plan_run_bt_long_operation' },
      calls,
    );

    await delay(150);

    const longCancelCall = await callAndRecord(
      session,
      'op_cancel',
      { op_id: longOpId, reason: 'stage6-long-cancellation' },
      { scenario: 'op_cancel_long_operation' },
      calls,
    );

    const longPlanCall = await longPlanPromise;
    const longPlanSummary = longPlanCall
      ? (longPlanCall.response.structuredContent ?? longPlanCall.response)
      : null;
    const longPlanResult =
      longPlanCall && !longPlanCall.response.isError
        ? (longPlanSummary as PlanRunBTResult)
        : null;
    const cancelResult = longCancelCall
      ? ((longCancelCall.response.structuredContent ?? longCancelCall.response) as {
          readonly op_id?: string;
          readonly run_id?: string | null;
          readonly outcome?: string | null;
          readonly reason?: string | null;
        })
      : null;

    const longPlanCallSummary = longPlanCall
      ? findCall(calls, 'plan_run_bt', 'plan_run_bt_long_operation')
      : undefined;

    longOperationSummary = {
      opId: longOpId,
      runId: longPlanResult?.run_id ?? cancelResult?.run_id ?? null,
      cancelOutcome: cancelResult?.outcome ?? null,
      cancelReason: cancelResult?.reason ?? null,
      planStatus:
        longPlanResult?.status ??
        (longPlanSummary && typeof longPlanSummary === 'object'
          ? ((longPlanSummary as { status?: unknown }).status as string | null | undefined) ?? null
          : null),
      planErrorCode: longPlanCallSummary?.response.errorCode ?? null,
      cancelTraceId: longCancelCall?.traceId ?? null,
      planTraceId: longPlanCall?.traceId ?? null,
      planDurationMs: longPlanCallSummary ? longPlanCallSummary.durationMs : null,
    };

    const reactiveRunId = 'stage6-reactive-run';
    const reactiveOpId = 'stage6-reactive-op';
    const reactiveCallPromise = callAndRecord(
      session,
      'plan_run_reactive',
      {
        tree: {
          id: 'stage6-reactive-tree',
          root: {
            type: 'sequence',
            id: 'stage6-reactive-root',
            children: [
              { type: 'task', id: 'stage6-reactive-wait-a', node_id: 'stage6-reactive-a', tool: 'wait', input_key: 'wait_a' },
              { type: 'task', id: 'stage6-reactive-wait-b', node_id: 'stage6-reactive-b', tool: 'wait', input_key: 'wait_b' },
            ],
          },
        },
        variables: {
          wait_a: { duration_ms: 3_000 },
          wait_b: { duration_ms: 3_000 },
        },
        tick_ms: 100,
        timeout_ms: 30_000,
        run_id: reactiveRunId,
        op_id: reactiveOpId,
        graph_id: null,
      },
      { scenario: 'plan_run_reactive_cancellable' },
      calls,
    );

    await delay(200);

    const planCancelCall = await callAndRecord(
      session,
      'plan_cancel',
      { run_id: reactiveRunId, reason: 'stage6-reactive-cancellation' },
      { scenario: 'plan_cancel_reactive' },
      calls,
    );

    const planStatusAfterCancelCall = await callAndRecord(
      session,
      'plan_status',
      { run_id: reactiveRunId },
      { scenario: 'plan_status_after_cancel' },
      calls,
    );

    const reactiveCall = await reactiveCallPromise;
    const planCancelResult = planCancelCall
      ? ((planCancelCall.response.structuredContent ?? planCancelCall.response) as {
          readonly run_id?: string;
          readonly reason?: string | null;
          readonly operations?: ReadonlyArray<{ op_id?: string; outcome?: string | null }>;
          readonly lifecycle?: { state?: string | null; progress?: number | null } | null;
        })
      : null;

    const planStatusSnapshot = planStatusAfterCancelCall
      ? ((planStatusAfterCancelCall.response.structuredContent ?? planStatusAfterCancelCall.response) as PlanLifecycleSnapshot)
      : null;

    const reactiveCallSummary = findCall(calls, 'plan_run_reactive', 'plan_run_reactive_cancellable');

    planCancellationSummary = {
      runId: planCancelResult?.run_id ?? reactiveCallSummary?.response.structured?.run_id ?? reactiveRunId,
      reason: planCancelResult?.reason ?? null,
      lifecycleState: planCancelResult?.lifecycle && typeof planCancelResult.lifecycle === 'object'
        ? ((planCancelResult.lifecycle as { state?: unknown }).state as string | null | undefined) ?? null
        : null,
      lifecycleProgress: planCancelResult?.lifecycle && typeof planCancelResult.lifecycle === 'object'
        ? ((planCancelResult.lifecycle as { progress?: unknown }).progress as number | null | undefined) ?? null
        : null,
      cancelTraceId: planCancelCall?.traceId ?? null,
      planTraceId: reactiveCall?.traceId ?? null,
      planErrorCode: reactiveCallSummary?.response.errorCode ?? null,
      statusAfterCancel: planStatusSnapshot?.state ?? null,
      operations:
        planCancelResult?.operations?.map((operation) => ({
          opId: typeof operation?.op_id === 'string' ? operation.op_id : 'unknown',
          outcome: typeof operation?.outcome === 'string' ? operation.outcome : null,
        })) ?? [],
    };

    // Error probes exercising invalid inputs and missing dependencies.
    await callAndRecord(
      session,
      'op_cancel',
      { op_id: 'stage6-missing-op', reason: 'stage6-invalid' },
      { scenario: 'op_cancel_unknown' },
      calls,
    );

    await callAndRecord(
      session,
      'plan_cancel',
      { run_id: '', reason: 'stage6-invalid' },
      { scenario: 'plan_cancel_invalid_input' },
      calls,
    );

    await callAndRecord(
      session,
      'plan_run_bt',
      {
        tree: {
          id: 'stage6-timeout-tree',
          root: {
            type: 'task',
            id: 'stage6-timeout-task',
            node_id: 'stage6-timeout-node',
            tool: 'wait',
            input_key: 'timeout_wait',
          },
        },
        variables: {
          timeout_wait: { duration_ms: 1_000 },
        },
        timeout_ms: 50,
        run_id: 'stage6-timeout-run',
        op_id: 'stage6-timeout-op',
        graph_id: null,
      },
      { scenario: 'plan_run_bt_timeout' },
      calls,
    );

    await callAndRecord(
      session,
      'plan_run_bt',
      {
        tree: {
          id: 'stage6-invalid-params-tree',
          root: {
            type: 'task',
            id: 'stage6-invalid-params-task',
            node_id: 'stage6-invalid-params-node',
            tool: 'wait',
            input_key: 'invalid_wait',
          },
        },
        variables: {
          // Intentionally supply an invalid negative duration to trigger Zod validation.
          invalid_wait: { duration_ms: -10 },
        },
        run_id: 'stage6-invalid-params-run',
        op_id: 'stage6-invalid-params-op',
        graph_id: null,
      },
      { scenario: 'plan_run_bt_invalid_parameters' },
      calls,
    );

    await callAndRecord(
      session,
      'plan_run_bt',
      {
        tree: {
          id: 'stage6-missing-dependency-tree',
          root: {
            type: 'task',
            id: 'stage6-missing-dependency-task',
            node_id: 'stage6-missing-dependency-node',
            tool: 'bb_set',
            input_key: 'bb_payload',
          },
        },
        variables: {
          bb_payload: { key: 'resilience', value: 'missing-blackboard', tags: ['stage6'] },
        },
        run_id: 'stage6-missing-dependency-run',
        op_id: 'stage6-missing-dependency-op',
        graph_id: null,
      },
      { scenario: 'plan_run_bt_missing_dependency' },
      calls,
    );
  } finally {
    await session.close().catch(() => {});
  }

  const report: ResilienceStageReport = {
    runId: options.context.runId,
    completedAt: new Date().toISOString(),
    metrics: {
      totalCalls: calls.length,
      errorCount: calls.filter((entry) => entry.response.isError).length,
      cancellationsIssued: ['op_cancel_long_operation', 'plan_cancel_reactive'].filter((scenario) =>
        calls.some((entry) => entry.scenario === scenario),
      ).length,
    },
    calls,
    longOperation: longOperationSummary,
    planCancellation: planCancellationSummary,
    errorProbes: {
      invalidOpCancel: toProbeSummary(findCall(calls, 'op_cancel', 'op_cancel_unknown')),
      invalidPlanCancel: toProbeSummary(findCall(calls, 'plan_cancel', 'plan_cancel_invalid_input')),
      timeout: toProbeSummary(findCall(calls, 'plan_run_bt', 'plan_run_bt_timeout')),
      invalidParameters: toProbeSummary(findCall(calls, 'plan_run_bt', 'plan_run_bt_invalid_parameters')),
      missingDependency: toProbeSummary(findCall(calls, 'plan_run_bt', 'plan_run_bt_missing_dependency')),
    },
  };

  const reportPath = path.join(options.context.directories.report, 'step06-resilience.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    reportPath,
    calls,
    longOperation: longOperationSummary,
    planCancellation: planCancellationSummary,
    errorProbes: report.errorProbes,
  };
}
