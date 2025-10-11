import { resolve } from "node:path";
import { ensureDirectory, ensureGitkeep } from "../paths.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Options accepted by {@link initializeValidationRunLayout}. The helper is in
 * charge of preparing the directory structure requested in the latest
 * validation playbook (see AGENTS.md).  The structure intentionally lives under
 * `runs/validation_<DATE-ISO>/` so that it never conflicts with the historical
 * `validation_runs/` artefacts shipped with the project.
 */
export interface ValidationRunLayoutOptions {
  /**
   * Absolute or relative path to the workspace root.  The helper resolves the
   * value to an absolute path to avoid surprises when scripts run from custom
   * working directories.
   */
  workspaceRoot: string;
  /**
   * Optional date string (formatted as `YYYY-MM-DD`).  When omitted the helper
   * will use the current date in UTC.
   */
  isoDate?: string;
  /**
   * When set to `true`, a `.gitkeep` file is created in every generated folder
   * so empty directories remain visible in version control when desired.
   */
  createGitkeepFiles?: boolean;
}

/**
 * Describes the layout created on disk.
 */
export interface ValidationRunLayout {
  /** Identifier such as `validation_2025-10-09`. */
  runId: string;
  /** Absolute path to the run root directory. */
  rootDir: string;
  /** Absolute paths to the expected artefact folders. */
  directories: {
    inputs: string;
    outputs: string;
    events: string;
    logs: string;
    artifacts: string;
    report: string;
  };
}

/**
 * Formats the provided ISO date string.  When the caller omits the parameter we
 * derive a date (UTC) using `Date.prototype.toISOString()` and keep only the
 * `YYYY-MM-DD` component.  The helper performs sanity checks to make sure the
 * `isoDate` parameter is indeed compliant because the folder name becomes part
 * of the file-system layout and therefore must stay predictable.
 */
function resolveIsoDate(isoDate?: string): string {
  if (isoDate) {
    const trimmed = isoDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error(`Expected isoDate to match YYYY-MM-DD, received: ${isoDate}`);
    }
    return trimmed;
  }

  return new Date().toISOString().slice(0, 10);
}

/**
 * Creates the validation run directory structure described in the new
 * playbook.  The function returns the run identifier and the absolute paths of
 * the generated folders so scripts (or future agents) can reference them without
 * reimplementing the layout logic.  The helper is safe to call multiple times –
 * subsequent calls simply reuse the existing directories.
 */
export async function initializeValidationRunLayout(
  options: ValidationRunLayoutOptions,
): Promise<ValidationRunLayout> {
  if (!options || !options.workspaceRoot) {
    throw new Error("initializeValidationRunLayout requires a workspaceRoot");
  }

  const isoDate = resolveIsoDate(options.isoDate);
  const runId = `validation_${isoDate}`;
  const workspaceRoot = resolve(options.workspaceRoot);
  const runsRoot = await ensureDirectory(workspaceRoot, "runs");
  const rootDir = await ensureDirectory(runsRoot, runId);
  const createGitkeep = options.createGitkeepFiles ?? false;

  const directories: ValidationRunLayout["directories"] = {
    inputs: await ensureDirectory(rootDir, "inputs"),
    outputs: await ensureDirectory(rootDir, "outputs"),
    events: await ensureDirectory(rootDir, "events"),
    logs: await ensureDirectory(rootDir, "logs"),
    artifacts: await ensureDirectory(rootDir, "artifacts"),
    report: await ensureDirectory(rootDir, "report"),
  };

  if (createGitkeep) {
    await ensureGitkeep(rootDir);
    await Promise.all(Object.values(directories).map((directoryPath) => ensureGitkeep(directoryPath)));
  }

  return {
    runId,
    rootDir,
    directories,
  };
}
