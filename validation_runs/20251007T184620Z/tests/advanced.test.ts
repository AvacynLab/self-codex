import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runAdvancedFunctionsStage } from '../lib/advanced.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../src/server.js';
import type { FeatureToggles } from '../../../src/serverOptions.js';

/**
 * Deterministic clock helper mirroring previous stages so timestamped artefacts
 * remain stable across test runs. Each invocation advances the virtual time by
 * one second to keep report payloads reproducible.
 */
function buildDeterministicClock(startIso = '2025-06-01T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

describe('Stage 7 – Advanced orchestration functions', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-advanced-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-advanced-stage',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('advanced-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('exercises causal, coordination and assistance tools with structured reports', async () => {
    const result = await runAdvancedFunctionsStage({ context, recorder });

    const scenarios = result.calls.map((entry) => `${entry.toolName}:${entry.scenario ?? 'default'}`);
    expect(scenarios).to.include.members([
      'kg_insert:kg_insert_stage7_seed',
      'plan_run_bt:plan_run_bt_causal_seed',
      'causal_export:causal_export_full',
      'causal_explain:causal_explain_outcome',
      'stig_mark:stig_mark_primary',
      'stig_decay:stig_decay_halflife',
      'stig_batch:stig_batch_reseed',
      'stig_snapshot:stig_snapshot_overview',
      'consensus_vote:consensus_vote_weighted',
      'cnp_announce:cnp_announce_manual_bids',
      'cnp_refresh_bounds:cnp_refresh_bounds_stage7',
      'cnp_watcher_telemetry:cnp_watcher_telemetry_snapshot',
      'kg_suggest_plan:kg_suggest_plan_goal',
      'logs_tail:logs_tail_recent',
    ]);

    expect(result.plan.runId).to.equal('stage7-causal-plan');
    expect(result.plan.status).to.be.oneOf(['success', 'done']);

    expect(result.causal.exportedEvents).to.be.greaterThan(0);
    expect(result.causal.explainedOutcomeId).to.be.a('string').and.to.have.length.greaterThan(0);
    expect(result.causal.explanationDepth).to.be.greaterThan(0);

    expect(result.stigmergy.nodeId).to.equal('stage7-node-a');
    expect(result.stigmergy.markIntensity).to.be.greaterThan(0);
    expect(result.stigmergy.decayedPoints).to.be.at.least(1);
    expect(result.stigmergy.batchApplied).to.be.at.least(2);
    expect(result.stigmergy.snapshotPoints).to.be.at.least(1);

    expect(result.consensus.outcome).to.equal('approve');
    expect(result.consensus.mode).to.equal('weighted');
    expect(result.consensus.satisfied).to.equal(true);
    expect(result.consensus.totalWeight).to.equal(5);

    expect(result.contractNet.awardedAgent).to.equal('agent-beta');
    expect(result.contractNet.bidCount).to.equal(3);
    expect(result.contractNet.autoBidEnabled).to.equal(false);
    expect(result.contractNet.boundsRefreshed).to.be.a('boolean');
    expect(result.contractNet.telemetryEnabled).to.be.a('boolean');
    expect(result.contractNet.telemetryEmissions).to.be.at.least(0);

    expect(result.knowledge.goal).to.equal('stage7-plan');
    expect(result.knowledge.inserted).to.equal(8);
    expect(result.knowledge.fragmentsSuggested).to.be.at.least(1);

    expect(result.logs.stream).to.equal('orchestrator');
    expect(result.logs.entries).to.be.at.least(1);

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as {
      metrics: { totalCalls: number; errorCount: number };
      knowledge: { fragmentsSuggested: number };
      consensus: { outcome: string };
      stigmergy: { batchApplied: number; snapshotPoints: number };
      contractNet: { boundsRefreshed: boolean | null };
    };

    expect(report.metrics.totalCalls).to.equal(result.calls.length);
    expect(report.metrics.errorCount).to.equal(0);
    expect(report.knowledge.fragmentsSuggested).to.equal(result.knowledge.fragmentsSuggested);
    expect(report.consensus.outcome).to.equal('approve');
    expect(report.stigmergy.batchApplied).to.equal(result.stigmergy.batchApplied);
    expect(report.contractNet.boundsRefreshed).to.equal(result.contractNet.boundsRefreshed);
  }).timeout(25_000);
});
