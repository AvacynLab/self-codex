import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { childWorkspacePath, ensureDirectory, ensureParentDirectory, resolveWithin, } from './paths.js';
const OUTBOX_DIRNAME = 'outbox';
const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_VERSION = 1;
/**
 * Computes the digest of the provided file using a streaming approach.
 *
 * The helper is exported so other subsystems (tests, collectors, …) can reuse
 * the exact same hashing semantics when verifying artifacts.
 */
export async function hashFile(filePath, algorithm = 'sha256') {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve());
    });
    return hash.digest('hex');
}
function outboxPath(childrenRoot, childId, relativePath) {
    const base = childWorkspacePath(childrenRoot, childId, OUTBOX_DIRNAME);
    if (!relativePath) {
        return base;
    }
    return resolveWithin(base, relativePath);
}
async function loadManifest(outboxDir) {
    const manifestPath = path.join(outboxDir, MANIFEST_FILENAME);
    try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
            return new Map();
        }
        const map = new Map();
        for (const entry of parsed.entries) {
            if (!entry ||
                typeof entry.path !== 'string' ||
                typeof entry.size !== 'number' ||
                typeof entry.mimeType !== 'string' ||
                typeof entry.sha256 !== 'string') {
                continue;
            }
            map.set(entry.path, { ...entry });
        }
        return map;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return new Map();
        }
        throw error;
    }
}
async function persistManifest(outboxDir, entries) {
    const manifestPath = path.join(outboxDir, MANIFEST_FILENAME);
    const serialised = {
        version: MANIFEST_VERSION,
        entries: Array.from(entries).sort((a, b) => a.path.localeCompare(b.path)),
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(serialised, null, 2)}\n`);
}
/**
 * Persists an artifact within the child outbox and returns its manifest entry.
 */
export async function writeArtifact(options) {
    const outboxDir = await ensureDirectory(options.childrenRoot, options.childId, OUTBOX_DIRNAME);
    const absolutePath = resolveWithin(outboxDir, options.relativePath);
    await ensureParentDirectory(absolutePath);
    const buffer = typeof options.data === 'string'
        ? Buffer.from(options.data, options.encoding ?? 'utf8')
        : options.data;
    await fs.writeFile(absolutePath, buffer);
    const stats = await fs.stat(absolutePath);
    const entry = {
        path: path.relative(outboxDir, absolutePath),
        size: stats.size,
        mimeType: options.mimeType,
        sha256: await hashFile(absolutePath),
    };
    const manifest = await loadManifest(outboxDir);
    manifest.set(entry.path, entry);
    await persistManifest(outboxDir, manifest.values());
    return entry;
}
/**
 * Reads an artifact back from disk.
 */
export async function readArtifact(options) {
    const absolutePath = outboxPath(options.childrenRoot, options.childId, options.relativePath);
    return fs.readFile(absolutePath, options.encoding);
}
/**
 * Lists all artifacts present in the child outbox directory while refreshing
 * the manifest metadata (size, hash, mime type).
 */
export async function scanArtifacts(childrenRoot, childId) {
    const outboxDir = await ensureDirectory(childrenRoot, childId, OUTBOX_DIRNAME);
    const manifest = await loadManifest(outboxDir);
    const refreshed = new Map();
    async function traverse(directory, prefix) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
            if (entry.isDirectory()) {
                await traverse(entryPath, relativePath);
                continue;
            }
            if (!entry.isFile() || entry.name === MANIFEST_FILENAME) {
                continue;
            }
            const stats = await fs.stat(entryPath);
            const previous = manifest.get(relativePath);
            const mimeType = previous?.mimeType ?? 'application/octet-stream';
            const sha256 = await hashFile(entryPath);
            const descriptor = {
                path: relativePath,
                size: stats.size,
                mimeType,
                sha256,
            };
            refreshed.set(relativePath, descriptor);
        }
    }
    await traverse(outboxDir, '');
    await persistManifest(outboxDir, refreshed.values());
    return Array.from(refreshed.values()).sort((a, b) => a.path.localeCompare(b.path));
}
/**
 * Backwards compatibility alias preserved for existing imports. Upcoming
 * refactors should migrate callers to {@link scanArtifacts} which more
 * accurately communicates the side effects on the manifest.
 */
export async function listArtifacts(childrenRoot, childId) {
    return scanArtifacts(childrenRoot, childId);
}
