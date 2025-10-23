import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';
import type { BaseToolCallSummary, ToolResponseSummary } from './baseTools.js';
import {
  buildTransportFailureSummary,
  parseToolResponseText,
  summariseToolResponse,
} from './responseSummary.js';

import { childProcessSupervisor, server } from '../../../src/server.js';
import type {
  ChildAttachResult,
  ChildCancelResult,
  ChildCreateResult,
  ChildGcResult,
  ChildKillResult,
  ChildSendResult,
  ChildSetLimitsResult,
  ChildSetRoleResult,
  ChildSpawnCodexResult,
  ChildStatusResult,
} from '../../../src/tools/childTools.js';
import type { PlanRunBTResult } from '../../../src/tools/planTools.js';

/**
 * Structured summary of a single child instance exercised during the stage. The
 * object aggregates the spawn metadata, lifecycle snapshots and communication
 * artefacts that were captured through MCP tool invocations.
 */
export interface ChildInstanceSummary {
  /** Unique identifier assigned by the supervisor. */
  readonly childId: string;
  /** Operation identifier surfaced by `child_spawn_codex`. */
  readonly opId: string;
  /** Optional semantic role advertised by the runtime. */
  readonly role: string | null;
  /** Declarative limits enforced by the supervisor for the runtime. */
  readonly limits: Record<string, unknown> | null;
  /** Absolute path where the child manifest was written. */
  readonly manifestPath: string;
  /** Workspace directory allocated to the child runtime. */
  readonly workdir: string;
  /** Timestamp emitted by the ready handshake. */
  readonly readyAt: number | null;
  /** Snapshot of the runtime state obtained via `child_status`. */
  readonly status: {
    readonly lifecycle: string | null;
    readonly pid: number | null;
    readonly heartbeatAt: number | null;
  } | null;
  /** Metadata persisted through `child_attach`. */
  readonly manifestExtras: Record<string, unknown> | null;
  /** Summary of the last prompt/response exchange performed with the child. */
  readonly interaction: {
    readonly requestType: string | null;
    readonly responseType: string | null;
    readonly responseReceivedAt: number | null;
  } | null;
  /** Shutdown metrics collected via `child_cancel`. */
  readonly shutdown: {
    readonly signal: string | null;
    readonly durationMs: number | null;
    readonly forced: boolean | null;
  } | null;
  /** Trace identifiers associated with the tool invocations. */
  readonly traces: {
    readonly spawn: string;
    readonly status?: string;
    readonly attach?: string;
    readonly limits?: string;
    readonly role?: string;
    readonly prompt?: string;
    readonly promptPartial?: string;
    readonly promptFinal?: string;
    readonly chat?: string;
    readonly chatFinal?: string;
    readonly info?: string;
    readonly transcript?: string;
    readonly collect?: string;
    readonly stream?: string;
    readonly send?: string;
    readonly cancel?: string;
    readonly rename?: string;
    readonly reset?: string;
    readonly kill?: string;
    readonly gc?: string;
  };
}

/** Summary describing how the stage exercised cancellation through `op_cancel`. */
export interface PlanCancellationSummary {
  /** Operation identifier targeted by the cancellation request. */
  readonly opId: string;
  /** Optional plan run identifier returned by the server. */
  readonly runId: string | null;
  /** Outcome reported by the cancellation tool (`requested`, `already_cancelled`, …). */
  readonly outcome: string | null;
  /** Optional reason propagated by the cancellation registry. */
  readonly reason: string | null;
  /** Trace identifier of the `op_cancel` invocation. */
  readonly cancelTraceId: string | null;
  /** Trace identifier of the Behaviour Tree execution. */
  readonly planTraceId: string | null;
  /** Error code (when available) returned once the plan observed the cancellation. */
  readonly planErrorCode: string | null;
  /** Behaviour Tree status surfaced by the plan result or error payload. */
  readonly planStatus: string | null;
}

/**
 * JSON payload persisted once the stage completes. The document captures enough
 * metadata (including the per-tool call summaries) to drive the high-level
 * report compiled during Stage 8.
 */
export interface ChildStageReport {
  readonly runId: string;
  readonly completedAt: string;
  readonly metrics: {
    readonly totalCalls: number;
    readonly errorCount: number;
    readonly spawnedChildren: number;
  };
  readonly calls: BaseToolCallSummary[];
  readonly children: ChildInstanceSummary[];
  readonly cancellation: PlanCancellationSummary;
}

/** Options accepted by {@link runChildOrchestrationStage}. */
export interface ChildStageOptions {
  /** Shared validation run context. */
  readonly context: RunContext;
  /** Recorder used to persist tool inputs/outputs, events and logs. */
  readonly recorder: ArtifactRecorder;
  /** Optional factory injected by tests to override the MCP session. */
  readonly createSession?: () => McpSession;
  /**
   * Optional override allowing the harness to dictate which executable should
   * back the spawned children. Tests use this to rely on the deterministic
   * `mock-runner` fixture.
   */
  readonly childRunner?: { readonly command: string; readonly args?: readonly string[] };
}

/** Result returned by {@link runChildOrchestrationStage}. */
export interface ChildStageResult {
  /** Absolute path to the generated JSON report. */
  readonly reportPath: string;
  /** Collection of tool call summaries captured during the stage. */
  readonly calls: BaseToolCallSummary[];
  /** Summaries describing each child runtime exercised by the stage. */
  readonly children: ChildInstanceSummary[];
  /** Summary of the plan cancellation probe. */
  readonly cancellation: PlanCancellationSummary;
}

/** Extracts the first textual entry from an MCP response and attempts to decode it as JSON. */
/** Builds a structured summary of the MCP response suitable for audit reports. */
function summariseResponse(response: ToolCallRecord['response']): ToolResponseSummary {
  return summariseToolResponse(response);
}

/**
 * Invokes an MCP tool while recording deterministic artefacts. Transport-level
 * failures are mapped to synthetic summaries so that trace identifiers and
 * artefact paths remain available for troubleshooting.
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
      ...(options.scenario ? { scenario: options.scenario } : {}),
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
        ...(options.scenario ? { scenario: options.scenario } : {}),
        traceId: error.traceId,
        durationMs: error.durationMs,
        artefacts: error.artefacts,
        response: buildTransportFailureSummary(error),
      });
      return null;
    }
    throw error;
  }
}

/**
 * Extracts a stable error code from a {@link ToolResponseSummary}, inspecting
 * both the structured payload and textual content when needed.
 */
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
 * Extracts the `pending_id` exposed by conversation tools such as
 * `child_prompt` or `child_chat`. The helper inspects the structured payload
 * first before falling back to the parsed textual JSON so tests can assert the
 * continuation flow deterministically.
 */
function extractPendingId(call: ToolCallRecord | null): string | null {
  if (!call) {
    return null;
  }
  const structured = call.response.structuredContent as { pending_id?: unknown } | undefined;
  if (structured && typeof structured.pending_id === 'string') {
    return structured.pending_id;
  }
  const parsed = parseToolResponseText(call.response).parsed;
  if (parsed && typeof parsed === 'object' && parsed !== null) {
    const candidate = (parsed as { pending_id?: unknown }).pending_id;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return null;
}

/**
 * Applies a temporary override to the supervisor default command so the stage
 * can rely on deterministic child runtimes. Returns a disposer that restores
 * the previous configuration.
 */
function configureChildRunner(overrides?: { command: string; args?: readonly string[] }): () => void {
  if (!overrides) {
    return () => {};
  }
  const supervisorHandle = childProcessSupervisor as unknown as {
    defaultCommand: string;
    defaultArgs: string[];
  };
  const previous = {
    command: supervisorHandle.defaultCommand,
    args: supervisorHandle.defaultArgs.slice(),
  };
  supervisorHandle.defaultCommand = overrides.command;
  supervisorHandle.defaultArgs = Array.isArray(overrides.args) ? [...overrides.args] : [];
  return () => {
    supervisorHandle.defaultCommand = previous.command;
    supervisorHandle.defaultArgs = previous.args;
  };
}

/**
 * Executes Stage 4 of the validation campaign. The harness exercises the child
 * orchestration surface by spawning multiple runtimes, updating their manifests
 * and limits, exchanging messages, and validating cooperative cancellation via
 * `op_cancel`.
 */
export async function runChildOrchestrationStage(options: ChildStageOptions): Promise<ChildStageResult> {
  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-children',
        clientVersion: '1.0.0',
        featureOverrides: {
          enableChildOpsFine: true,
          enableCancellation: true,
          enableBT: true,
          enableReactiveScheduler: true,
          enablePlanLifecycle: true,
          enableStigmergy: true,
          enableBlackboard: true,
          enableAutoscaler: true,
          enableSupervisor: true,
          enableIdempotency: true,
        },
      });

  const restoreRunner = configureChildRunner(options.childRunner);

  await session.open();

  const calls: BaseToolCallSummary[] = [];
  const childSummaries: ChildInstanceSummary[] = [];
  let cancellationSummary: PlanCancellationSummary = {
    opId: 'unknown',
    runId: null,
    outcome: null,
    reason: null,
    cancelTraceId: null,
    planTraceId: null,
    planErrorCode: null,
    planStatus: null,
  };

  try {
    const primarySpawnCall = await callAndRecord(
      session,
      'child_spawn_codex',
      {
        role: 'planner',
        prompt: { system: 'Tu es un copilote structuré.', user: ['Prépare un plan initial.'] },
        limits: { tokens: 1_024, wallclock_ms: 30_000 },
        metadata: { stage: 'child-orchestration', cohort: 'primary' },
      },
      { scenario: 'primary_spawn' },
      calls,
    );
    if (!primarySpawnCall) {
      throw new Error('child_spawn_codex did not return a response for the primary child');
    }
    const primarySpawnStructured = primarySpawnCall.response.structuredContent as ChildSpawnCodexResult | undefined;
    const primarySpawn = primarySpawnStructured ?? (primarySpawnCall.response as ChildSpawnCodexResult);

    const primaryStatusCall = await callAndRecord(
      session,
      'child_status',
      { child_id: primarySpawn.child_id },
      { scenario: 'primary_status' },
      calls,
    );
    const primaryStatus = primaryStatusCall
      ? ((primaryStatusCall.response.structuredContent ?? primaryStatusCall.response) as ChildStatusResult)
      : null;

    const primaryAttachCall = await callAndRecord(
      session,
      'child_attach',
      { child_id: primarySpawn.child_id, manifest_extras: { refreshed_by: 'stage4', contact: 'primary' } },
      { scenario: 'primary_attach' },
      calls,
    );
    const primaryAttach = primaryAttachCall
      ? ((primaryAttachCall.response.structuredContent ?? primaryAttachCall.response) as ChildAttachResult)
      : null;

    const primaryLimitsCall = await callAndRecord(
      session,
      'child_set_limits',
      { child_id: primarySpawn.child_id, limits: { tokens: 768, wallclock_ms: 20_000 }, manifest_extras: { tightened: true } },
      { scenario: 'primary_limits' },
      calls,
    );
    const primaryLimits = primaryLimitsCall
      ? ((primaryLimitsCall.response.structuredContent ?? primaryLimitsCall.response) as ChildSetLimitsResult)
      : null;

    const primarySendCall = await callAndRecord(
      session,
      'child_send',
      {
        child_id: primarySpawn.child_id,
        payload: { type: 'prompt', content: 'Analyse les objectifs et propose un découpage.' },
        expect: 'final',
        timeout_ms: 2_000,
      },
      { scenario: 'primary_prompt' },
      calls,
    );
    const primarySend = primarySendCall && !primarySendCall.response.isError
      ? ((primarySendCall.response.structuredContent ?? primarySendCall.response) as ChildSendResult)
      : null;

    const secondarySpawnCall = await callAndRecord(
      session,
      'child_spawn_codex',
      {
        role: 'reviewer',
        prompt: { system: 'Tu vérifies le plan proposé.', user: ['Vérifie les dépendances critiques.'] },
        limits: { tokens: 512 },
        metadata: { stage: 'child-orchestration', cohort: 'secondary' },
      },
      { scenario: 'secondary_spawn' },
      calls,
    );
    if (!secondarySpawnCall) {
      throw new Error('child_spawn_codex did not return a response for the secondary child');
    }
    const secondarySpawnStructured = secondarySpawnCall.response.structuredContent as ChildSpawnCodexResult | undefined;
    const secondarySpawn = secondarySpawnStructured ?? (secondarySpawnCall.response as ChildSpawnCodexResult);

    const secondaryStatusCall = await callAndRecord(
      session,
      'child_status',
      { child_id: secondarySpawn.child_id },
      { scenario: 'secondary_status' },
      calls,
    );
    const secondaryStatus = secondaryStatusCall
      ? ((secondaryStatusCall.response.structuredContent ?? secondaryStatusCall.response) as ChildStatusResult)
      : null;

    const secondaryLimitsCall = await callAndRecord(
      session,
      'child_set_limits',
      { child_id: secondarySpawn.child_id, limits: { tokens: 384, wallclock_ms: 15_000 } },
      { scenario: 'secondary_limits' },
      calls,
    );
    const secondaryLimits = secondaryLimitsCall
      ? ((secondaryLimitsCall.response.structuredContent ?? secondaryLimitsCall.response) as ChildSetLimitsResult)
      : null;

    const secondarySendCall = await callAndRecord(
      session,
      'child_send',
      {
        child_id: secondarySpawn.child_id,
        payload: { type: 'ping' },
        expect: 'stream',
        timeout_ms: 2_000,
      },
      { scenario: 'secondary_ping' },
      calls,
    );
    const secondarySend = secondarySendCall && !secondarySendCall.response.isError
      ? ((secondarySendCall.response.structuredContent ?? secondarySendCall.response) as ChildSendResult)
      : null;

    // Exercise the advanced child-management surface so the audit captures role
    // changes, conversational pending flows, direct creations and batch spawns
    // in addition to the original ping/prompt smoke test.
    const secondaryRoleCall = await callAndRecord(
      session,
      'child_set_role',
      {
        child_id: secondarySpawn.child_id,
        role: 'auditeur',
        manifest_extras: { adjusted_by: 'stage4' },
      },
      { scenario: 'secondary_role' },
      calls,
    );
    const secondaryRole = secondaryRoleCall
      ? ((secondaryRoleCall.response.structuredContent ?? secondaryRoleCall.response) as ChildSetRoleResult)
      : null;

    const secondaryPromptCall = await callAndRecord(
      session,
      'child_prompt',
      {
        child_id: secondarySpawn.child_id,
        messages: [
          { role: 'system', content: 'Observe les updates Stage 4 pour fournir un résumé succinct.' },
          { role: 'user', content: 'Donne-moi une synthèse en une phrase.' },
        ],
      },
      { scenario: 'secondary_prompt' },
      calls,
    );
    const secondaryPromptPendingId = extractPendingId(secondaryPromptCall);
    const secondaryPromptPartialCall = secondaryPromptPendingId
      ? await callAndRecord(
          session,
          'child_push_partial',
          { pending_id: secondaryPromptPendingId, delta: 'Synthèse en cours…', done: false },
          { scenario: 'secondary_prompt_partial' },
          calls,
        )
      : null;
    const secondaryPromptFinalCall = secondaryPromptPendingId
      ? await callAndRecord(
          session,
          'child_push_reply',
          { pending_id: secondaryPromptPendingId, content: 'Synthèse finale : opérations Stage 4 validées.' },
          { scenario: 'secondary_prompt_final' },
          calls,
        )
      : null;

    const primaryChatCall = await callAndRecord(
      session,
      'child_chat',
      {
        child_id: primarySpawn.child_id,
        content: 'Confirme que le plan reste aligné après les tests additionnels.',
        role: 'user',
      },
      { scenario: 'primary_chat' },
      calls,
    );
    const primaryChatPendingId = extractPendingId(primaryChatCall);
    const primaryChatFinalCall = primaryChatPendingId
      ? await callAndRecord(
          session,
          'child_push_reply',
          { pending_id: primaryChatPendingId, content: 'Le plan reste aligné, prêt pour la suite.' },
          { scenario: 'primary_chat_final' },
          calls,
        )
      : null;

    const primaryInfoCall = await callAndRecord(
      session,
      'child_info',
      { child_id: primarySpawn.child_id },
      { scenario: 'primary_info' },
      calls,
    );

    const primaryTranscriptCall = await callAndRecord(
      session,
      'child_transcript',
      { child_id: primarySpawn.child_id, limit: 12 },
      { scenario: 'primary_transcript' },
      calls,
    );

    const primaryCollectCall = await callAndRecord(
      session,
      'child_collect',
      { child_id: primarySpawn.child_id },
      { scenario: 'primary_collect' },
      calls,
    );

    const primaryStreamCall = await callAndRecord(
      session,
      'child_stream',
      { child_id: primarySpawn.child_id, limit: 5, streams: ['stdout'] },
      { scenario: 'primary_stream' },
      calls,
    );

    const batchCreateCall = await callAndRecord(
      session,
      'child_batch_create',
      {
        entries: [
          {
            role: 'scribe',
            prompt: { system: 'Tu notes les incidents.', user: ['Consigne les résultats des tests Stage 4.'] },
            limits: { tokens: 256 },
            metadata: { cohort: 'batch', index: 0 },
          },
          {
            role: 'observer',
            prompt: { system: 'Tu vérifies les flux.', user: ['Analyse les streams enfants.'] },
            limits: { tokens: 256 },
            metadata: { cohort: 'batch', index: 1 },
          },
        ],
      },
      { scenario: 'batch_spawn' },
      calls,
    );
    const directCreateCall = await callAndRecord(
      session,
      'child_create',
      {
        prompt: {
          system: 'Tu es un scribe méticuleux pour la campagne MCP.',
          user: ['Compile les traces additionnelles exercées pendant Stage 4.'],
        },
        metadata: { stage: 'child-orchestration', origin: 'direct-create' },
        wait_for_ready: true,
      },
      { scenario: 'tertiary_create' },
      calls,
    );
    const directCreate = directCreateCall
      ? ((directCreateCall.response.structuredContent ?? directCreateCall.response) as ChildCreateResult)
      : null;

    const tertiaryRenameCall = directCreate
      ? await callAndRecord(
          session,
          'child_rename',
          { child_id: directCreate.child_id, name: 'stage4-tertiary' },
          { scenario: 'tertiary_rename' },
          calls,
        )
      : null;

    const tertiaryResetCall = directCreate
      ? await callAndRecord(
          session,
          'child_reset',
          { child_id: directCreate.child_id, keep_system: true },
          { scenario: 'tertiary_reset' },
          calls,
        )
      : null;

    const tertiaryKillCall = directCreate
      ? await callAndRecord(
          session,
          'child_kill',
          { child_id: directCreate.child_id, timeout_ms: 500 },
          { scenario: 'tertiary_force_stop' },
          calls,
        )
      : null;

    const tertiaryGcCall = directCreate
      ? await callAndRecord(
          session,
          'child_gc',
          { child_id: directCreate.child_id },
          { scenario: 'tertiary_cleanup' },
          calls,
        )
      : null;
    const tertiaryKill = tertiaryKillCall
      ? ((tertiaryKillCall.response.structuredContent ?? tertiaryKillCall.response) as ChildKillResult)
      : null;
    const tertiaryGc = tertiaryGcCall
      ? ((tertiaryGcCall.response.structuredContent ?? tertiaryGcCall.response) as ChildGcResult)
      : null;

    const planOpId = `${primarySpawn.child_id}-plan`;
    const planPayload = {
      tree: {
        id: 'child-stage-sequence',
        root: {
          type: 'sequence',
          id: 'root-seq',
          children: [
            {
              type: 'cancellable',
              id: 'wait-wrapper',
              child: { type: 'task', id: 'wait-task', node_id: 'wait-node', tool: 'wait', input_key: 'wait_params' },
            },
            {
              type: 'task',
              id: 'noop-task',
              node_id: 'final-node',
              tool: 'noop',
              input_key: 'noop_payload',
            },
          ],
        },
      },
      variables: {
        wait_params: { duration_ms: 5_000 },
        noop_payload: { result: 'completed' },
      },
      op_id: planOpId,
      job_id: `${primarySpawn.child_id}-job`,
      child_id: primarySpawn.child_id,
      timeout_ms: 10_000,
    } satisfies Record<string, unknown>;

    const planCallPromise = callAndRecord(
      session,
      'plan_run_bt',
      planPayload,
      { scenario: 'plan_run_bt_sequence' },
      calls,
    );

    await delay(100);

    const cancelCall = await callAndRecord(
      session,
      'op_cancel',
      { op_id: planOpId, reason: 'stage4-validation' },
      { scenario: 'plan_cancellation' },
      calls,
    );

    const planCall = await planCallPromise;

    const planResult = planCall && !planCall.response.isError
      ? (planCall.response.structuredContent as PlanRunBTResult)
      : null;
    const cancelResult = cancelCall
      ? ((cancelCall.response.structuredContent ?? cancelCall.response) as {
          readonly op_id: string;
          readonly run_id: string | null;
          readonly outcome: string | null;
          readonly reason: string | null;
        })
      : null;

    cancellationSummary = {
      opId: planOpId,
      runId: planResult?.run_id ?? cancelResult?.run_id ?? null,
      outcome: cancelResult?.outcome ?? null,
      reason: cancelResult?.reason ?? null,
      cancelTraceId: cancelCall?.traceId ?? null,
      planTraceId: planCall?.traceId ?? null,
      planErrorCode: planCall
        ? resolveErrorCode(
            calls.find((entry) => entry.traceId === planCall.traceId)?.response ?? summariseResponse(planCall.response),
          )
        : null,
      planStatus:
        planResult?.status ??
        (planCall?.response.structuredContent && typeof planCall.response.structuredContent === 'object'
          ? ((planCall.response.structuredContent as { status?: unknown }).status as string | null | undefined) ?? null
          : null),
    };

    const primaryCancelCall = await callAndRecord(
      session,
      'child_cancel',
      { child_id: primarySpawn.child_id, signal: 'SIGINT', timeout_ms: 1_000 },
      { scenario: 'primary_shutdown' },
      calls,
    );
    const primaryCancel = primaryCancelCall
      ? ((primaryCancelCall.response.structuredContent ?? primaryCancelCall.response) as ChildCancelResult)
      : null;

    const secondaryCancelCall = await callAndRecord(
      session,
      'child_cancel',
      { child_id: secondarySpawn.child_id, signal: 'SIGINT', timeout_ms: 1_000 },
      { scenario: 'secondary_shutdown' },
      calls,
    );
    const secondaryCancel = secondaryCancelCall
      ? ((secondaryCancelCall.response.structuredContent ?? secondaryCancelCall.response) as ChildCancelResult)
      : null;

    childSummaries.push({
      childId: primarySpawn.child_id,
      opId: primarySpawn.op_id,
      role: primarySpawn.role ?? null,
      limits:
        (primaryLimits?.limits as Record<string, unknown> | null | undefined) ??
        (primarySpawn.limits as Record<string, unknown> | null | undefined) ??
        null,
      manifestPath: primarySpawn.manifest_path,
      workdir: primarySpawn.workdir,
      readyAt: typeof primarySpawn.started_at === 'number' ? primarySpawn.started_at : null,
      status: primaryStatus
        ? {
            lifecycle:
              String(primaryStatus.runtime_status?.lifecycle ?? primaryStatus.index_snapshot?.state ?? '') || null,
            pid: typeof primaryStatus.runtime_status?.pid === 'number' ? primaryStatus.runtime_status.pid : null,
            heartbeatAt:
              typeof primaryStatus.runtime_status?.lastHeartbeatAt === 'number'
                ? primaryStatus.runtime_status.lastHeartbeatAt
                : typeof primaryStatus.index_snapshot?.lastHeartbeatAt === 'number'
                ? primaryStatus.index_snapshot.lastHeartbeatAt
                : null,
          }
        : null,
      manifestExtras: primaryAttach?.index_snapshot?.metadata ?? null,
      interaction: primarySend
        ? {
            requestType: (primarySend.message as { messageId?: string } | null)?.messageId ? 'prompt' : null,
            responseType:
              typeof primarySend.awaited_message?.parsed === 'object' && primarySend.awaited_message?.parsed
                ? ((primarySend.awaited_message.parsed as { type?: unknown }).type as string | null) ?? null
                : null,
            responseReceivedAt: primarySend.awaited_message?.receivedAt ?? null,
          }
        : null,
      shutdown: primaryCancel
        ? {
            signal: (primaryCancel.shutdown as { signal?: string | null } | null)?.signal ?? null,
            durationMs: (primaryCancel.shutdown as { durationMs?: number } | null)?.durationMs ?? null,
            forced: (primaryCancel.shutdown as { forced?: boolean } | null)?.forced ?? null,
          }
        : null,
      traces: {
        spawn: primarySpawnCall.traceId,
        status: primaryStatusCall?.traceId,
        attach: primaryAttachCall?.traceId,
        limits: primaryLimitsCall?.traceId,
        chat: primaryChatCall?.traceId,
        chatFinal: primaryChatFinalCall?.traceId,
        info: primaryInfoCall?.traceId,
        transcript: primaryTranscriptCall?.traceId,
        collect: primaryCollectCall?.traceId,
        stream: primaryStreamCall?.traceId,
        send: primarySendCall?.traceId,
        cancel: primaryCancelCall?.traceId,
      },
    });

    childSummaries.push({
      childId: secondarySpawn.child_id,
      opId: secondarySpawn.op_id,
      role: secondaryRole?.role ?? secondarySpawn.role ?? null,
      limits:
        (secondaryLimits?.limits as Record<string, unknown> | null | undefined) ??
        (secondarySpawn.limits as Record<string, unknown> | null | undefined) ??
        null,
      manifestPath: secondarySpawn.manifest_path,
      workdir: secondarySpawn.workdir,
      readyAt: typeof secondarySpawn.started_at === 'number' ? secondarySpawn.started_at : null,
      status: secondaryStatus
        ? {
            lifecycle:
              String(secondaryStatus.runtime_status?.lifecycle ?? secondaryStatus.index_snapshot?.state ?? '') || null,
            pid: typeof secondaryStatus.runtime_status?.pid === 'number' ? secondaryStatus.runtime_status.pid : null,
            heartbeatAt:
              typeof secondaryStatus.runtime_status?.lastHeartbeatAt === 'number'
                ? secondaryStatus.runtime_status.lastHeartbeatAt
                : typeof secondaryStatus.index_snapshot?.lastHeartbeatAt === 'number'
                ? secondaryStatus.index_snapshot.lastHeartbeatAt
                : null,
          }
        : null,
      manifestExtras: null,
      interaction: secondarySend
        ? {
            requestType: 'ping',
            responseType:
              typeof secondarySend.awaited_message?.parsed === 'object' && secondarySend.awaited_message?.parsed
                ? ((secondarySend.awaited_message.parsed as { type?: unknown }).type as string | null) ?? null
                : null,
            responseReceivedAt: secondarySend.awaited_message?.receivedAt ?? null,
          }
        : null,
      shutdown: secondaryCancel
        ? {
            signal: (secondaryCancel.shutdown as { signal?: string | null } | null)?.signal ?? null,
            durationMs: (secondaryCancel.shutdown as { durationMs?: number } | null)?.durationMs ?? null,
            forced: (secondaryCancel.shutdown as { forced?: boolean } | null)?.forced ?? null,
          }
        : null,
      traces: {
        spawn: secondarySpawnCall.traceId,
        status: secondaryStatusCall?.traceId,
        limits: secondaryLimitsCall?.traceId,
        role: secondaryRoleCall?.traceId,
        prompt: secondaryPromptCall?.traceId,
        promptPartial: secondaryPromptPartialCall?.traceId,
        promptFinal: secondaryPromptFinalCall?.traceId,
        send: secondarySendCall?.traceId,
        cancel: secondaryCancelCall?.traceId,
      },
    });

    if (directCreate && directCreateCall) {
      const tertiaryStatus = directCreate.runtime_status;
      const tertiaryMetadata = (directCreate.index_snapshot as { metadata?: Record<string, unknown> } | undefined)?.metadata;
      const tertiaryRole = (directCreate.index_snapshot as { role?: unknown } | undefined)?.role;
      childSummaries.push({
        childId: directCreate.child_id,
        opId: typeof directCreate.op_id === 'string' && directCreate.op_id.length > 0 ? directCreate.op_id : directCreate.child_id,
        role: typeof tertiaryRole === 'string' ? tertiaryRole : null,
        limits: null,
        manifestPath:
          typeof directCreate.manifest_path === 'string' && directCreate.manifest_path.length > 0
            ? directCreate.manifest_path
            : 'unknown',
        workdir:
          typeof directCreate.workdir === 'string' && directCreate.workdir.length > 0 ? directCreate.workdir : 'unknown',
        readyAt: typeof directCreate.started_at === 'number' ? directCreate.started_at : null,
        status: tertiaryStatus
          ? {
              lifecycle: String(tertiaryStatus.lifecycle ?? '') || null,
              pid: typeof tertiaryStatus.pid === 'number' ? tertiaryStatus.pid : null,
              heartbeatAt:
                typeof tertiaryStatus.lastHeartbeatAt === 'number' ? tertiaryStatus.lastHeartbeatAt : null,
            }
          : null,
        manifestExtras: tertiaryMetadata ?? null,
        interaction: null,
        shutdown: tertiaryKill
          ? {
              signal: (tertiaryKill.shutdown as { signal?: string | null } | null)?.signal ?? null,
              durationMs: (tertiaryKill.shutdown as { durationMs?: number } | null)?.durationMs ?? null,
              forced: (tertiaryKill.shutdown as { forced?: boolean } | null)?.forced ?? null,
            }
          : null,
        traces: {
          spawn: directCreateCall.traceId,
          rename: tertiaryRenameCall?.traceId,
          reset: tertiaryResetCall?.traceId,
          kill: tertiaryKillCall?.traceId,
          gc: tertiaryGcCall?.traceId,
        },
      });
    }
  } finally {
    await childProcessSupervisor.disposeAll().catch(() => {});
    await session.close().catch(() => {});
    restoreRunner();
    await server.close().catch(() => {});
  }

  const report: ChildStageReport = {
    runId: options.context.runId,
    completedAt: new Date().toISOString(),
    metrics: {
      totalCalls: calls.length,
      errorCount: calls.filter((entry) => entry.response.isError).length,
      spawnedChildren: childSummaries.length,
    },
    calls,
    children: childSummaries,
    cancellation: cancellationSummary,
  };

  const reportPath = path.join(options.context.directories.report, 'step04-child-orchestration.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    reportPath,
    calls,
    children: childSummaries,
    cancellation: cancellationSummary,
  };
}

