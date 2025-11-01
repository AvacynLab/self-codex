import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { readOptionalString } from "../config/env.js";

import { sanitizeFilename } from "../paths.js";
import { safePath } from "../gateways/fsArtifacts.js";

/** Metadata associated with a persisted snapshot on disk. */
export interface SnapshotMetadata {
  /** Identifier derived from the creation timestamp and optional label. */
  readonly id: string;
  /** Namespace that owns the snapshot (graph, tx, planner, ...). */
  readonly namespace: string;
  /** RFC3339 timestamp describing when the snapshot was taken. */
  readonly createdAt: string;
  /** Absolute path to the JSON artefact on disk. */
  readonly path: string;
  /** Size in bytes of the persisted artefact. */
  readonly sizeBytes: number;
  /** Additional metadata persisted alongside the user state. */
  readonly metadata: Record<string, unknown>;
}

/** Full snapshot record including the user supplied state payload. */
export interface SnapshotRecord<TState> extends SnapshotMetadata {
  /** Application defined state captured inside the snapshot. */
  readonly state: TState;
}

/** Options controlling where and how snapshots are stored. */
export interface SnapshotOptions {
  /** Optional base directory overriding {@link process.env.MCP_RUNS_ROOT}. */
  readonly runsRoot?: string;
  /** Deterministic clock used primarily by tests to fix timestamps. */
  readonly clock?: () => Date;
  /** Free-form metadata attached to the snapshot. */
  readonly metadata?: Record<string, unknown>;
  /** Optional human label incorporated into the identifier. */
  readonly label?: string;
}

/** Options accepted by {@link snapshotList} and {@link snapshotLoad}. */
export interface SnapshotQueryOptions {
  /** Optional base directory overriding {@link process.env.MCP_RUNS_ROOT}. */
  readonly runsRoot?: string;
}

/**
 * Persists the provided state into the snapshot store. The artefact is encoded
 * as JSON and always terminated by a newline so log processing tools can stream
 * it safely. All filesystem paths are routed through {@link safePath} to guard
 * against traversal attacks before callers receive the structured descriptor
 * that can be fed back into {@link snapshotLoad}.
 */
export async function snapshotTake<TState>(
  namespace: string,
  state: TState,
  options: SnapshotOptions = {},
): Promise<SnapshotRecord<TState>> {
  const trimmedNamespace = namespace.trim();
  if (trimmedNamespace.length === 0) {
    throw new Error("snapshot namespace must be a non-empty string");
  }

  const timestamp = (options.clock?.() ?? new Date()).toISOString();
  const runsRoot = resolveRunsRoot(options.runsRoot);
  const directory = safePath(runsRoot, path.join("snapshots", sanitizeFilename(trimmedNamespace)));
  await mkdir(directory, { recursive: true });

  const labelSegment = options.label ? `-${sanitizeFilename(options.label)}` : "";
  const id = `${formatTimestampForId(timestamp)}${labelSegment}`;
  const filePath = safePath(directory, `${id}.json`);
  const metadata = options.metadata ?? {};

  const record: SnapshotRecord<TState> = {
    id,
    namespace: trimmedNamespace,
    createdAt: timestamp,
    path: filePath,
    sizeBytes: 0,
    metadata,
    state,
  };

  const serialised = `${JSON.stringify({
    id: record.id,
    namespace: record.namespace,
    createdAt: record.createdAt,
    metadata: record.metadata,
    state: record.state,
  })}\n`;

  await writeFile(filePath, serialised, { encoding: "utf8" });
  const fileStats = await stat(filePath);

  return { ...record, sizeBytes: fileStats.size };
}

/**
 * Lists the snapshots associated with the provided namespace. The result is
 * ordered from newest to oldest so callers can pick the latest state by reading
 * the first entry only. Each path is resolved through {@link safePath} to keep
 * traversal attempts inside the configured runs root.
 */
export async function snapshotList(
  namespace: string,
  options: SnapshotQueryOptions = {},
): Promise<SnapshotMetadata[]> {
  const trimmedNamespace = namespace.trim();
  if (trimmedNamespace.length === 0) {
    throw new Error("snapshot namespace must be a non-empty string");
  }

  const runsRoot = resolveRunsRoot(options.runsRoot);
  const directory = safePath(runsRoot, path.join("snapshots", sanitizeFilename(trimmedNamespace)));

  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const metadata: SnapshotMetadata[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const id = file.slice(0, -5);
    const absolutePath = safePath(directory, file);
    try {
      const raw = await readFile(absolutePath, { encoding: "utf8" });
      const parsed = JSON.parse(raw) as {
        id: string;
        namespace: string;
        createdAt: string;
        metadata?: Record<string, unknown>;
      };
      const stats = await stat(absolutePath);
      metadata.push({
        id: parsed.id ?? id,
        namespace: parsed.namespace ?? trimmedNamespace,
        createdAt: parsed.createdAt ?? new Date(0).toISOString(),
        metadata: parsed.metadata ?? {},
        path: absolutePath,
        sizeBytes: stats.size,
      });
    } catch (error) {
      // Surface the parsing error with additional context so operators can
      // repair corrupted snapshots manually.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to read snapshot ${absolutePath}: ${message}`);
    }
  }

  return metadata.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Loads and returns the full snapshot record for the provided identifier while
 * ensuring the caller-provided id cannot escape the runs root thanks to
 * {@link safePath}.
 */
export async function snapshotLoad<TState>(
  namespace: string,
  id: string,
  options: SnapshotQueryOptions = {},
): Promise<SnapshotRecord<TState>> {
  const trimmedNamespace = namespace.trim();
  if (trimmedNamespace.length === 0) {
    throw new Error("snapshot namespace must be a non-empty string");
  }

  const trimmedId = id.trim();
  if (trimmedId.length === 0) {
    throw new Error("snapshot id must be a non-empty string");
  }

  const runsRoot = resolveRunsRoot(options.runsRoot);
  const directory = safePath(runsRoot, path.join("snapshots", sanitizeFilename(trimmedNamespace)));
  const filePath = safePath(directory, `${sanitizeFilename(trimmedId)}.json`);

  let raw: string;
  try {
    raw = await readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`snapshot ${trimmedId} is not available for namespace ${trimmedNamespace}`);
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as {
    id: string;
    namespace: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
    state: TState;
  };

  const fileStats = await stat(filePath);

  return {
    id: parsed.id ?? trimmedId,
    namespace: parsed.namespace ?? trimmedNamespace,
    createdAt: parsed.createdAt ?? new Date(0).toISOString(),
    metadata: parsed.metadata ?? {},
    path: filePath,
    sizeBytes: fileStats.size,
    state: parsed.state,
  };
}

/** Resolves the base runs directory honouring environment overrides. */
function resolveRunsRoot(override?: string): string {
  const envOverride = readOptionalString("MCP_RUNS_ROOT");
  const base = typeof override === "string" && override.length > 0 ? override : envOverride ?? "validation_run";
  return path.resolve(process.cwd(), base);
}

/** Builds the identifier prefix used for snapshot files. */
function formatTimestampForId(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

export const __snapshotInternals = {
  resolveRunsRoot,
  formatTimestampForId,
};
