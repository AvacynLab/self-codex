import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { childWorkspacePath, ensureDirectory, ensureParentDirectory, resolveWithin, } from './paths.js';
const OUTBOX_DIRNAME = 'outbox';
/**
 * Computes the SHA-256 digest of a file without loading it entirely in memory.
 */
async function computeSha256(filePath) {
    const hash = createHash('sha256');
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
/**
 * Persists an artifact within the child outbox and returns its manifest entry.
 */
export async function writeArtifact(options) {
    const absolutePath = outboxPath(options.childrenRoot, options.childId, options.relativePath);
    await ensureParentDirectory(absolutePath);
    const buffer = typeof options.data === 'string'
        ? Buffer.from(options.data, options.encoding ?? 'utf8')
        : options.data;
    await fs.writeFile(absolutePath, buffer);
    const stats = await fs.stat(absolutePath);
    return {
        path: path.relative(outboxPath(options.childrenRoot, options.childId), absolutePath),
        size: stats.size,
        mimeType: options.mimeType,
        sha256: await computeSha256(absolutePath),
    };
}
/**
 * Reads an artifact back from disk.
 */
export async function readArtifact(options) {
    const absolutePath = outboxPath(options.childrenRoot, options.childId, options.relativePath);
    return fs.readFile(absolutePath, options.encoding);
}
/**
 * Lists all artifacts present in the child outbox directory.
 */
export async function listArtifacts(childrenRoot, childId) {
    const directory = await ensureDirectory(childrenRoot, childId, OUTBOX_DIRNAME);
    return listArtifactsRecursive(directory, '');
}
/**
 * Internal helper used for recursive traversal when the directory parameter is
 * already resolved. The public API above keeps the contract focused on child
 * identifiers while this variant works with fully qualified paths.
 */
async function listArtifactsRecursive(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const pathInManifest = prefix ? path.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
            const nested = await listArtifactsRecursive(entryPath, pathInManifest);
            manifests.push(...nested);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const stats = await fs.stat(entryPath);
        manifests.push({
            path: pathInManifest,
            size: stats.size,
            mimeType: 'application/octet-stream',
            sha256: await computeSha256(entryPath),
        });
    }
    manifests.sort((a, b) => a.path.localeCompare(b.path));
    return manifests;
}
