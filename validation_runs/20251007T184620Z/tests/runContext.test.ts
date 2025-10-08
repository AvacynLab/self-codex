import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';

import {
  createRunContext,
  createTraceIdFactory,
  ensureRunDirectories,
} from '../lib/runContext.js';

/**
 * The tests focus on the deterministic behaviour of the filesystem helpers and
 * the trace identifier factory used by the validation harness.
 */
describe('runContext utilities', () => {
  it('creates the expected directory structure when missing', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'run-context-'));
    const directories = await ensureRunDirectories(scratchRoot);

    for (const [label, dirPath] of Object.entries(directories)) {
      const stats = await stat(dirPath);
      expect(stats.isDirectory(), `${label} should be a directory`).to.equal(true);
    }

    await rm(scratchRoot, { recursive: true, force: true });
  });

  it('produces deterministic trace identifiers when the seed is reused', () => {
    const factoryA = createTraceIdFactory('seed');
    const factoryB = createTraceIdFactory('seed');

    const tracesA = Array.from({ length: 3 }, () => factoryA());
    const tracesB = Array.from({ length: 3 }, () => factoryB());

    expect(tracesA).to.deep.equal(tracesB);
    expect(new Set(tracesA).size).to.equal(tracesA.length);
  });

  it('initialises the run context relative to the workspace root', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'workspace-'));
    const runId = 'TEST-RUN';
    const context = await createRunContext({ runId, workspaceRoot, traceSeed: 'trace-seed' });

    expect(context.runId).to.equal(runId);
    expect(context.rootDir).to.equal(path.join(workspaceRoot, 'validation_runs', runId));

    const trace = context.createTraceId();
    expect(trace).to.match(/^trace-[0-9a-f]{32}$/);

    for (const dirPath of Object.values(context.directories)) {
      const stats = await stat(dirPath);
      expect(stats.isDirectory()).to.equal(true);
    }

    await rm(workspaceRoot, { recursive: true, force: true });
  });
});
