import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runTransactionsStage } from '../lib/transactions.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../src/server.js';
import type { FeatureToggles } from '../../../src/serverOptions.js';

/**
 * Deterministic clock helper ensuring generated artefact names remain stable
 * during tests. Each invocation increases the timestamp by one second so JSON
 * snapshots keep unique names without relying on real wall-clock time.
 */
function buildDeterministicClock(startIso = '2025-03-03T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1000);
}

describe('Stage 3 – Transaction, diff/patch and idempotency checks', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-transactions-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-transactions',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('transactions-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('runs the transaction stage and captures diff/patch/lock/idempotency artefacts', async () => {
    const result = await runTransactionsStage({ context, recorder });

    expect(result.graphId).to.equal('G_TEST');
    expect(result.calls.length).to.be.at.least(12);

    const toolNames = result.calls.map((entry) => `${entry.toolName}:${entry.scenario ?? 'default'}`);
    expect(toolNames).to.include.members([
      'tx_begin:tx_begin_initial',
      'tx_apply:tx_apply_enrichment',
      'tx_commit:tx_commit_initial',
      'graph_diff:graph_diff_post_commit',
      'graph_diff:graph_diff_patch_plan',
      'graph_diff:graph_diff_cycle_plan',
      'graph_patch:graph_patch_success',
      'graph_patch:graph_patch_invariant_violation',
      'graph_lock:graph_lock_acquire',
      'graph_unlock:graph_unlock_release',
      'tx_begin:tx_begin_idempotency_initial',
      'tx_begin:tx_begin_idempotency_replay',
      'tx_rollback:tx_rollback_idempotency_cleanup',
    ]);

    const invalidPatch = result.calls.find(
      (entry) => entry.toolName === 'graph_patch' && entry.scenario === 'graph_patch_invariant_violation',
    );
    expect(invalidPatch?.response.isError).to.equal(true);
    expect(invalidPatch?.response.errorCode).to.be.a('string');

    const replayCall = result.calls.find(
      (entry) => entry.toolName === 'tx_begin' && entry.scenario === 'tx_begin_idempotency_replay',
    );
    expect(replayCall?.response.isError).to.equal(false);
    const structuredReplay = replayCall?.response.structured as { idempotent?: boolean } | undefined;
    expect(structuredReplay?.idempotent).to.equal(true);

    if (result.finalGraphPath) {
      const stats = await stat(result.finalGraphPath);
      expect(stats.isFile()).to.equal(true);
    } else {
      expect.fail('expected finalGraphPath to be defined');
    }

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as {
      metrics: { totalCalls: number; errorCount: number };
      diff: { changed: boolean; operations: number } | null;
      patch: { failureCode: string | null };
      locks: { conflictCode: string | null; lockId: string };
      idempotency: {
        identicalPayload: boolean;
        initialFlag: boolean;
        replayFlag: boolean;
        txId: string;
      };
    };

    expect(report.metrics.totalCalls).to.equal(result.calls.length);
    expect(report.metrics.errorCount).to.be.greaterThan(0);
    expect(report.diff?.changed).to.equal(true);
    expect((report.diff?.operations ?? 0)).to.be.greaterThan(0);
    expect(report.patch.failureCode).to.equal('E-PATCH-CYCLE');
    expect(report.locks.lockId).to.be.a('string').and.to.have.length.greaterThan(0);
    expect(report.idempotency.identicalPayload).to.equal(true);
    expect(report.idempotency.initialFlag).to.equal(false);
    expect(report.idempotency.replayFlag).to.equal(true);
    expect(report.idempotency.txId).to.be.a('string').and.to.have.length.greaterThan(0);
  }).timeout(20_000);
});
