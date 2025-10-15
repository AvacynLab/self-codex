import { dirname, isAbsolute, relative as relativePath, resolve, sep } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { PathResolutionError } from "../paths.js";

/** Characters rejected by most filesystems and therefore replaced during sanitisation. */
const FORBIDDEN_PATH_CHARACTERS = /[<>:"|?*\x00-\x1F]/g;
/**
 * Collapses suspicious dot-sequences that are not part of explicit path segments
 * (e.g. `..` followed by a separator) so callers cannot disguise filenames with
 * arbitrarily long chains of dots.
 */
const REPEATED_DOTS_PATTERN = /\.{2,}(?=[^/\\]|$)/g;

/**
 * Detect whether the provided absolute path escapes the configured sandbox root.
 *
 * The helper relies on {@link relativePath} so the logic remains portable across
 * POSIX and Windows environments while also catching drive letter switches on
 * Windows (where {@link relativePath} yields an absolute string).
 */
function isOutsideRoot(root: string, absolute: string): boolean {
  if (absolute === root) {
    return false;
  }

  const relativeWithinRoot = relativePath(root, absolute);
  if (!relativeWithinRoot) {
    return false;
  }

  if (relativeWithinRoot.startsWith("..")) {
    return true;
  }

  if (relativeWithinRoot.split(sep).some((segment) => segment === "..")) {
    return true;
  }

  return isAbsolute(relativeWithinRoot);
}

/**
 * Error raised when an artifact path attempts to escape the configured root.
 *
 * The error object carries enough metadata for higher-level layers (facades,
 * HTTP handlers) to surface actionable diagnostics without leaking filesystem
 * layout details to untrusted callers.
 */
export class ArtifactPathTraversalError extends PathResolutionError {
  /** Sanitised relative path provided by the caller. */
  public readonly relativePath: string;

  constructor(attemptedPath: string, relativePath: string, rootDirectory: string) {
    super("artifact path escapes configured root directory", attemptedPath, rootDirectory, { relative: relativePath });
    this.name = "ArtifactPathTraversalError";
    this.relativePath = relativePath;
  }
}

/**
 * Sanitises a relative path provided by a child process so it cannot escape the
 * artifact root directory.
 *
 * The function normalises path separators, strips characters rejected by most
 * filesystems, rejects traversal attempts, and collapses suspicious dot runs in
 * filenames. The resulting absolute path is guaranteed to live inside the
 * resolved root; otherwise an {@link ArtifactPathTraversalError} is thrown.
 *
 * @param root - Absolute or relative directory acting as the sandbox root.
 * @param relativePath - Path supplied by the child process or facade.
 * @returns The absolute, sanitised path within {@link root}.
 */
export function safePath(root: string, relativePathInput: string): string {
  const resolvedRoot = resolve(root);

  // Normalise path separators so attempts using Windows-style backslashes are
  // detected consistently on all platforms.
  const normalisedSeparators = relativePathInput.replace(/\\/g, sep);

  // First pass: replace characters rejected by common filesystems while
  // keeping the original dot segments intact to detect traversal attempts.
  const sanitizedForDetection = normalisedSeparators.replace(FORBIDDEN_PATH_CHARACTERS, "_");
  const attemptedAbsolute = resolve(resolvedRoot, sanitizedForDetection);

  if (isOutsideRoot(resolvedRoot, attemptedAbsolute)) {
    throw new ArtifactPathTraversalError(attemptedAbsolute, relativePathInput, resolvedRoot);
  }

  // Second pass: collapse suspicious repetitions of dots now that we know the
  // path remains within the sandbox. This prevents payloads such as "....//"
  // from slipping through logging or metric pipelines with ambiguous entries.
  const sanitizedRelative = sanitizedForDetection.replace(REPEATED_DOTS_PATTERN, ".");
  const absolute = resolve(resolvedRoot, sanitizedRelative);

  if (isOutsideRoot(resolvedRoot, absolute)) {
    throw new ArtifactPathTraversalError(absolute, relativePathInput, resolvedRoot);
  }

  return absolute;
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
