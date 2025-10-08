import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureRunDirectories, createTraceIdFactory } from '../lib/runContext.js';
import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { McpSession } from '../lib/mcpSession.js';
import { runIntrospectionStage } from '../lib/introspection.js';
import type { RunContext } from '../lib/runContext.js';

import { getRuntimeFeatures, configureRuntimeFeatures, server } from '../../../src/server.js';
import type { FeatureToggles } from '../../../src/serverOptions.js';

/**
 * Utility creating a deterministic clock used by the recorder to ensure tests
 * can assert exact artefact names. Each invocation advances the timestamp by a
 * single second which keeps JSON snapshots unique without introducing drift.
 */
function buildDeterministicClock(startIso = '2025-01-01T00:00:00.000Z'): () => Date {
  const start = new Date(startIso).getTime();
  let tick = 0;
  return () => new Date(start + tick++ * 1000);
}

describe('MCP introspection harness', () => {
  let context: RunContext;
  let recorder: ArtifactRecorder;
  let tempRoot: string;
  let baselineFeatures: FeatureToggles;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mcp-introspection-'));
    const directories = await ensureRunDirectories(tempRoot);
    context = {
      runId: 'test-introspection',
      rootDir: tempRoot,
      directories,
      createTraceId: createTraceIdFactory('introspection-test'),
    };
    recorder = new ArtifactRecorder(context, { clock: buildDeterministicClock() });
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    await configureRuntimeFeatures(baselineFeatures);
    await server.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('records tool invocations and restores feature toggles', async () => {
    const session = new McpSession({
      context,
      recorder,
      featureOverrides: { enableMcpIntrospection: true },
      clientName: 'introspection-test-client',
    });

    await session.open();
    const call = await session.callTool('mcp_info', {});
    await session.close();

    const restored = getRuntimeFeatures();
    expect(restored).to.deep.equal(baselineFeatures);

    const outputSnapshot = JSON.parse(await readFile(call.artefacts.outputPath, 'utf8')) as Record<string, unknown>;
    expect(outputSnapshot).to.have.property('traceId', call.traceId);

    const logContents = await readFile(path.join(context.directories.logs, 'run.log'), 'utf8');
    expect(logContents).to.contain('"tool":"mcp_info"');
    expect(logContents).to.contain('"message":"tool_call_completed"');
  }).timeout(10_000);

  it('runs the introspection stage and generates summary artefacts', async () => {
    const summary = await runIntrospectionStage({ context, recorder });

    expect(summary.info.server.name).to.equal('mcp-self-fork-orchestrator');
    expect(summary.capabilities.namespaces).to.be.an('array');
    expect(summary.reportPath).to.satisfy((p: string) => p.endsWith('step01-introspection.json'));

    const report = JSON.parse(await readFile(summary.reportPath, 'utf8')) as Record<string, unknown>;
    expect(report).to.have.property('events');

    const resourceIndex = JSON.parse(await readFile(summary.resourceIndexPath, 'utf8')) as {
      all: unknown[];
      byPrefix: Array<{ prefix: string; traceId: string }>;
    };
    expect(resourceIndex.byPrefix.every((entry) => typeof entry.traceId === 'string')).to.equal(true);

    const eventFiles = await readdir(context.directories.events);
    expect(eventFiles.length).to.be.greaterThan(0);

    const followUpSeqs = summary.eventProbe.followUp.events.map((evt) => evt.seq);
    expect(followUpSeqs).to.include(summary.eventProbe.published.seq);

    const logContents = await readFile(path.join(context.directories.logs, 'run.log'), 'utf8');
    expect(logContents).to.contain('introspection_stage_completed');

    const restored = getRuntimeFeatures();
    expect(restored).to.deep.equal(baselineFeatures);
  }).timeout(20_000);
});

