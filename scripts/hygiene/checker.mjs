#!/usr/bin/env node
/**
 * Core hygiene routines shared between the CLI wrapper and unit tests.
 * The helpers operate on TypeScript sources to ensure we reject unsafe
 * double assertions and stray TODO/FIXME markers outside of dedicated fixtures.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Regular expression rejecting the TypeScript double assertion motif (unknown→T). */
export const doubleCastPattern = /\bas\s+unknown\s+as\b/;
/** Regular expression guarding against TODO/FIXME markers in source files. */
export const todoPattern = /\b(?:TODO|FIXME)\b/;
/** Marker that grants documentation exceptions when embedded in a comment. */
export const defaultDocsMarker = 'allowed:docs';
/** Default allowlist for files permitted to carry TODO/FIXME markers. */
export const defaultTodoAllowlist = Object.freeze([]);
/** Test fixture detection relies on a platform agnostic path regular expression. */
const testFixturePattern = /(?:^|[\\/])__tests__(?:[\\/]|$)/;

/** Describes why a TODO allowlist entry cannot be accepted. */
export const allowlistNormalizationFailures = Object.freeze({
  EMPTY: 'empty',
  ABSOLUTE: 'absolute',
  ESCAPES: 'escapes',
});

/**
 * Canonicalise relative repository paths so allowlist entries match regardless of OS separators.
 * @param {string} relativePath - Path expressed relative to the workspace root.
 * @returns {string}
 */
export function normalizeRelativePath(relativePath) {
  const replacedSeparators = relativePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(replacedSeparators);
  if (normalized === '.' || normalized === '/') {
    return '';
  }
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

/**
 * Normalise a TODO allowlist entry while guaranteeing it remains inside the repository tree.
 * @param {string} entry - Raw allowlist entry sourced from configuration or tests.
 * @returns {{ ok: true; value: string } | { ok: false; reason: 'empty' | 'absolute' | 'escapes' }}
 */
export function normalizeAllowlistEntry(entry) {
  if (typeof entry !== 'string') {
    return { ok: false, reason: allowlistNormalizationFailures.EMPTY };
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: allowlistNormalizationFailures.EMPTY };
  }
  const replacedSeparators = trimmed.replace(/\\/g, '/');
  if (path.posix.isAbsolute(replacedSeparators)) {
    return { ok: false, reason: allowlistNormalizationFailures.ABSOLUTE };
  }
  const normalized = path.posix.normalize(replacedSeparators);
  if (
    normalized === '.' ||
    normalized === '/' ||
    normalized.startsWith('../') ||
    normalized === ''
  ) {
    return { ok: false, reason: allowlistNormalizationFailures.ESCAPES };
  }
  const withoutDotPrefix = normalized.startsWith('./') ? normalized.slice(2) : normalized;
  if (withoutDotPrefix.length === 0) {
    return { ok: false, reason: allowlistNormalizationFailures.EMPTY };
  }
  return { ok: true, value: withoutDotPrefix };
}

/**
 * Convert an iterable collection of allowlist entries into a Set of normalized paths.
 * @param {Iterable<string> | undefined | null} entries - Strings describing allowlisted files.
 * @returns {Set<string>}
 */
export function createTodoAllowlistSet(entries) {
  const normalized = new Set();
  if (entries == null) {
    return normalized;
  }
  for (const entry of entries) {
    const result = normalizeAllowlistEntry(entry);
    if (!result.ok) {
      continue;
    }
    normalized.add(result.value);
  }
  return normalized;
}

/**
 * Determine whether a relative path targets a test fixture directory.
 * @param {string} relativePath - File path relative to the repository root.
 * @returns {boolean}
 */
export function isTestFixture(relativePath) {
  return testFixturePattern.test(relativePath);
}

/**
 * Inspect the textual content of a file and record hygiene violations.
 * @param {string} relativePath - File path relative to the workspace root.
 * @param {string} content - Raw file content.
 * @param {{ allowDocsTag?: string; todoAllowlist?: readonly string[]; todoAllowlistSet?: ReadonlySet<string> }} [options] -
 *   Optional configuration overriding the documentation marker and the allowlist of files
 *   permitted to contain TODO/FIXME markers. Callers can also pass a precomputed Set when
 *   they need to reuse the same allowlist across multiple files without recreating it.
 * @returns {string[]} - List of violation descriptions for the provided file.
 */
export function inspectContent(relativePath, content, options = {}) {
  const allowDocsTag = options.allowDocsTag ?? defaultDocsMarker;
  const todoAllowlistSet =
    options.todoAllowlistSet ?? createTodoAllowlistSet(options.todoAllowlist ?? defaultTodoAllowlist);
  const lines = content.split(/\r?\n/);
  const violations = [];
  const insideTestFixture = isTestFixture(relativePath);
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const hasDocumentationMarker = allowDocsTag.length > 0 && line.includes(allowDocsTag);
    if (doubleCastPattern.test(line) && !hasDocumentationMarker) {
      violations.push(`${relativePath}:${lineNumber} => forbidden double assertion motif detected.`);
    }
    // Comment markers remain permitted inside dedicated fixtures or when the file is explicitly allowlisted.
    const todoAllowed = insideTestFixture || todoAllowlistSet.has(normalizedRelativePath);
    if (!todoAllowed && todoPattern.test(line) && !hasDocumentationMarker) {
      violations.push(`${relativePath}:${lineNumber} => TODO/FIXME markers are restricted to tests.`);
    }
  }
  return violations;
}

/**
 * Read a file from disk and run the hygiene inspection on its content.
 * @param {string} workspaceRoot - Absolute path to the repository root.
 * @param {string} relativePath - Path to the file relative to the repository root.
 * @param {{ allowDocsTag?: string; todoAllowlist?: readonly string[]; todoAllowlistSet?: ReadonlySet<string> }} [options] - Optional
 *   configuration overriding the documentation marker and TODO/FIXME allowlist. A precomputed Set can be
 *   provided to avoid rebuilding the allowlist when scanning multiple files within the same run.
 * @returns {Promise<string[]>} - Promise resolving to the list of violation messages.
 */
export async function inspectFile(workspaceRoot, relativePath, options = {}) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  const content = await readFile(absolutePath, 'utf8');
  return inspectContent(relativePath, content, options);
}

/**
 * Recursively discover TypeScript files inside a directory relative to the workspace root.
 * @param {string} workspaceRoot - Absolute path to the repository root.
 * @param {string} directory - Directory to explore relative to the repository root.
 * @returns {Promise<string[]>} - Promise resolving to relative file paths.
 */
export async function collectSourceFiles(workspaceRoot, directory) {
  const absoluteDirectory = path.resolve(workspaceRoot, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      const childRelative = path.relative(workspaceRoot, entryPath);
      const childFiles = await collectSourceFiles(workspaceRoot, childRelative);
      files.push(...childFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.relative(workspaceRoot, entryPath));
    }
  }
  return files;
}

/**
 * Execute the hygiene sweep for a given workspace directory.
 * @param {{
 *   workspaceRoot: string,
 *   directory?: string,
 *   allowDocsTag?: string,
 *   todoAllowlist?: readonly string[],
 *   todoAllowlistSet?: ReadonlySet<string>,
 * }} options - Configuration describing the workspace root and optional directory.
 * @returns {Promise<{ sourceFiles: string[]; violations: string[] }>} - Promise with enumerated files and violations.
 */
export async function runHygieneCheck(options) {
  const {
    workspaceRoot,
    directory = 'src',
    allowDocsTag = defaultDocsMarker,
    todoAllowlist = defaultTodoAllowlist,
  } = options;
  const sourceFiles = await collectSourceFiles(workspaceRoot, directory);
  sourceFiles.sort((left, right) => left.localeCompare(right));
  const violations = [];
  const normalizedAllowlist =
    options.todoAllowlistSet ?? createTodoAllowlistSet(todoAllowlist);
  for (const relativePath of sourceFiles) {
    const fileViolations = await inspectFile(workspaceRoot, relativePath, {
      allowDocsTag,
      todoAllowlistSet: normalizedAllowlist,
    });
    violations.push(...fileViolations);
  }
  return { sourceFiles, violations };
}
