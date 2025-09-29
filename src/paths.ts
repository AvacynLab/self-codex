import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Utilities dedicated to safe path management for child workspaces.
 *
 * The orchestrator runs untrusted child processes. We therefore restrict any
 * filesystem operation performed on behalf of a child to the directory that was
 * provisioned for it. The helpers below normalise the requested location,
 * guarantee it cannot escape the sandbox, and create the needed folders.
 */
export class PathResolutionError extends Error {
  public readonly attemptedPath: string;
  public readonly rootDirectory: string;

  constructor(message: string, attemptedPath: string, rootDirectory: string) {
    super(message);
    this.name = 'PathResolutionError';
    this.attemptedPath = attemptedPath;
    this.rootDirectory = rootDirectory;
  }
}

/**
 * Normalises a target path and ensures it stays within the provided root.
 *
 * @param rootDir - Root directory of the child workspace.
 * @param segments - Additional path segments to resolve.
 * @returns The absolute path within the root directory.
 * @throws {PathResolutionError} When the resulting path escapes the sandbox.
 */
export function resolveWithin(rootDir: string, ...segments: string[]): string {
  const absoluteRoot = path.resolve(rootDir);
  const targetPath = path.resolve(absoluteRoot, ...segments);
  const relative = path.relative(absoluteRoot, targetPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathResolutionError(
      `Resolved path escapes the child workspace: ${relative}`,
      targetPath,
      absoluteRoot,
    );
  }

  return targetPath;
}

/**
 * Ensures that the directory containing the provided file path exists.
 *
 * @param filePath - File path resolved with {@link resolveWithin}.
 */
export async function ensureParentDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
}

/**
 * Ensures that a directory exists within the child workspace.
 *
 * @param rootDir - Root directory of the child workspace.
 * @param segments - Optional nested directory segments to create.
 * @returns Absolute path to the ensured directory.
 */
export async function ensureDirectory(
  rootDir: string,
  ...segments: string[]
): Promise<string> {
  const target = resolveWithin(rootDir, ...segments);
  await mkdir(target, { recursive: true });
  return target;
}

/**
 * Convenience helper used by tests and higher level modules to obtain the
 * canonical path to a child specific folder (logs, inbox, outbox, …).
 *
 * @param childrenRoot - Root directory that contains all children workspaces.
 * @param childId - Identifier of the child instance.
 * @param segments - Optional nested segments inside the child workspace.
 */
export function childWorkspacePath(
  childrenRoot: string,
  childId: string,
  ...segments: string[]
): string {
  return resolveWithin(childrenRoot, childId, ...segments);
}
