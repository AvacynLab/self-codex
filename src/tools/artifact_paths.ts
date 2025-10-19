import { createHash } from "node:crypto";
import { relative as relativePath } from "node:path";

import { safePath } from "../gateways/fsArtifacts.js";
import { childWorkspacePath } from "../paths.js";
import { readInt } from "../config/env.js";

/** Default maximum number of bytes accepted by the artifact façades. */
const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * Snapshot describing a sanitised artifact path.
 *
 * The helpers return the absolute location within the child outbox as well as
 * a relative (redacted) representation and a deterministic hash to correlate
 * log entries without leaking sensitive filesystem details.
 */
export interface SanitizedArtifactPath {
  /** Absolute path resolved inside the child outbox root. */
  readonly absolute: string;
  /** Relative path stored in manifests and surfaced back to clients. */
  readonly relative: string;
  /** Deterministic hash used to correlate log entries without leaking details. */
  readonly hash: string;
  /** Absolute path to the child outbox directory. */
  readonly outboxRoot: string;
}

/**
 * Resolves the child outbox directory and sanitises the user provided path.
 *
 * @param childrenRoot - Root directory that stores all child workspaces.
 * @param childId - Identifier of the target child workspace.
 * @param requestedPath - Path provided by the MCP caller.
 * @returns Sanitised absolute/relative paths and a log-friendly hash.
 */
export function sanitizeArtifactPath(
  childrenRoot: string,
  childId: string,
  requestedPath: string,
): SanitizedArtifactPath {
  const outboxRoot = childWorkspacePath(childrenRoot, childId, "outbox");
  const absolute = safePath(outboxRoot, requestedPath);
  const relative = relativePath(outboxRoot, absolute);
  const hash = createHash("sha256").update(relative).digest("hex");
  return { absolute, relative, hash, outboxRoot };
}

/**
 * Returns the maximum payload size accepted by the artifact façades.
 *
 * The helper honours the optional `MCP_MAX_ARTIFACT_BYTES` environment
 * variable so tests and deployments can tighten the limit.
 */
export function resolveMaxArtifactBytes(): number {
  // Honour the optional override while rejecting zero/negative payload limits.
  return readInt("MCP_MAX_ARTIFACT_BYTES", DEFAULT_MAX_ARTIFACT_BYTES, { min: 1 });
}

/**
 * Redacts a raw path string before emitting it in logs.
 *
 * The helper produces a short SHA-256 digest so different log entries can be
 * correlated without revealing the original value.
 */
export function redactPathForLogs(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Builds the log metadata associated with a sanitised artifact path.
 *
 * @param path - Sanitised path information returned by
 * {@link sanitizeArtifactPath}.
 */
export function buildPathLogFields(path: SanitizedArtifactPath): {
  path_relative: string;
  path_hash: string;
} {
  return {
    path_relative: path.relative,
    path_hash: path.hash.slice(0, 16),
  };
}

