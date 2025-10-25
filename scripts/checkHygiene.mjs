#!/usr/bin/env node
/**
 * CLI entry point orchestrating hygiene enforcement prior to heavier build stages.
 * Delegates the core logic to reusable helpers so unit tests can exercise the
 * validation matrix without shelling out to subprocesses.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  allowlistNormalizationFailures,
  normalizeAllowlistEntry,
  runHygieneCheck,
} from './hygiene/checker.mjs';

/** Absolute path to the repository root resolved from the script location. */
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hygieneConfigPath = path.join(workspaceRoot, 'config', 'hygiene.config.json');
/** Files explicitly permitted to carry literal TODO/FIXME markers. */
let todoAllowlistSet = new Set();
try {
  const rawConfig = await readFile(hygieneConfigPath, 'utf8');
  const parsed = JSON.parse(rawConfig);
  if (Array.isArray(parsed.todoAllowlist)) {
    const validatedEntries = new Set();
    for (const entry of parsed.todoAllowlist) {
      const normalization = normalizeAllowlistEntry(entry);
      if (!normalization.ok) {
        switch (normalization.reason) {
          case allowlistNormalizationFailures.EMPTY: {
            process.stderr.write('Todo allowlist entries must point to a specific file.\n');
            break;
          }
          case allowlistNormalizationFailures.ABSOLUTE: {
            process.stderr.write('Allowlist entries must be relative to the repository root.\n');
            break;
          }
          case allowlistNormalizationFailures.ESCAPES: {
            process.stderr.write('Allowlist entry escapes the workspace boundaries.\n');
            break;
          }
          default: {
            process.stderr.write('Todo allowlist entry is invalid.\n');
          }
        }
        process.exit(1);
      }
      const normalizedEntry = normalization.value;
      const absolutePath = path.join(workspaceRoot, normalizedEntry);
      const relativeCheck = path.relative(workspaceRoot, absolutePath);
      if (relativeCheck.startsWith('..')) {
        process.stderr.write(`Allowlist entry escapes the workspace: ${entry}\n`);
        process.exit(1);
      }
      try {
        await access(absolutePath);
      } catch (accessError) {
        process.stderr.write(`Allowlist entry does not resolve to a file: ${normalizedEntry}\n`);
        const message = accessError instanceof Error ? accessError.message : String(accessError);
        process.stderr.write(`${message}\n`);
        process.exit(1);
      }
      validatedEntries.add(normalizedEntry);
    }
    todoAllowlistSet = validatedEntries;
  }
} catch (error) {
  // Surface configuration errors explicitly so maintainers spot malformed JSON quickly.
  const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (errorCode !== 'ENOENT') {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to parse ${hygieneConfigPath}: ${errorMessage}\n`);
    process.exit(1);
  }
}

const { violations } = await runHygieneCheck({
  workspaceRoot,
  directory: 'src',
  todoAllowlistSet,
});

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(`${violation}\n`);
  }
  process.stderr.write(`Hygiene check failed with ${violations.length} violation(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Hygiene check passed with no violations.\n');
}
