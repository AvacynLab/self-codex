import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runResilienceStage } from '../lib/resilience.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../../src/server.js';
import type { FeatureToggles } from '../../../../src/serverOptions.js';

/**
 * Deterministic clock helper ensuring timestamped artefacts remain stable across
 * test runs. Each invocation advances the virtual time by one second so JSON
 * payloads retain reproducible completion markers.
 */
function buildDeterministicClock(startIso = '2025-06-01T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

describe('Stage 6 – Resilience and cancellation checks', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-resilience-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-resilience-stage',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('resilience-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('cancels long running plans and surfaces informative error probes', async () => {
    const result = await runResilienceStage({ context, recorder });

    const scenarios = result.calls.map((entry) => `${entry.toolName}:${entry.scenario ?? 'default'}`);
    expect(scenarios).to.include.members([
      'plan_run_bt:plan_run_bt_long_operation',
      'op_cancel:op_cancel_long_operation',
      'plan_run_reactive:plan_run_reactive_cancellable',
      'plan_cancel:plan_cancel_reactive',
      'plan_status:plan_status_after_cancel',
      'op_cancel:op_cancel_unknown',
      'plan_cancel:plan_cancel_invalid_input',
      'plan_run_bt:plan_run_bt_timeout',
      'plan_run_bt:plan_run_bt_invalid_parameters',
      'plan_run_bt:plan_run_bt_missing_dependency',
    ]);

    expect(result.longOperation).to.not.equal(null);
    expect(result.longOperation?.cancelOutcome).to.be.oneOf(['requested', 'already_cancelled']);
    expect(result.longOperation?.planErrorCode).to.be.oneOf(['E-CANCEL-OP', 'E-BT-RUN-TIMEOUT', null]);

    expect(result.planCancellation).to.not.equal(null);
    expect(result.planCancellation?.operations.length ?? 0).to.be.at.least(1);
    expect(result.planCancellation?.statusAfterCancel).to.be.oneOf(['cancelled', 'failed', 'done']);

    const probes = result.errorProbes;
    expect(probes.invalidOpCancel?.errorCode).to.equal('E-CANCEL-NOTFOUND');
    expect(probes.invalidOpCancel?.hint).to.equal('verify opId via events_subscribe');
    expect(probes.invalidPlanCancel?.errorCode).to.equal('E-CANCEL-INVALID-INPUT');
    expect(probes.timeout?.errorCode).to.equal('E-BT-RUN-TIMEOUT');
    expect(probes.invalidParameters?.errorCode).to.equal('E-PLAN-INVALID-INPUT');
    expect(probes.missingDependency?.errorCode).to.equal('E-BB-DISABLED');

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as {
      metrics: { totalCalls: number; errorCount: number; cancellationsIssued: number };
      errorProbes: Record<string, { errorCode: string | null }>;
      planCancellation: { operations: unknown[] } | null;
    };

    expect(report.metrics.totalCalls).to.equal(result.calls.length);
    expect(report.metrics.errorCount).to.be.at.least(4);
    expect(report.metrics.cancellationsIssued).to.equal(2);
    expect(report.planCancellation?.operations.length ?? 0).to.equal(result.planCancellation?.operations.length ?? 0);
    expect(report.errorProbes.timeout?.errorCode).to.equal('E-BT-RUN-TIMEOUT');
  }).timeout(25_000);
});
