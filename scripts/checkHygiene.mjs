#!/usr/bin/env node
/**
 * CLI entry point orchestrating hygiene enforcement prior to heavier build stages.
 * Delegates the core logic to reusable helpers so unit tests can exercise the
 * validation matrix without shelling out to subprocesses.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runHygieneCheck } from './hygiene/checker.mjs';

/** Absolute path to the repository root resolved from the script location. */
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { violations } = await runHygieneCheck({ workspaceRoot, directory: 'src' });

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(`${violation}\n`);
  }
  process.stderr.write(`Hygiene check failed with ${violations.length} violation(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Hygiene check passed with no violations.\n');
}
