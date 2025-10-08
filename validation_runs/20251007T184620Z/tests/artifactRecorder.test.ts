import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';

import { ArtifactRecorder } from '../lib/artifactRecorder.js';
import { createRunContext, createTraceIdFactory } from '../lib/runContext.js';

/**
 * Helper returning a deterministic Date instance suitable for predictable
 * artefact names in the tests.
 */
function fixedDate(): Date {
  return new Date('2025-01-02T03:04:05.678Z');
}

describe('ArtifactRecorder', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'artifact-recorder-'));
    await mkdir(path.join(workspaceRoot, 'validation_runs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('records tool inputs using deterministic trace identifiers', async () => {
    const runId = 'RUN';
    const context = await createRunContext({ runId, workspaceRoot, traceSeed: 'seed' });
    const recorder = new ArtifactRecorder(context, { clock: fixedDate });

    const result = await recorder.recordToolInput({ toolName: 'mcp_info', payload: { foo: 'bar' } });
    const expectedTrace = createTraceIdFactory('seed')();

    expect(result.traceId).to.equal(expectedTrace);

    const stats = await stat(result.inputPath);
    expect(stats.isFile()).to.equal(true);

    const contents = JSON.parse(await readFile(result.inputPath, 'utf8'));
    expect(contents).to.deep.equal({
      traceId: result.traceId,
      toolName: 'mcp_info',
      recordedAt: '2025-01-02T03:04:05.678Z',
      payload: { foo: 'bar' },
    });
  });

  it('records tool outputs paired with the corresponding input file name', async () => {
    const runId = 'RUN';
    const context = await createRunContext({ runId, workspaceRoot, traceSeed: 'seed' });
    const recorder = new ArtifactRecorder(context, { clock: fixedDate });

    const { traceId, inputPath } = await recorder.recordToolInput({ toolName: 'mcp_info', payload: { foo: 'bar' } });
    const artefacts = await recorder.recordToolOutput({ traceId, toolName: 'mcp_info', payload: { ok: true } });

    expect(artefacts.inputPath).to.equal(inputPath);

    const outputContents = JSON.parse(await readFile(artefacts.outputPath, 'utf8'));
    expect(outputContents).to.deep.equal({
      traceId,
      toolName: 'mcp_info',
      recordedAt: '2025-01-02T03:04:05.678Z',
      payload: { ok: true },
    });
  });

  it('appends events and log entries as JSON lines', async () => {
    const runId = 'RUN';
    const context = await createRunContext({ runId, workspaceRoot, traceSeed: 'seed' });
    const recorder = new ArtifactRecorder(context, { clock: fixedDate });

    const { traceId } = await recorder.recordToolInput({ toolName: 'mcp_capabilities', payload: {} });
    const eventPath = await recorder.appendEvent({ traceId, event: { type: 'progress', value: 42 } });
    await recorder.appendEvent({ traceId, event: { type: 'progress', value: 84 } });

    const eventLines = (await readFile(eventPath, 'utf8')).trim().split('\n');
    expect(eventLines).to.have.length(2);
    expect(eventLines[0]).to.equal(
      JSON.stringify({ traceId, observedAt: '2025-01-02T03:04:05.678Z', event: { type: 'progress', value: 42 } }),
    );

    const logPath = await recorder.appendLogEntry({
      level: 'info',
      message: 'Tool invocation completed',
      traceId,
      details: { durationMs: 1200 },
    });

    const logLines = (await readFile(logPath, 'utf8')).trim().split('\n');
    expect(logLines[0]).to.equal(
      JSON.stringify({
        timestamp: '2025-01-02T03:04:05.678Z',
        level: 'info',
        message: 'Tool invocation completed',
        traceId,
        details: { durationMs: 1200 },
      }),
    );
  });
});

