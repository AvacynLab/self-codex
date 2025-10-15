import { dirname, relative as relativePath, resolve, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Error raised when an artifact path attempts to escape the configured root.
 *
 * The error object carries enough metadata for higher-level layers (facades,
 * HTTP handlers) to surface actionable diagnostics without leaking filesystem
 * layout details to untrusted callers.
 */
export class ArtifactPathTraversalError extends Error {
  /** Stable error code propagated to observability pipelines. */
  public readonly code = "E-ARTIFACTS-TRAVERSAL" as const;
  /** Absolute path that would have been accessed. */
  public readonly attemptedPath: string;
  /** Sanitised relative path provided by the caller. */
  public readonly relativePath: string;
  /** Root directory configured for artifact persistence. */
  public readonly rootDirectory: string;

  constructor(attemptedPath: string, relativePath: string, rootDirectory: string) {
    super("artifact path escapes configured root directory");
    this.name = "ArtifactPathTraversalError";
    this.attemptedPath = attemptedPath;
    this.relativePath = relativePath;
    this.rootDirectory = rootDirectory;
  }
}

/**
 * Sanitises a relative path provided by a child process so it cannot escape the
 * artifact root directory.
 *
 * The function normalises the string by removing characters that would be
 * rejected by most filesystems and collapsing traversal attempts ("..") into
 * innocuous segments. The resulting absolute path is guaranteed to be located
 * inside the resolved root; otherwise an {@link ArtifactPathTraversalError} is
 * thrown.
 *
 * @param root - Absolute or relative directory acting as the sandbox root.
 * @param relativePath - Path supplied by the child process or facade.
 * @returns The absolute, sanitised path within {@link root}.
 */
export function safePath(root: string, relativePathInput: string): string {
  const resolvedRoot = resolve(root);
  const clean = relativePathInput.replace(/[<>:"|?*\x00-\x1F]/g, "_");
  const absolute = resolve(resolvedRoot, clean);

  const relativeWithinRoot = relativePath(resolvedRoot, absolute);
  const escapesRoot =
    relativeWithinRoot.length > 0 &&
    relativeWithinRoot.split(sep).some((segment) => segment === "..");

  if (absolute === resolvedRoot || !escapesRoot) {
    return absolute;
  }

  throw new ArtifactPathTraversalError(absolute, relativePathInput, resolvedRoot);
}

/**
 * Ensures the parent directory of the provided artifact path exists before
 * writing to disk. The helper returns the absolute target path so callers can
 * chain filesystem operations fluently.
 *
 * @param root - Root directory of the artifact sandbox.
 * @param relativePath - User-supplied path resolved via {@link safePath}.
 */
async function ensureParentDirectory(root: string, relativePath: string): Promise<string> {
  const target = safePath(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  return target;
}

/**
 * Persists an artifact to disk after sanitising its relative location.
 *
 * @param root - Root directory of the artifact sandbox.
 * @param relativePath - User-provided relative location of the artifact.
 * @param payload - Bytes (or UTF-8 string) to persist.
 * @param encoding - Optional encoding when {@link payload} is textual.
 * @returns Absolute path to the persisted artifact.
 */
export async function writeArtifactFile(
  root: string,
  relativePath: string,
  payload: string | Buffer,
  encoding: BufferEncoding = "utf8",
): Promise<string> {
  const target = await ensureParentDirectory(root, relativePath);
  if (typeof payload === "string") {
    await writeFile(target, payload, { encoding });
  } else {
    await writeFile(target, payload);
  }
  return target;
}

/**
 * Reads an artifact back from disk using a sanitised relative path.
 *
 * @param root - Root directory of the artifact sandbox.
 * @param relativePath - Relative location of the artifact inside {@link root}.
 * @param encoding - Optional encoding when textual content is expected.
 * @returns The artifact contents as a string or Buffer.
 */
export async function readArtifactFile(
  root: string,
  relativePath: string,
  encoding?: BufferEncoding,
): Promise<string | Buffer> {
  const target = safePath(root, relativePath);
  if (encoding) {
    return readFile(target, { encoding });
  }
  return readFile(target);
}
