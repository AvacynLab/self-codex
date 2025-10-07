import { mkdir } from 'node:fs/promises';
import path from 'node:path';
/** Absolute path (resolved against the current working directory) hosting run artefacts. */
function getRunsRoot() {
    const override = process.env.MCP_RUNS_ROOT;
    const resolvedBase = override
        ? path.resolve(process.cwd(), override)
        : path.resolve(process.cwd(), 'runs');
    return resolvedBase;
}
/** Absolute path hosting child workspaces (logs, manifests, artefacts). */
function getChildrenRoot() {
    const override = process.env.MCP_CHILDREN_ROOT;
    const resolvedBase = override
        ? path.resolve(process.cwd(), override)
        : path.resolve(process.cwd(), 'children');
    return resolvedBase;
}
/**
 * Utilities dedicated to safe path management for child workspaces.
 *
 * The orchestrator runs untrusted child processes. We therefore restrict any
 * filesystem operation performed on behalf of a child to the directory that was
 * provisioned for it. The helpers below normalise the requested location,
 * guarantee it cannot escape the sandbox, and create the needed folders.
 */
export class PathResolutionError extends Error {
    attemptedPath;
    rootDirectory;
    constructor(message, attemptedPath, rootDirectory) {
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
export function resolveWithin(rootDir, ...segments) {
    const absoluteRoot = path.resolve(rootDir);
    const targetPath = path.resolve(absoluteRoot, ...segments);
    const relative = path.relative(absoluteRoot, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new PathResolutionError(`Resolved path escapes the child workspace: ${relative}`, targetPath, absoluteRoot);
    }
    return targetPath;
}
/**
 * Ensures that the directory containing the provided file path exists.
 *
 * @param filePath - File path resolved with {@link resolveWithin}.
 */
export async function ensureParentDirectory(filePath) {
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
export async function ensureDirectory(rootDir, ...segments) {
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
export function childWorkspacePath(childrenRoot, childId, ...segments) {
    return resolveWithin(childrenRoot, childId, ...segments);
}
/**
 * Sanitises a filename so it can safely be persisted on disk.
 *
 * The orchestrator accepts identifiers coming from external systems. This helper
 * strips path separators, control characters and whitespace while preserving a
 * deterministic trace for logs/debugging. When the resulting string would be
 * empty we fall back to a neutral placeholder.
 */
export function sanitizeFilename(name) {
    const trimmed = name.trim();
    if (!trimmed) {
        return 'unnamed';
    }
    const sanitized = trimmed
        .replace(/[\0-\x1F\x7F]/g, '')
        .replace(/[\\/]/g, '_')
        .replace(/[:*?"<>|]/g, '_')
        .replace(/\s+/g, '_');
    const normalized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');
    return normalized.length > 0 ? normalized : 'unnamed';
}
/**
 * Safely joins a base directory with optional segments while forbidding
 * directory traversal. All segments are sanitised before resolution which keeps
 * the resulting path deterministic and inside the sandbox.
 */
export function safeJoin(base, ...parts) {
    const segments = [];
    for (const rawPart of parts) {
        const splitParts = rawPart.split(/[\\/]+/);
        for (const candidate of splitParts) {
            if (!candidate || candidate === '.') {
                continue;
            }
            if (candidate === '..') {
                throw new PathResolutionError('Directory traversal is not permitted', rawPart, path.resolve(base));
            }
            segments.push(sanitizeFilename(candidate));
        }
    }
    return resolveWithin(base, ...segments);
}
/**
 * Returns the canonical directory dedicated to the provided run identifier. The
 * directory is resolved inside `MCP_RUNS_ROOT` (or `./runs` by default) to keep
 * artefacts grouped per execution.
 */
export function resolveRunDir(runId) {
    return safeJoin(getRunsRoot(), sanitizeFilename(runId));
}
/**
 * Returns the canonical directory used for a given child runtime. The location
 * honours `MCP_CHILDREN_ROOT` when provided so operators can isolate workspaces
 * on fast storage.
 */
export function resolveChildDir(childId) {
    return safeJoin(getChildrenRoot(), sanitizeFilename(childId));
}
