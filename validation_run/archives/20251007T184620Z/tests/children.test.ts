import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runChildOrchestrationStage } from '../lib/children.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../../src/server.js';
import type { FeatureToggles } from '../../../../src/serverOptions.js';
import { resolveFixture, runnerArgs } from '../../../tests/helpers/childRunner.js';

/**
 * Deterministic clock helper ensuring artefact timestamps remain stable across
 * repeated executions. Each invocation advances the virtual clock by one
 * second so JSON snapshots keep unique yet predictable timestamps.
 */
function buildDeterministicClock(startIso = '2025-04-01T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

describe('Stage 4 – Child orchestration and cancellation checks', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  const mockRunnerPath = resolveFixture(import.meta.url, '../../../tests/fixtures/mock-runner.ts');
  const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-children-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-children-stage',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('children-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('spawns children, exchanges messages and cancels an active plan', async () => {
    const result = await runChildOrchestrationStage({
      context,
      recorder,
      childRunner: { command: process.execPath, args: mockRunnerArgs('--role', 'fixture') },
    });

    expect(result.children).to.have.lengthOf(3);
    expect(result.calls.map((entry) => `${entry.toolName}:${entry.scenario ?? 'default'}`)).to.include.members([
      'child_spawn_codex:primary_spawn',
      'child_status:primary_status',
      'child_attach:primary_attach',
      'child_set_limits:primary_limits',
      'child_send:primary_prompt',
      'child_spawn_codex:secondary_spawn',
      'child_status:secondary_status',
      'child_set_limits:secondary_limits',
      'child_send:secondary_ping',
      'child_set_role:secondary_role',
      'child_prompt:secondary_prompt',
      'child_push_partial:secondary_prompt_partial',
      'child_push_reply:secondary_prompt_final',
      'child_chat:primary_chat',
      'child_push_reply:primary_chat_final',
      'child_info:primary_info',
      'child_transcript:primary_transcript',
      'child_collect:primary_collect',
      'child_stream:primary_stream',
      'child_batch_create:batch_spawn',
      'child_create:tertiary_create',
      'child_rename:tertiary_rename',
      'child_reset:tertiary_reset',
      'child_kill:tertiary_force_stop',
      'child_gc:tertiary_cleanup',
      'plan_run_bt:plan_run_bt_sequence',
      'op_cancel:plan_cancellation',
      'child_cancel:primary_shutdown',
      'child_cancel:secondary_shutdown',
    ]);

    const primary = result.children[0]!;
    expect(primary.role).to.equal('planner');
    expect(primary.interaction?.responseType).to.be.oneOf(['response', 'echo']);
    expect(primary.shutdown?.forced).to.equal(false);
    expect(primary.traces.info).to.be.a('string');
    expect(primary.traces.transcript).to.be.a('string');
    expect(primary.traces.collect).to.be.a('string');
    expect(primary.traces.stream).to.be.a('string');
    expect(primary.traces.chat).to.be.a('string');
    expect(primary.traces.chatFinal).to.be.a('string');

    const secondary = result.children[1]!;
    expect(secondary.role).to.equal('auditeur');
    expect(secondary.interaction?.requestType).to.equal('ping');
    expect(secondary.traces.role).to.be.a('string');
    expect(secondary.traces.prompt).to.be.a('string');
    expect(secondary.traces.promptFinal).to.be.a('string');

    const tertiary = result.children[2]!;
    expect(tertiary.traces.kill).to.be.a('string');
    expect(tertiary.traces.gc).to.be.a('string');
    expect(tertiary.shutdown).to.not.equal(null);

    expect(result.cancellation.opId).to.contain(primary.childId);
    expect(result.cancellation.cancelTraceId).to.be.a('string');
    expect(result.cancellation.outcome).to.be.oneOf(['requested', 'already_cancelled']);

    const promptCall = result.calls.find((entry) => entry.toolName === 'child_prompt');
    expect(promptCall?.response.isError).to.equal(false);
    const promptResponse = promptCall?.response.structured as { pending_id?: string } | undefined;
    const promptParsed = promptCall?.response.parsedText as { pending_id?: string } | undefined;
    expect(typeof (promptResponse?.pending_id ?? promptParsed?.pending_id)).to.equal('string');

    const batchCall = result.calls.find((entry) => entry.toolName === 'child_batch_create');
    const batchStructured = batchCall?.response.structured as { children?: unknown[] } | undefined;
    expect(Array.isArray(batchStructured?.children)).to.equal(true);
    expect((batchStructured?.children ?? []).length).to.equal(2);

    const collectCall = result.calls.find((entry) => entry.toolName === 'child_collect');
    const collectStructured = collectCall?.response.structured as { outputs?: { messages?: unknown[] } } | undefined;
    expect(collectStructured?.outputs).to.be.an('object');

    const streamCall = result.calls.find((entry) => entry.toolName === 'child_stream');
    const streamStructured = streamCall?.response.structured as { slice?: { messages?: unknown[]; matchedMessages?: number } } | undefined;
    expect(streamStructured?.slice).to.be.an('object');
    expect(streamStructured?.slice?.matchedMessages).to.be.a('number');

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as {
      metrics: { totalCalls: number; errorCount: number; spawnedChildren: number };
      cancellation: { planTraceId: string | null; outcome: string | null };
    };

    expect(report.metrics.totalCalls).to.equal(result.calls.length);
    expect(report.metrics.spawnedChildren).to.equal(3);
    expect(report.cancellation.planTraceId).to.be.a('string');
    expect(report.cancellation.outcome).to.be.oneOf(['requested', 'already_cancelled']);
  }).timeout(20_000);
});

