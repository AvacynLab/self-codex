import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  childWorkspacePath,
  ensureDirectory,
  ensureParentDirectory,
  resolveWithin,
} from './paths.js';

/**
 * Describes a single artifact produced by a child agent.
 */
export interface ArtifactManifestEntry {
  /** Path relative to the child outbox directory. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** MIME type advertised by the child process. */
  mimeType: string;
  /** SHA-256 checksum for deduplication and integrity checks. */
  sha256: string;
}

export interface WriteArtifactOptions {
  /** Directory containing all child workspaces. */
  childrenRoot: string;
  /** Identifier of the child instance. */
  childId: string;
  /** Relative path inside the child outbox. */
  relativePath: string;
  /** File contents to persist. */
  data: string | Buffer;
  /** MIME type recorded in the manifest. */
  mimeType: string;
  /** Encoding used when `data` is a string. */
  encoding?: BufferEncoding;
}

export interface ReadArtifactOptions {
  childrenRoot: string;
  childId: string;
  relativePath: string;
  encoding?: BufferEncoding;
}

const OUTBOX_DIRNAME = 'outbox';

/**
 * Computes the SHA-256 digest of a file without loading it entirely in memory.
 */
async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });

  return hash.digest('hex');
}

function outboxPath(childrenRoot: string, childId: string, relativePath?: string) {
  const base = childWorkspacePath(childrenRoot, childId, OUTBOX_DIRNAME);
  if (!relativePath) {
    return base;
  }

  return resolveWithin(base, relativePath);
}

/**
 * Persists an artifact within the child outbox and returns its manifest entry.
 */
export async function writeArtifact(
  options: WriteArtifactOptions,
): Promise<ArtifactManifestEntry> {
  const absolutePath = outboxPath(
    options.childrenRoot,
    options.childId,
    options.relativePath,
  );

  await ensureParentDirectory(absolutePath);

  const buffer =
    typeof options.data === 'string'
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
export async function readArtifact(
  options: ReadArtifactOptions,
): Promise<string | Buffer> {
  const absolutePath = outboxPath(
    options.childrenRoot,
    options.childId,
    options.relativePath,
  );

  return fs.readFile(absolutePath, options.encoding);
}

/**
 * Lists all artifacts present in the child outbox directory.
 */
export async function listArtifacts(
  childrenRoot: string,
  childId: string,
): Promise<ArtifactManifestEntry[]> {
  const directory = await ensureDirectory(childrenRoot, childId, OUTBOX_DIRNAME);
  return listArtifactsRecursive(directory, '');
}

/**
 * Internal helper used for recursive traversal when the directory parameter is
 * already resolved. The public API above keeps the contract focused on child
 * identifiers while this variant works with fully qualified paths.
 */
async function listArtifactsRecursive(
  directory: string,
  prefix: string,
): Promise<ArtifactManifestEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const manifests: ArtifactManifestEntry[] = [];

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
