#!/usr/bin/env node
/**
 * Lightweight integration test launcher.
 * The script looks for TypeScript files under tests/int and invokes Mocha only when at least one exists.
 * This keeps npm scripts stable even before we introduce heavier integration scenarios.
 */
import { readdir, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureSourceMapNodeOptions, assertNodeVersion } from './lib/env-helpers.mjs';

const INTEGRATION_ROOT = resolve('tests', 'int');

/** Recursively find test files ending with .test.ts inside the integration directory. */
async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const discovered = [];

  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectTestFiles(entryPath);
      discovered.push(...nested);
      continue;
    }

    if (entry.isFile() && extname(entry.name) === '.ts' && entry.name.endsWith('.test.ts')) {
      discovered.push(entryPath);
    }
  }

  return discovered;
}

async function runMocha(files) {
  // Spawn mocha via the node executable to respect ESM loader semantics used in unit tests.
  const mochaBin = resolve('node_modules', 'mocha', 'bin', 'mocha.js');
  const loader = resolve('node_modules', 'ts-node', 'esm.mjs');
  const command = process.execPath;
  const args = [
    '--loader',
    loader,
    mochaBin,
    '--reporter',
    'tap',
    ...files
  ];

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: ensureSourceMapNodeOptions(process.env),
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Integration tests exited with status ${code}`));
      }
    });
    child.on('error', rejectPromise);
  });
}

async function main() {
  assertNodeVersion();
  const exists = await stat(INTEGRATION_ROOT).then(() => true).catch(() => false);
  if (!exists) {
    console.log('No integration tests directory detected; skipping.');
    return;
  }

  const files = await collectTestFiles(INTEGRATION_ROOT);
  if (files.length === 0) {
    console.log('No integration test files found; skipping.');
    return;
  }

  await runMocha(files);
}

main().catch((error) => {
  console.error('Integration test runner failed', error);
  process.exitCode = 1;
});
