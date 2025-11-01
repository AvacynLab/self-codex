import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ensureRunDirectories,
  createTraceIdFactory,
  type RunContext,
} from '../lib/runContext.js';
import { ArtifactRecorder, type ToolCallArtefacts } from '../lib/artifactRecorder.js';
import { runFinalReportStage } from '../lib/finalReport.js';

import type { BaseToolCallSummary } from '../lib/baseTools.js';
import type { BaseToolsStageReport } from '../lib/baseTools.js';
import type { TransactionsStageReport } from '../lib/transactions.js';
import type { ChildStageReport } from '../lib/children.js';
import type { PlanningStageReport } from '../lib/plans.js';
import type { ResilienceStageReport } from '../lib/resilience.js';
import type { AdvancedFunctionsStageReport } from '../lib/advanced.js';

/**
 * Builds a deterministic clock so Markdown artefacts contain reproducible
 * timestamps. Each tick advances by one second to guarantee unique values.
 */
function buildDeterministicClock(startIso = '2025-07-01T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

/** Helper assembling a call summary with predictable artefact paths. */
function buildCall(
  context: RunContext,
  options: {
    readonly toolName: string;
    readonly scenario?: string;
    readonly durationMs?: number;
    readonly isError?: boolean;
    readonly errorCode?: string | null;
    readonly hint?: string | null;
  },
): BaseToolCallSummary {
  const scenario = options.scenario ?? 'default';
  const artefacts: ToolCallArtefacts = {
    inputPath: path.join(context.directories.inputs, `${options.toolName}-${scenario}-input.json`),
    outputPath: path.join(context.directories.outputs, `${options.toolName}-${scenario}-output.json`),
  };
  return {
    toolName: options.toolName,
    scenario,
    traceId: `${options.toolName}-${scenario}`,
    durationMs: options.durationMs ?? 100,
    artefacts,
    response: {
      isError: options.isError ?? false,
      structured: options.errorCode ? { error: options.errorCode } : undefined,
      parsedText: undefined,
      errorCode: options.errorCode ?? null,
      hint: options.hint ?? null,
    },
  };
}

describe('Stage 8 – Final report generation', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-final-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-final-stage',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('final-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('aggregates stage artefacts into summary, findings and recommendations', async () => {
    const baseCalls = [
      buildCall(context, { toolName: 'graph_generate', scenario: 'valid', durationMs: 120 }),
      buildCall(context, {
        toolName: 'graph_validate',
        scenario: 'invalid',
        durationMs: 80,
        isError: true,
        errorCode: 'graph/invalid-input',
        hint: 'ensure nodes exist',
      }),
      buildCall(context, { toolName: 'logs_tail', durationMs: 40 }),
    ];
    const baseReport: BaseToolsStageReport = {
      runId: context.runId,
      completedAt: '2025-07-01T00:00:01.000Z',
      calls: baseCalls,
      metrics: { totalCalls: baseCalls.length, errorCount: 1 },
      generatedGraphId: 'graph-baseline',
    };

    const txCalls = [
      buildCall(context, { toolName: 'tx_begin', scenario: 'initial', durationMs: 55 }),
      buildCall(context, {
        toolName: 'graph_patch',
        scenario: 'graph_patch_invariant_violation',
        durationMs: 95,
        isError: true,
        errorCode: 'graph/conflict',
      }),
      buildCall(context, { toolName: 'tx_commit', scenario: 'commit', durationMs: 60 }),
    ];
    const transactionsReport: TransactionsStageReport = {
      runId: context.runId,
      completedAt: '2025-07-01T00:00:02.000Z',
      graphId: 'graph-stage3',
      calls: txCalls,
      metrics: { totalCalls: txCalls.length, errorCount: 1, committedVersion: 2, patchedVersion: 3 },
      diff: { traceId: 'diff-trace', changed: true, operations: 4 },
      patch: { successTraceId: 'patch-success', failureTraceId: 'patch-failure', failureCode: 'graph/conflict' },
      locks: {
        acquiredTraceId: 'lock-success',
        lockId: 'lock-1',
        conflictTraceId: 'lock-conflict',
        conflictCode: null,
        releasedTraceId: 'unlock-success',
      },
      idempotency: {
        key: 'stage3-key',
        initialTraceId: 'tx-initial',
        replayTraceId: 'tx-replay',
        identicalPayload: true,
        initialFlag: true,
        replayFlag: true,
        txId: 'tx-verified',
      },
      finalGraphPath: path.join(context.directories.resources, 'stage03-graph.json'),
    };

    const childReport: ChildStageReport = {
      runId: context.runId,
      completedAt: '2025-07-01T00:00:03.000Z',
      metrics: { totalCalls: 5, errorCount: 0, spawnedChildren: 2 },
      calls: [
        buildCall(context, { toolName: 'child_spawn_codex', scenario: 'primary', durationMs: 110 }),
        buildCall(context, { toolName: 'child_set_limits', scenario: 'limits', durationMs: 70 }),
      ],
      children: [
        {
          childId: 'child-alpha',
          opId: 'op-alpha',
          role: 'planner',
          limits: { cpu: 1 },
          manifestPath: path.join(context.directories.resources, 'child-alpha.json'),
          workdir: path.join(context.rootDir, 'children', 'alpha'),
          readyAt: 1_720_000_000,
          status: { lifecycle: 'running', pid: 100, heartbeatAt: 1_720_000_500 },
          manifestExtras: { version: '1.0.0' },
          interaction: { requestType: 'prompt', responseType: 'text', responseReceivedAt: 1_720_000_600 },
          shutdown: { signal: 'SIGTERM', durationMs: 250, forced: false },
          traces: { spawn: 'spawn-trace', status: 'status-trace', limits: 'limits-trace', send: 'send-trace', cancel: 'cancel-trace' },
        },
      ],
      cancellation: {
        opId: 'op-alpha',
        runId: 'plan-run-1',
        outcome: 'requested',
        reason: 'cleanup',
        cancelTraceId: 'cancel-trace',
        planTraceId: 'plan-trace',
        planErrorCode: null,
        planStatus: 'cancelled',
      },
    };

    const planningCalls = [
      buildCall(context, { toolName: 'values_set', scenario: 'baseline', durationMs: 60 }),
      buildCall(context, { toolName: 'plan_run_bt', scenario: 'bt', durationMs: 150 }),
      buildCall(context, { toolName: 'plan_status', scenario: 'final', durationMs: 45 }),
    ];
    const planningReport: PlanningStageReport = {
      runId: context.runId,
      completedAt: '2025-07-01T00:00:04.000Z',
      metrics: { totalCalls: planningCalls.length, errorCount: 0 },
      calls: planningCalls,
      graph: {
        graphId: 'graph-stage5',
        version: 7,
        nodeCount: 8,
        edgeCount: 9,
        mutationCount: 4,
        metadataKeys: 3,
      },
      values: {
        configuredValues: 3,
        relationships: 4,
        defaultThreshold: 0.4,
        explanationDecision: 'accepted',
        explanationAllowed: true,
        explanationViolations: 0,
      },
      plan: {
        bt: { runId: 'bt-run', status: 'success', ticks: 10, idempotent: true },
        reactive: {
          runId: 'reactive-run',
          status: 'done',
          loopTicks: 5,
          schedulerTicks: 2,
          pauseState: 'paused',
          resumeState: 'running',
          finalState: 'done',
        },
      },
      knowledge: { inserted: 2, queried: 3 },
    };

    const resilienceCalls = [
      buildCall(context, { toolName: 'op_cancel', scenario: 'op_cancel_long_operation', durationMs: 130 }),
      buildCall(context, {
        toolName: 'plan_run_bt',
        scenario: 'plan_run_bt_timeout',
        durationMs: 210,
        isError: true,
        errorCode: 'plan/timeout',
      }),
    ];
    const resilienceReport: ResilienceStageReport = {
      runId: context.runId,
      completedAt: '2025-07-01T00:00:05.000Z',
      metrics: { totalCalls: resilienceCalls.length, errorCount: 1, cancellationsIssued: 1 },
      calls: resilienceCalls,
      longOperation: {
        opId: 'long-op',
        runId: 'long-plan',
        cancelOutcome: 'requested',
        cancelReason: 'test-cancel',
        planStatus: 'cancelled',
        planErrorCode: null,
        cancelTraceId: 'cancel-trace',
        planTraceId: 'plan-trace',
        planDurationMs: 200,
      },
      planCancellation: {
        runId: 'reactive-run',
        reason: 'timeout',
        lifecycleState: 'cancelling',
        lifecycleProgress: 50,
        cancelTraceId: 'plan-cancel',
        planTraceId: 'plan-run',
        planErrorCode: 'plan/cancelled',
        statusAfterCancel: 'cancelled',
        operations: [{ opId: 'op-1', outcome: 'cancelled' }],
      },
      errorProbes: {
        invalidOpCancel: {
          toolName: 'op_cancel',
          scenario: 'op_cancel_unknown',
          traceId: 'probe-op',
          isError: true,
          errorCode: 'op/not-found',
          hint: 'verify identifier',
          durationMs: 30,
        },
        invalidPlanCancel: null,
        timeout: {
          toolName: 'plan_run_bt',
          scenario: 'plan_run_bt_timeout',
          traceId: 'probe-timeout',
          isError: true,
          errorCode: 'plan/timeout',
          hint: 'increase deadline',
          durationMs: 210,
        },
        invalidParameters: null,
        missingDependency: null,
      },
    };

    const advancedCalls = [
      buildCall(context, { toolName: 'kg_insert', scenario: 'seed', durationMs: 90 }),
      buildCall(context, { toolName: 'causal_export', scenario: 'full', durationMs: 140 }),
      buildCall(context, {
        toolName: 'stig_decay',
        scenario: 'stig_decay_halflife',
        durationMs: 75,
        isError: false,
      }),
      buildCall(context, {
        toolName: 'cnp_announce',
        scenario: 'cnp_announce_manual_bids',
        durationMs: 160,
        isError: false,
      }),
    ];
    const advancedReport: AdvancedFunctionsStageReport = {
      runId: context.runId,
      completedAt: '2025-07-01T00:00:06.000Z',
      metrics: { totalCalls: advancedCalls.length, errorCount: 0 },
      calls: advancedCalls,
      plan: { runId: 'stage7-causal-plan', status: 'success', ticks: 12 },
      knowledge: {
        goal: 'stage7-plan',
        inserted: 8,
        updated: 2,
        total: 10,
        fragmentsSuggested: 4,
        rationaleCount: 3,
      },
      causal: {
        exportedEvents: 5,
        explainedOutcomeId: 'outcome-123',
        explanationDepth: 3,
        ancestorCount: 2,
      },
      stigmergy: {
        nodeId: 'stage7-node-a',
        markIntensity: 10,
        decayedPoints: 2,
        remainingIntensity: 5,
      },
      consensus: {
        outcome: 'approve',
        mode: 'weighted',
        satisfied: true,
        totalWeight: 5,
        votes: 3,
      },
      contractNet: {
        callId: 'contract-1',
        awardedAgent: 'agent-beta',
        bidCount: 3,
        autoBidEnabled: false,
        idempotentReplay: true,
      },
      logs: {
        stream: 'orchestrator',
        bucketId: 'bucket-1',
        entries: 5,
        nextSeq: null,
      },
    };

    const stage1Report = {
      info: { version: '1.0.0' },
      capabilities: {
        tools: [
          { name: 'graph_generate' },
          { name: 'graph_validate' },
          { name: 'logs_tail' },
          { name: 'tx_begin' },
          { name: 'plan_run_bt' },
          { name: 'cnp_announce' },
          { name: 'uncovered_tool' },
        ],
      },
      resources: {
        prefixes: [
          { prefix: 'sc://graphs/', count: 4 },
          { prefix: 'sc://plans/', count: 3 },
        ],
      },
      events: { published_seq: 42, baseline_count: 1, follow_up_count: 3 },
    };

    await writeFile(path.join(context.directories.report, 'step01-introspection.json'), `${JSON.stringify(stage1Report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(context.directories.report, 'step02-base-tools.json'), `${JSON.stringify(baseReport, null, 2)}\n`, 'utf8');
    await writeFile(path.join(context.directories.report, 'step03-transactions.json'), `${JSON.stringify(transactionsReport, null, 2)}\n`, 'utf8');
    await writeFile(path.join(context.directories.report, 'step04-child-orchestration.json'), `${JSON.stringify(childReport, null, 2)}\n`, 'utf8');
    await writeFile(path.join(context.directories.report, 'step05-plans-values.json'), `${JSON.stringify(planningReport, null, 2)}\n`, 'utf8');
    await writeFile(path.join(context.directories.report, 'step06-resilience.json'), `${JSON.stringify(resilienceReport, null, 2)}\n`, 'utf8');
    await writeFile(path.join(context.directories.report, 'step07-advanced-functions.json'), `${JSON.stringify(advancedReport, null, 2)}\n`, 'utf8');

    const result = await runFinalReportStage({ context, recorder, clock: buildDeterministicClock('2025-07-02T00:00:00.000Z') });

    expect(result.metrics.totalCalls).to.equal(
      baseCalls.length +
        txCalls.length +
        childReport.calls.length +
        planningCalls.length +
        resilienceCalls.length +
        advancedCalls.length,
    );
    expect(result.tools).to.not.be.empty;
    const toolNames = result.tools.map((entry) => entry.toolName);
    expect(toolNames).to.include.members(['graph_generate', 'plan_run_bt', 'cnp_announce']);

    const summary = await readFile(result.summaryPath, 'utf8');
    expect(summary).to.include('Étape 8 – Rapport final');
    expect(summary).to.include('| Étape 7 – Fonctions avancées | ✅ Terminée');
    expect(summary).to.include('Appels MCP totaux');
    expect(summary).to.include('cnp_announce');
    expect(summary).to.include('Outils annoncés exercés : 6 / 7');
    expect(summary).to.include('Outils manquants : uncovered_tool');
    expect(summary).to.include('Couverture incomplète : 1/7');

    const findings = JSON.parse(await readFile(result.findingsPath, 'utf8')) as {
      metrics: { totalCalls: number; uniqueTools: number };
      tools: Array<{ toolName: string; averageDurationMs: number }>;
      coverage: { expectedTools: number; coveredTools: number; missingTools: string[]; unexpectedTools: string[] };
    };
    expect(findings.metrics.totalCalls).to.equal(result.metrics.totalCalls);
    const cnp = findings.tools.find((entry) => entry.toolName === 'cnp_announce');
    expect(cnp?.averageDurationMs).to.be.closeTo(160, 0.1);
    expect(findings.coverage.expectedTools).to.equal(7);
    expect(findings.coverage.coveredTools).to.equal(6);
    expect(findings.coverage.missingTools).to.deep.equal(['uncovered_tool']);
    expect(findings.coverage.unexpectedTools).to.include('graph_patch');

    expect(result.coverage.expectedTools).to.equal(7);
    expect(result.coverage.coveredTools).to.equal(6);
    expect(result.coverage.missingTools).to.deep.equal(['uncovered_tool']);
    expect(result.coverage.unexpectedTools).to.include('graph_patch');

    const recommendations = await readFile(result.recommendationsPath, 'utf8');
    expect(recommendations).to.include('## Quelles tools sont sous-documentées');
    expect(recommendations).to.include('graph_patch');
    expect(recommendations).to.include('latence P95');
  }).timeout(10_000);
});
