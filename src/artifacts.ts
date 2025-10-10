import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BufferEncoding, ErrnoException } from './nodePrimitives.js';

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
const MANIFEST_FILENAME = 'manifest.json';
const MANIFEST_VERSION = 1;

interface PersistedManifest {
  version: number;
  entries: ArtifactManifestEntry[];
}

/**
 * Computes the digest of the provided file using a streaming approach.
 *
 * The helper is exported so other subsystems (tests, collectors, …) can reuse
 * the exact same hashing semantics when verifying artifacts.
 */
export async function hashFile(
  filePath: string,
  algorithm: 'sha256' = 'sha256',
): Promise<string> {
  const hash = createHash(algorithm);
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

async function loadManifest(outboxDir: string): Promise<Map<string, ArtifactManifestEntry>> {
  const manifestPath = resolveWithin(outboxDir, MANIFEST_FILENAME);

  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedManifest;

    if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
      return new Map();
    }

    const map = new Map<string, ArtifactManifestEntry>();
    for (const entry of parsed.entries) {
      if (
        !entry ||
        typeof entry.path !== 'string' ||
        typeof entry.size !== 'number' ||
        typeof entry.mimeType !== 'string' ||
        typeof entry.sha256 !== 'string'
      ) {
        continue;
      }
      map.set(entry.path, { ...entry });
    }
    return map;
  } catch (error) {
    if ((error as ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

async function persistManifest(
  outboxDir: string,
  entries: Iterable<ArtifactManifestEntry>,
): Promise<void> {
  const manifestPath = resolveWithin(outboxDir, MANIFEST_FILENAME);
  const serialised: PersistedManifest = {
    version: MANIFEST_VERSION,
    entries: Array.from(entries).sort((a, b) => a.path.localeCompare(b.path)),
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(serialised, null, 2)}\n`);
}

/**
 * Persists an artifact within the child outbox and returns its manifest entry.
 */
export async function writeArtifact(
  options: WriteArtifactOptions,
): Promise<ArtifactManifestEntry> {
  const outboxDir = await ensureDirectory(options.childrenRoot, options.childId, OUTBOX_DIRNAME);
  const absolutePath = resolveWithin(outboxDir, options.relativePath);

  await ensureParentDirectory(absolutePath);

  const buffer =
    typeof options.data === 'string'
      ? Buffer.from(options.data, options.encoding ?? 'utf8')
      : options.data;

  await fs.writeFile(absolutePath, buffer);
  const stats = await fs.stat(absolutePath);

  const entry: ArtifactManifestEntry = {
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
export async function readArtifact(
  options: ReadArtifactOptions,
): Promise<string | Buffer> {
  const absolutePath = outboxPath(
    options.childrenRoot,
    options.childId,
    options.relativePath,
  );

  if (options.encoding) {
    return fs.readFile(absolutePath, { encoding: options.encoding });
  }
  return fs.readFile(absolutePath);
}

/**
 * Lists all artifacts present in the child outbox directory while refreshing
 * the manifest metadata (size, hash, mime type).
 */
export async function scanArtifacts(
  childrenRoot: string,
  childId: string,
): Promise<ArtifactManifestEntry[]> {
  const outboxDir = await ensureDirectory(childrenRoot, childId, OUTBOX_DIRNAME);
  const manifest = await loadManifest(outboxDir);
  const refreshed = new Map<string, ArtifactManifestEntry>();

  async function traverse(relativeDirectory: string): Promise<void> {
    const absoluteDirectory =
      relativeDirectory.length > 0
        ? resolveWithin(outboxDir, relativeDirectory)
        : outboxDir;
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === MANIFEST_FILENAME) {
        // Skip the manifest itself: it is regenerated at the end of the scan.
        continue;
      }

      const entryRelativePath =
        relativeDirectory.length > 0 ? path.join(relativeDirectory, entry.name) : entry.name;

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

      const descriptor: ArtifactManifestEntry = {
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
export async function listArtifacts(
  childrenRoot: string,
  childId: string,
): Promise<ArtifactManifestEntry[]> {
  return scanArtifacts(childrenRoot, childId);
}
