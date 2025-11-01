import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runBaseToolsStage } from '../lib/baseTools.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../../src/server.js';
import type { FeatureToggles } from '../../../../src/serverOptions.js';

/**
 * Deterministic clock helper ensuring generated artefact names remain stable
 * during tests. Each invocation increases the timestamp by one second so JSON
 * snapshots keep unique names without relying on real wall-clock time.
 */
function buildDeterministicClock(startIso = '2025-02-02T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1000);
}

describe('Stage 2 – Base MCP tool smoke tests', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-base-tools-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-base-tools',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('base-tools-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('runs the base tools stage and persists deterministic artefacts', async () => {
    const result = await runBaseToolsStage({ context, recorder });

    expect(result.calls.length).to.be.at.least(54);
    const toolNames = result.calls.map((entry) => entry.toolName);
    expect(toolNames).to.include.members([
      'graph_generate',
      'graph_validate',
      'graph_summarize',
      'graph_paths_k_shortest',
      'graph_mutate',
      'logs_tail',
      'mcp_info',
      'mcp_capabilities',
      'resources_list',
      'events_subscribe',
      'events_view',
      'events_view_live',
      'agent_autoscale_set',
      'bb_set',
      'bb_get',
      'bb_batch_set',
      'bb_query',
      'bb_watch',
      'graph_export',
      'graph_state_stats',
      'graph_state_metrics',
      'graph_state_inactivity',
      'graph_config_retention',
      'graph_config_runtime',
      'graph_prune',
      'graph_query',
      'graph_state_save',
      'graph_state_load',
      'graph_state_autosave',
      'graph_subgraph_extract',
      'graph_hyper_export',
      'graph_rewrite_apply',
      'graph_batch_mutate',
      'graph_paths_constrained',
      'graph_centrality_betweenness',
      'graph_partition',
      'graph_critical_path',
      'graph_simulate',
      'graph_optimize',
      'graph_optimize_moo',
      'graph_causal_analyze',
      'graph_forge_analyze',
      'status',
      'job_view',
      'conversation_view',
      'start',
      'aggregate',
      'kill',
    ]);

    const invalidCall = result.calls.find(
      (entry) => entry.toolName === 'graph_paths_k_shortest' && entry.scenario === 'invalid',
    );
    expect(invalidCall).to.not.equal(undefined);
    expect(invalidCall?.response.isError).to.equal(true);
    expect(invalidCall?.response.errorCode).to.equal('transport_failure');
    expect(
      typeof (invalidCall?.response.parsedText as { message?: string } | undefined)?.message,
    ).to.equal('string');
    expect(
      (invalidCall?.response.parsedText as { message?: string } | undefined)?.message ?? '',
    ).to.contain('Invalid arguments for tool graph_paths_k_shortest');

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as {
      metrics: { totalCalls: number; errorCount: number };
      calls: Array<{ toolName: string; scenario?: string }>;
    };
    expect(report.metrics.totalCalls).to.equal(result.calls.length);
    expect(report.calls.some((entry) => entry.scenario === 'invalid')).to.equal(true);

    if (result.generatedGraphPath) {
      const stats = await stat(result.generatedGraphPath);
      expect(stats.isFile()).to.equal(true);
    } else {
      expect.fail('expected generatedGraphPath to be defined');
    }

    const logsTailCall = result.calls.find((entry) => entry.toolName === 'logs_tail');
    expect(logsTailCall?.response.isError).to.equal(false);
    expect(logsTailCall?.response.structured).to.be.an('object');

    // The blackboard bulk operation should persist both entries and expose them
    // in the structured payload so Stage 8 can audit the namespace contents.
    const bbBatchSetCall = result.calls.find((entry) => entry.toolName === 'bb_batch_set');
    expect(bbBatchSetCall?.response.isError).to.equal(false);
    expect(
      Array.isArray((bbBatchSetCall?.response.structured as { entries?: unknown[] } | undefined)?.entries),
    ).to.equal(true);

    // Watching from the baseline version should deliver a bounded history with
    // a forward cursor that future stages can reuse.
    const bbWatchCall = result.calls.find((entry) => entry.toolName === 'bb_watch');
    expect(bbWatchCall?.response.isError).to.equal(false);
    const watchStructured = bbWatchCall?.response.structured as { events?: unknown[]; next_version?: number } | undefined;
    expect(Array.isArray(watchStructured?.events)).to.equal(true);
    expect(typeof watchStructured?.next_version).to.equal('number');

    const graphExportCall = result.calls.find((entry) => entry.toolName === 'graph_export');
    expect(graphExportCall?.response.isError).to.equal(false);
    const exportPayload = graphExportCall?.response.structured as { graph?: unknown; preview?: unknown } | undefined;
    const exportParsed = graphExportCall?.response.parsedText as { graph?: unknown } | undefined;
    expect(exportPayload ?? exportParsed).to.not.equal(undefined);

    const statsCall = result.calls.find((entry) => entry.toolName === 'graph_state_stats');
    expect(statsCall?.response.isError).to.equal(false);
    const statsParsed = statsCall?.response.parsedText as { stats?: { nodes?: unknown } } | undefined;
    expect(statsParsed?.stats).to.be.an('object');

    const metricsCall = result.calls.find((entry) => entry.toolName === 'graph_state_metrics');
    expect(metricsCall?.response.isError).to.equal(false);
    const metricsParsed = metricsCall?.response.parsedText as { jobs?: unknown } | undefined;
    expect(metricsParsed?.jobs).to.be.an('object');

    const inactivityCall = result.calls.find((entry) => entry.toolName === 'graph_state_inactivity');
    expect(inactivityCall?.response.isError).to.equal(false);
    const inactivityParsed = inactivityCall?.response.parsedText as { items?: unknown[]; format?: string } | undefined;
    expect(inactivityParsed?.format).to.equal('json');
    expect(Array.isArray(inactivityParsed?.items)).to.equal(true);

    const retentionCall = result.calls.find((entry) => entry.toolName === 'graph_config_retention');
    expect(retentionCall?.response.isError).to.equal(false);
    expect((retentionCall?.response.parsedText as { ok?: boolean } | undefined)?.ok).to.equal(true);

    const runtimeCalls = result.calls.filter((entry) => entry.toolName === 'graph_config_runtime');
    expect(runtimeCalls.length).to.be.at.least(2);
    const runtimeReset = runtimeCalls.find((entry) => entry.scenario === 'graph_config_runtime_reset');
    expect((runtimeReset?.response.parsedText as { ok?: boolean } | undefined)?.ok).to.equal(true);

    const pruneEventsCall = result.calls.find(
      (entry) => entry.toolName === 'graph_prune' && entry.scenario === 'graph_prune_events',
    );
    expect(pruneEventsCall?.response.isError).to.equal(false);

    const pruneTranscriptCall = result.calls.find(
      (entry) => entry.toolName === 'graph_prune' && entry.scenario === 'graph_prune_transcript_missing',
    );
    expect(pruneTranscriptCall?.response.isError).to.equal(false);

    const graphQueryCall = result.calls.find((entry) => entry.toolName === 'graph_query');
    expect(graphQueryCall?.response.isError).to.equal(false);
    const queryParsed = graphQueryCall?.response.parsedText as { nodes?: unknown[] } | undefined;
    expect(queryParsed?.nodes).to.be.an('array');

    const graphStateSaveCall = result.calls.find((entry) => entry.toolName === 'graph_state_save');
    expect(graphStateSaveCall?.response.isError).to.equal(false);
    const graphStateLoadCall = result.calls.find((entry) => entry.toolName === 'graph_state_load');
    expect(graphStateLoadCall?.response.isError).to.equal(false);

    const autosaveCalls = result.calls.filter((entry) => entry.toolName === 'graph_state_autosave');
    expect(autosaveCalls.map((entry) => entry.scenario)).to.include.members([
      'graph_state_autosave_start',
      'graph_state_autosave_stop',
    ]);
    autosaveCalls.forEach((entry) => {
      expect(entry.response.isError).to.equal(false);
      expect((entry.response.parsedText as { status?: string } | undefined)?.status).to.be.oneOf([
        'started',
        'stopped',
        undefined,
      ]);
    });

    const graphMutateCall = result.calls.find((entry) => entry.toolName === 'graph_mutate');
    expect(graphMutateCall?.response.isError).to.equal(false);
    const mutateStructured = graphMutateCall?.response.structured as
      | { graph?: { nodes?: Array<{ id?: string; attributes?: Record<string, unknown> }> } }
      | undefined;
    const mutateGraph = mutateStructured?.graph;
    expect(mutateGraph).to.be.an('object');
    const qaNode = mutateGraph?.nodes?.find((node) => node?.id === 'qa');
    expect(qaNode).to.not.equal(undefined);
    expect((qaNode?.attributes as Record<string, unknown> | undefined)?.priority).to.equal('high');

    const batchCalls = result.calls.filter((entry) => entry.toolName === 'graph_batch_mutate');
    expect(batchCalls.map((entry) => entry.scenario)).to.include.members([
      'graph_batch_mutate_attributes',
      'graph_batch_mutate_conflict',
    ]);

    const batchSuccess = batchCalls.find((entry) => entry.scenario === 'graph_batch_mutate_attributes');
    expect(batchSuccess?.response.isError).to.equal(false);
    const batchStructured = batchSuccess?.response.structured as
      | {
          graph_id?: string;
          base_version?: number;
          committed_version?: number;
          changed?: boolean;
          operations_applied?: number;
          idempotent?: boolean;
        }
      | undefined;
    expect(batchStructured?.graph_id).to.be.a('string');
    expect(batchStructured?.committed_version).to.be.a('number');
    expect(batchStructured?.operations_applied).to.equal(2);
    expect(batchStructured?.idempotent).to.equal(false);

    const batchConflict = batchCalls.find((entry) => entry.scenario === 'graph_batch_mutate_conflict');
    expect(batchConflict?.response.isError).to.equal(true);
    expect(batchConflict?.response.errorCode).to.equal('transport_failure');

    const constrainedValid = result.calls.find(
      (entry) => entry.toolName === 'graph_paths_constrained' && entry.scenario === 'graph_paths_constrained_budget',
    );
    expect(constrainedValid?.response.isError).to.equal(false);
    const constrainedStructured = constrainedValid?.response.structured as
      | { status?: string; path?: unknown[]; filtered?: { nodes?: number; edges?: number } }
      | undefined;
    expect(constrainedStructured?.status).to.equal('found');
    expect(Array.isArray(constrainedStructured?.path)).to.equal(true);
    expect(typeof constrainedStructured?.filtered?.nodes).to.equal('number');

    const constrainedInvalid = result.calls.find(
      (entry) => entry.toolName === 'graph_paths_constrained' && entry.scenario === 'graph_paths_constrained_missing',
    );
    expect(constrainedInvalid?.response.isError).to.equal(true);
    expect(constrainedInvalid?.response.errorCode).to.equal('transport_failure');

    const centralityCall = result.calls.find(
      (entry) => entry.toolName === 'graph_centrality_betweenness',
    );
    expect(centralityCall?.response.isError).to.equal(false);
    const centralityStructured = centralityCall?.response.structured as
      | { top?: Array<{ node?: string; score?: number }>; statistics?: { max?: number } }
      | undefined;
    expect(Array.isArray(centralityStructured?.top)).to.equal(true);
    expect(typeof centralityStructured?.statistics?.max).to.equal('number');

    const partitionCall = result.calls.find((entry) => entry.toolName === 'graph_partition');
    expect(partitionCall?.response.isError).to.equal(false);
    const partitionStructured = partitionCall?.response.structured as
      | { assignments?: unknown[]; objective?: string; partition_count?: number }
      | undefined;
    expect(Array.isArray(partitionStructured?.assignments)).to.equal(true);
    expect(partitionStructured?.objective).to.equal('community');

    const criticalCall = result.calls.find((entry) => entry.toolName === 'graph_critical_path');
    expect(criticalCall?.response.isError).to.equal(false);
    const criticalStructured = criticalCall?.response.structured as
      | { critical_path?: string[]; duration?: number; slack_by_node?: Record<string, number> }
      | undefined;
    expect(Array.isArray(criticalStructured?.critical_path)).to.equal(true);
    expect(typeof criticalStructured?.duration).to.equal('number');

    const simulateCall = result.calls.find((entry) => entry.toolName === 'graph_simulate');
    expect(simulateCall?.response.isError).to.equal(false);
    const simulateStructured = simulateCall?.response.structured as
      | { schedule?: unknown[]; metrics?: { makespan?: number; utilisation?: number } }
      | undefined;
    expect(Array.isArray(simulateStructured?.schedule)).to.equal(true);
    expect(typeof simulateStructured?.metrics?.makespan).to.equal('number');

    const optimizeValid = result.calls.find(
      (entry) => entry.toolName === 'graph_optimize' && entry.scenario === 'graph_optimize_cost_objective',
    );
    expect(optimizeValid?.response.isError).to.equal(false);
    const optimizeStructured = optimizeValid?.response.structured as
      | {
          objective?: { type?: string };
          suggestions?: unknown[];
          projections?: Array<{ parallelism?: number }>;
        }
      | undefined;
    expect(optimizeStructured?.objective?.type).to.equal('cost');
    expect(Array.isArray(optimizeStructured?.suggestions)).to.equal(true);
    expect(Array.isArray(optimizeStructured?.projections)).to.equal(true);

    const optimizeInvalid = result.calls.find(
      (entry) => entry.toolName === 'graph_optimize' && entry.scenario === 'graph_optimize_invalid_parallelism',
    );
    expect(optimizeInvalid?.response.isError).to.equal(true);
    expect(optimizeInvalid?.response.errorCode).to.equal('transport_failure');

    const mooCall = result.calls.find((entry) => entry.toolName === 'graph_optimize_moo');
    expect(mooCall?.response.isError).to.equal(false);
    const mooStructured = mooCall?.response.structured as
      | { candidates?: unknown[]; scalarization?: { method?: string; weights?: Record<string, number> } }
      | undefined;
    expect(Array.isArray(mooStructured?.candidates)).to.equal(true);
    expect(mooStructured?.scalarization?.method).to.equal('weighted_sum');

    const causalCall = result.calls.find((entry) => entry.toolName === 'graph_causal_analyze');
    expect(causalCall?.response.isError).to.equal(false);
    const causalStructured = causalCall?.response.structured as
      | { acyclic?: boolean; topological_order?: unknown[]; min_cut?: { size?: number } | null }
      | undefined;
    expect(typeof causalStructured?.acyclic).to.equal('boolean');
    expect(Array.isArray(causalStructured?.topological_order)).to.equal(true);

    const snapshotCopy = await readFile(
      path.join(context.directories.resources, 'stage02-graph-state.json'),
      'utf8',
    );
    const snapshotPayload = JSON.parse(snapshotCopy) as { nodes?: unknown[]; edges?: unknown[] };
    expect(Array.isArray(snapshotPayload.nodes)).to.equal(true);
    expect(Array.isArray(snapshotPayload.edges)).to.equal(true);

    const subgraphCall = result.calls.find(
      (entry) => entry.toolName === 'graph_subgraph_extract',
    );
    expect(subgraphCall?.response.isError).to.equal(false);
    const subgraphStructured = subgraphCall?.response.structured as { descriptor?: unknown } | undefined;
    expect(subgraphStructured?.descriptor).to.be.an('object');

    const subgraphCopy = await readFile(
      path.join(context.directories.resources, 'stage02-subgraph-descriptor.json'),
      'utf8',
    );
    const subgraphDescriptor = JSON.parse(subgraphCopy) as { subgraph_ref?: string; descriptor?: unknown };
    expect(subgraphDescriptor.subgraph_ref).to.equal('stage02-subflow');
    expect(subgraphDescriptor.descriptor).to.be.an('object');

    const hyperCall = result.calls.find((entry) => entry.toolName === 'graph_hyper_export');
    expect(hyperCall?.response.isError).to.equal(false);
    const hyperStructured = hyperCall?.response.structured as { graph?: unknown } | undefined;
    expect(hyperStructured?.graph).to.be.an('object');

    const rewriteCall = result.calls.find((entry) => entry.toolName === 'graph_rewrite_apply');
    expect(rewriteCall?.response.isError).to.equal(false);
    const rewriteStructured = rewriteCall?.response.structured as { history?: unknown[]; mode?: string } | undefined;
    expect(rewriteStructured?.mode).to.equal('manual');
    expect(Array.isArray(rewriteStructured?.history)).to.equal(true);

    const graphForgeCall = result.calls.find(
      (entry) => entry.toolName === 'graph_forge_analyze' && entry.scenario === 'graph_forge_analyze_pipeline',
    );
    expect(graphForgeCall?.response.isError).to.equal(false);
    const forgeParsed = graphForgeCall?.response.parsedText as
      | {
          graph?: { name?: string; nodes?: unknown[]; edges?: unknown[] };
          analyses_defined?: unknown[];
          analyses_resolved?: unknown[];
        }
      | undefined;
    expect(forgeParsed?.graph?.name).to.equal('Stage02Pipeline');
    expect(Array.isArray(forgeParsed?.analyses_defined)).to.equal(true);
    expect(Array.isArray(forgeParsed?.analyses_resolved)).to.equal(true);

    const statusListCall = result.calls.find(
      (entry) => entry.toolName === 'status' && entry.scenario === 'status_list_jobs',
    );
    expect(statusListCall?.response.isError).to.equal(false);
    const statusParsed = statusListCall?.response.parsedText as { jobs?: unknown[] } | undefined;
    expect(Array.isArray(statusParsed?.jobs)).to.equal(true);

    const statusMissingCall = result.calls.find(
      (entry) => entry.toolName === 'status' && entry.scenario === 'status_missing_job',
    );
    expect(statusMissingCall?.response.isError).to.equal(true);
    expect(statusMissingCall?.response.errorCode).to.equal('NOT_FOUND');

    const jobViewCall = result.calls.find(
      (entry) => entry.toolName === 'job_view' && entry.scenario === 'job_view_missing_job',
    );
    expect(jobViewCall?.response.isError).to.equal(true);
    expect(jobViewCall?.response.errorCode).to.equal('NOT_FOUND');

    const conversationCall = result.calls.find(
      (entry) => entry.toolName === 'conversation_view' && entry.scenario === 'conversation_view_missing_child',
    );
    expect(conversationCall?.response.isError).to.equal(true);
    expect(conversationCall?.response.errorCode).to.equal('NOT_FOUND');

    const startCall = result.calls.find(
      (entry) => entry.toolName === 'start' && entry.scenario === 'start_missing_job',
    );
    expect(startCall?.response.isError).to.equal(true);
    expect(startCall?.response.errorCode).to.equal('NOT_FOUND');

    const aggregateCall = result.calls.find(
      (entry) => entry.toolName === 'aggregate' && entry.scenario === 'aggregate_missing_job',
    );
    expect(aggregateCall?.response.isError).to.equal(true);
    expect(aggregateCall?.response.errorCode).to.equal('NOT_FOUND');

    const killCall = result.calls.find(
      (entry) => entry.toolName === 'kill' && entry.scenario === 'kill_missing_job',
    );
    expect(killCall?.response.isError).to.equal(true);
    expect(killCall?.response.errorCode).to.equal('NOT_FOUND');
  }).timeout(20_000);
});
