import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { ensureDirectory, ensureParentDirectory, resolveWithin } from './paths.js';
import { safePath } from './gateways/fsArtifacts.js';
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
async function loadManifest(outboxDir) {
    const manifestPath = resolveWithin(outboxDir, MANIFEST_FILENAME);
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
    const manifestPath = resolveWithin(outboxDir, MANIFEST_FILENAME);
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
    const absolutePath = safePath(outboxDir, options.relativePath);
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
    const outboxDir = await ensureDirectory(options.childrenRoot, options.childId, OUTBOX_DIRNAME);
    const absolutePath = safePath(outboxDir, options.relativePath);
    if (options.encoding) {
        return fs.readFile(absolutePath, { encoding: options.encoding });
    }
    return Buffer.from(await fs.readFile(absolutePath));
}
/**
 * Lists all artifacts present in the child outbox directory while refreshing
 * the manifest metadata (size, hash, mime type).
 */
export async function scanArtifacts(childrenRoot, childId) {
    const outboxDir = await ensureDirectory(childrenRoot, childId, OUTBOX_DIRNAME);
    const manifest = await loadManifest(outboxDir);
    const refreshed = new Map();
    async function traverse(relativeDirectory) {
        const absoluteDirectory = relativeDirectory.length > 0
            ? resolveWithin(outboxDir, relativeDirectory)
            : outboxDir;
        const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === MANIFEST_FILENAME) {
                // Skip the manifest itself: it is regenerated at the end of the scan.
                continue;
            }
            const entryRelativePath = relativeDirectory.length > 0 ? path.join(relativeDirectory, entry.name) : entry.name;
            if (entry.isSymbolicLink()) {
                // Symbolic links could point outside of the workspace. Skipping them prevents
                // accidental disclosures when a child tries to reference external data.
                continue;
            }
            if (entry.isDirectory()) {
                await traverse(entryRelativePath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const entryAbsolutePath = resolveWithin(outboxDir, entryRelativePath);
            const stats = await fs.stat(entryAbsolutePath);
            const previous = manifest.get(entryRelativePath);
            const mimeType = previous?.mimeType ?? 'application/octet-stream';
            const sha256 = await hashFile(entryAbsolutePath);
            const descriptor = {
                path: entryRelativePath,
                size: stats.size,
                mimeType,
                sha256,
            };
            refreshed.set(entryRelativePath, descriptor);
        }
    }
    await traverse('');
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
//# sourceMappingURL=artifacts.js.map