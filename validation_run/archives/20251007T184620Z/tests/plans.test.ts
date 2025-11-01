import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runPlanningStage } from '../lib/plans.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../../src/server.js';
import type { FeatureToggles } from '../../../../src/serverOptions.js';

/**
 * Deterministic clock helper ensuring that artefact timestamps remain stable
 * across repeated executions. Each invocation advances time by one second so
 * JSON snapshots retain unique yet predictable timestamps.
 */
function buildDeterministicClock(startIso = '2025-05-01T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

describe('Stage 5 – Planning, values and lifecycle checks', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-plans-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-plans-stage',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('plans-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('exercises plan lifecycle controls, value guard explanations and knowledge tooling', async () => {
    const result = await runPlanningStage({ context, recorder });

    const toolScenarios = result.calls.map((entry) => `${entry.toolName}:${entry.scenario ?? 'default'}`);
    expect(toolScenarios).to.include.members([
      'values_set:values_set_baseline',
      'values_score:values_score_stage5',
      'values_filter:values_filter_stage5',
      'graph_generate:graph_generate_stage5',
      'graph_mutate:graph_mutate_enrichment',
      'plan_dry_run:plan_dry_run_stage5',
      'values_explain:values_explain_stage5',
      'plan_compile_bt:plan_compile_bt_stage5',
      'plan_fanout:plan_fanout_stage5',
      'plan_join:plan_join_quorum_stage5',
      'plan_reduce:plan_reduce_concat_stage5',
      'plan_reduce:plan_reduce_merge_json_stage5',
      'plan_reduce:plan_reduce_vote_stage5',
      'child_send:plan_fanout_child_prompt_1',
      'plan_run_bt:plan_run_bt_stage5',
      'plan_run_reactive:plan_run_reactive_stage5',
      'plan_pause:plan_pause_reactive',
      'plan_resume:plan_resume_reactive',
      'plan_status:plan_status_paused',
      'plan_status:plan_status_resumed',
      'plan_status:plan_status_completed',
      'kg_insert:kg_insert_stage5',
      'kg_query:kg_query_stage5',
      'kg_export:kg_export_stage5',
    ]);

    expect(result.graph.nodeCount).to.be.at.least(6);
    expect(result.graph.edgeCount).to.be.greaterThan(5);
    expect(result.graph.mutationCount).to.be.greaterThan(0);

    expect(result.btPlan?.status).to.equal('success');
    expect(result.values.explanation?.decision.allowed).to.be.a('boolean');
    expect(result.values.score?.decision.score).to.be.a('number');
    expect(result.values.filter?.allowed).to.be.a('boolean');
    expect(result.values.filter?.threshold).to.be.a('number');
    expect(result.knowledge.inserted?.inserted.length ?? 0).to.equal(2);
    expect(result.knowledge.queried?.triples.length ?? 0).to.be.at.least(2);
    expect(result.knowledge.exported?.triples.length ?? 0).to.be.at.least(2);

    expect(result.orchestration.compiled?.id).to.equal('stage5-compile-hier');
    expect(result.orchestration.compiled?.root.type).to.be.oneOf(['sequence', 'task']);
    expect(result.orchestration.fanout?.child_ids.length ?? 0).to.equal(3);
    expect(result.orchestration.childResponses.length).to.equal(3);
    expect(result.orchestration.childResponses.every((entry) => entry.status === 'fulfilled')).to.equal(true);
    expect(result.orchestration.childResponses.every((entry) => entry.attempts >= 1)).to.equal(true);
    expect(result.orchestration.childResponses.every((entry) => entry.errorMessage === null)).to.equal(true);
    expect(result.orchestration.joins.length).to.be.at.least(2);
    expect(result.orchestration.joins[0]?.satisfied).to.equal(true);
    expect(result.orchestration.reductions.length).to.be.at.least(3);
    expect(result.orchestration.reductions.some((entry) => entry.reducer === 'concat')).to.equal(true);
    expect(result.orchestration.reductions.some((entry) => entry.reducer === 'merge_json')).to.equal(true);
    expect(result.orchestration.reductions.some((entry) => entry.reducer === 'vote')).to.equal(true);

    const pauseSnapshot = result.reactivePlan.pauseSnapshot;
    expect(pauseSnapshot?.state).to.equal('paused');
    const resumeSnapshot = result.reactivePlan.resumeSnapshot;
    expect(resumeSnapshot?.state).to.equal('running');
    expect(result.reactivePlan.finalSnapshot?.state).to.equal('done');

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as {
      metrics: { totalCalls: number; errorCount: number };
      values: {
        explanationDecision: string | null;
        configuredValues: number;
        scoreAllowed: boolean | null;
        filterAllowed: boolean | null;
        filterScore: number | null;
      };
      plan: {
        compiled: { treeId: string | null; taskCount: number };
        fanout: { childCount: number; responsesCaptured: number; failedCount: number; degradedChildren: string[] };
        joins: Array<{ policy: string; satisfied: boolean }>;
        reductions: Array<{ reducer: string; aggregateKind: string }>;
        reactive: { pauseState: string | null; finalState: string | null };
      };
      knowledge: { exported: number; inserted: number; updated: number };
    };

    expect(report.metrics.totalCalls).to.equal(result.calls.length);
    expect(report.metrics.errorCount).to.be.at.least(0);
    expect(report.values.configuredValues).to.equal(3);
    expect(report.values.explanationDecision).to.be.oneOf(['accepted', 'rejected', null]);
    expect(report.values.scoreAllowed).to.equal(result.values.score?.decision.allowed ?? null);
    expect(report.values.filterAllowed).to.equal(result.values.filter?.allowed ?? null);
    expect(report.values.filterScore).to.equal(result.values.filter?.score ?? null);
    expect(report.plan.compiled.treeId).to.equal('stage5-compile-hier');
    expect(report.plan.compiled.taskCount).to.equal(3);
    expect(report.plan.fanout.childCount).to.equal(3);
    expect(report.plan.fanout.responsesCaptured).to.equal(3);
    expect(report.plan.fanout.failedCount).to.equal(0);
    expect(report.plan.fanout.degradedChildren).to.deep.equal([]);
    expect(toolScenarios.some((scenario) => scenario === 'plan_join:plan_join_all_stage5' || scenario === 'plan_join:plan_join_all_stage5_degraded')).to.equal(true);
    expect(report.plan.joins.some((entry) => entry.policy === 'quorum')).to.equal(true);
    expect(report.plan.reductions.some((entry) => entry.reducer === 'concat')).to.equal(true);
    expect(report.plan.reductions.some((entry) => entry.reducer === 'merge_json')).to.equal(true);
    expect(report.plan.reductions.some((entry) => entry.reducer === 'vote')).to.equal(true);
    expect(report.plan.reactive.pauseState).to.equal('paused');
    expect(report.plan.reactive.finalState).to.equal('done');
    expect(report.knowledge.exported).to.equal(result.knowledge.exported?.triples.length ?? 0);
  }).timeout(25_000);
});
