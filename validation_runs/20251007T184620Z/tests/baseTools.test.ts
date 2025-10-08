import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory, type RunContext } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { runBaseToolsStage } from '../lib/baseTools.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../src/server.js';
import type { FeatureToggles } from '../../../src/serverOptions.js';

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

    expect(result.calls.length).to.be.at.least(5);
    const toolNames = result.calls.map((entry) => entry.toolName);
    expect(toolNames).to.include.members([
      'graph_generate',
      'graph_validate',
      'graph_summarize',
      'graph_paths_k_shortest',
      'logs_tail',
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
  }).timeout(20_000);
});
