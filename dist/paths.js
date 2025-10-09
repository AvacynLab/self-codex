import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
/** Maximum number of characters preserved in a sanitised filename. */
const MAX_FILENAME_LENGTH = 120;
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
    /** Stable error code surfaced to MCP clients when a path escapes its sandbox. */
    code = 'E-PATHS-ESCAPE';
    /**
     * Hint guiding callers towards remediation. The message is intentionally
     * action-oriented so tool wrappers can surface it directly in diagnostics.
     */
    hint = 'keep paths within the configured base directory';
    /** Absolute path that the caller attempted to access. */
    attemptedPath;
    /** Base directory configured for the operation. */
    rootDirectory;
    /** Structured metadata exposed to loggers and MCP clients. */
    details;
    constructor(message, attemptedPath, rootDirectory, extras = {}) {
        super(message);
        this.name = 'PathResolutionError';
        this.attemptedPath = attemptedPath;
        this.rootDirectory = rootDirectory;
        this.details = { attemptedPath, rootDirectory, ...extras };
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
        throw new PathResolutionError('path escapes base directory', targetPath, absoluteRoot, { relative });
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
    const normalizedInput = trimmed.normalize('NFC');
    const removedControlCharacters = normalizedInput.replace(/[\0-\x1F\x7F]/g, '');
    const withoutTraversal = removedControlCharacters.replace(/\.\./g, '');
    const basicSanitised = withoutTraversal
        .replace(/[\\/]/g, '_')
        .replace(/[:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/[^\p{L}\p{N}._-]+/gu, '_');
    const collapsedUnderscores = basicSanitised.replace(/_+/g, '_');
    const trimmedUnderscores = collapsedUnderscores.replace(/^_+|_+$/g, '');
    const limited = trimmedUnderscores.length > MAX_FILENAME_LENGTH
        ? trimmedUnderscores.slice(0, MAX_FILENAME_LENGTH)
        : trimmedUnderscores;
    return limited.length > 0 ? limited : 'unnamed';
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
                throw new PathResolutionError('path escapes base directory', path.resolve(base, rawPart), path.resolve(base), {
                    segment: candidate,
                });
            }
            segments.push(sanitizeFilename(candidate));
        }
    }
    return resolveWithin(base, ...segments);
}
export function resolveWorkspacePath(requestedPath, options = {}) {
    const baseDir = options.baseDir ? path.resolve(options.baseDir) : process.cwd();
    const trimmed = requestedPath.trim();
    if (!trimmed) {
        throw new PathResolutionError('path must not be empty', baseDir, baseDir);
    }
    return safeJoin(baseDir, trimmed);
}
/**
 * Returns the canonical directory dedicated to the provided run identifier. The
 * directory is resolved inside `MCP_RUNS_ROOT` (or `./runs` by default) to keep
 * artefacts grouped per execution.
 */
export function resolveRunDir(runId) {
    const resolved = safeJoin(getRunsRoot(), sanitizeFilename(runId));
    mkdirSync(resolved, { recursive: true });
    return resolved;
}
/**
 * Returns the canonical directory used for a given child runtime. The location
 * honours `MCP_CHILDREN_ROOT` when provided so operators can isolate workspaces
 * on fast storage.
 */
export function resolveChildDir(childId) {
    const resolved = safeJoin(getChildrenRoot(), sanitizeFilename(childId));
    mkdirSync(resolved, { recursive: true });
    return resolved;
}
//# sourceMappingURL=paths.js.map