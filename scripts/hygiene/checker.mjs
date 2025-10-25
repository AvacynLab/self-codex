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
/** Test fixture detection relies on a platform agnostic path regular expression. */
const testFixturePattern = /(?:^|[\\/])__tests__(?:[\\/]|$)/;

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
 * @param {{ allowDocsTag?: string }} [options] - Optional configuration overriding the documentation marker.
 * @returns {string[]} - List of violation descriptions for the provided file.
 */
export function inspectContent(relativePath, content, options = {}) {
  const allowDocsTag = options.allowDocsTag ?? defaultDocsMarker;
  const lines = content.split(/\r?\n/);
  const violations = [];
  const insideTestFixture = isTestFixture(relativePath);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const hasDocumentationMarker = allowDocsTag.length > 0 && line.includes(allowDocsTag);
    if (doubleCastPattern.test(line) && !hasDocumentationMarker) {
      violations.push(`${relativePath}:${lineNumber} => forbidden double assertion motif detected.`);
    }
    if (!insideTestFixture && todoPattern.test(line) && !hasDocumentationMarker) {
      violations.push(`${relativePath}:${lineNumber} => TODO/FIXME markers are restricted to tests.`);
    }
  }
  return violations;
}

/**
 * Read a file from disk and run the hygiene inspection on its content.
 * @param {string} workspaceRoot - Absolute path to the repository root.
 * @param {string} relativePath - Path to the file relative to the repository root.
 * @param {{ allowDocsTag?: string }} [options] - Optional configuration overriding the documentation marker.
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
 * }} options - Configuration describing the workspace root and optional directory.
 * @returns {Promise<{ sourceFiles: string[]; violations: string[] }>} - Promise with enumerated files and violations.
 */
export async function runHygieneCheck(options) {
  const { workspaceRoot, directory = 'src', allowDocsTag = defaultDocsMarker } = options;
  const sourceFiles = await collectSourceFiles(workspaceRoot, directory);
  const violations = [];
  for (const relativePath of sourceFiles) {
    const fileViolations = await inspectFile(workspaceRoot, relativePath, { allowDocsTag });
    violations.push(...fileViolations);
  }
  return { sourceFiles, violations };
}
