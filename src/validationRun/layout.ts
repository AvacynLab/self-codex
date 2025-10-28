import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Represents the canonical directory layout for validation runs. The structure mirrors
 * the checklist provided in `AGENTS.md` so that every validation artefact lives under
 * `validation_run/` and can be archived or inspected deterministically.
 */
export interface ValidationRunLayout {
  /** Absolute path to the `validation_run/` root. */
  readonly root: string;
  /** Absolute path to the structured logs directory. */
  readonly logsDir: string;
  /** Absolute path to per-scenario run folders. */
  readonly runsDir: string;
  /** Absolute path to raw artefacts (dumps, captures, etc.). */
  readonly artifactsDir: string;
  /** Absolute path to performance metrics exports. */
  readonly metricsDir: string;
  /** Absolute path to environment and version snapshots. */
  readonly snapshotsDir: string;
  /** Absolute path to final reports (markdown + json). */
  readonly reportsDir: string;
}

/**
 * Default absolute path pointing to the repository-level `validation_run/` directory.
 */
export const DEFAULT_VALIDATION_RUN_ROOT = path.resolve("validation_run");

/**
 * Creates the directory tree required for a validation campaign.
 *
 * The helper is intentionally idempotent: it only issues `mkdir` calls when a
 * directory does not already exist, ensuring we can run it at the start of any
 * scenario without worrying about previous artefacts. All created folders adhere
 * to the conventions mandated in `AGENTS.md` (logs, runs, artifacts, metrics,
 * snapshots, reports).
 *
 * @param baseRoot Optional absolute or relative path to the root directory.
 * Defaults to {@link DEFAULT_VALIDATION_RUN_ROOT}.
 * @returns The resolved {@link ValidationRunLayout} with absolute paths.
 */
export async function ensureValidationRunLayout(baseRoot?: string): Promise<ValidationRunLayout> {
  const resolvedRoot = baseRoot ? path.resolve(baseRoot) : DEFAULT_VALIDATION_RUN_ROOT;
  const layout: ValidationRunLayout = {
    root: resolvedRoot,
    logsDir: path.join(resolvedRoot, "logs"),
    runsDir: path.join(resolvedRoot, "runs"),
    artifactsDir: path.join(resolvedRoot, "artifacts"),
    metricsDir: path.join(resolvedRoot, "metrics"),
    snapshotsDir: path.join(resolvedRoot, "snapshots"),
    reportsDir: path.join(resolvedRoot, "reports"),
  };

  await mkdirIfMissing(layout.root);
  await Promise.all([
    mkdirIfMissing(layout.logsDir),
    mkdirIfMissing(layout.runsDir),
    mkdirIfMissing(layout.artifactsDir),
    mkdirIfMissing(layout.metricsDir),
    mkdirIfMissing(layout.snapshotsDir),
    mkdirIfMissing(layout.reportsDir),
  ]);

  return layout;
}

/**
 * Generates the environment variables expected by the validation harness.
 *
 * Returning a plain record keeps the function friendly with process managers
 * that merge environment dictionaries. We deliberately omit any optional keys
 * so that consumers never propagate `undefined` values.
 *
 * @param layout The layout resolved by {@link ensureValidationRunLayout}.
 */
export function computeValidationRunEnv(layout: ValidationRunLayout): Record<string, string> {
  return {
    MCP_RUNS_ROOT: layout.root,
    MCP_LOG_FILE: path.join(layout.logsDir, "self-codex.log"),
    MCP_LOG_ROTATE_SIZE: "10mb",
    MCP_LOG_ROTATE_KEEP: "5",
  };
}

/**
 * Ensures a directory exists by first checking for read access and creating it
 * when absent. The explicit check keeps the function side-effect free when the
 * directory is already present and writable.
 */
async function mkdirIfMissing(directory: string): Promise<void> {
  try {
    await access(directory, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    await mkdir(directory, { recursive: true });
  }
}
