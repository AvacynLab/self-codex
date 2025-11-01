import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeValidationRunEnv,
  ensureValidationRunLayout,
  type ValidationRunLayout,
} from "../../src/validationRun/layout.js";

/**
 * Integration-like unit tests verifying that the validation run helper prepares the
 * directory structure mandated in `AGENTS.md` and yields the environment variables
 * required by the validation scripts.
 */
describe("validationRun/layout", () => {
  const tempFolders: string[] = [];

  afterEach(async () => {
    // Clean up any temporary validation directories created during the test run.
    await Promise.all(
      tempFolders.splice(0).map(async (folder) => {
        await rm(folder, { recursive: true, force: true });
      }),
    );
  });

  it("creates the complete directory tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-layout-"));
    tempFolders.push(root);

    const layout: ValidationRunLayout = await ensureValidationRunLayout(root);

    await assertDirectory(layout.root);
    await assertDirectory(layout.logsDir);
    await assertDirectory(layout.runsDir);
    await assertDirectory(layout.artifactsDir);
    await assertDirectory(layout.metricsDir);
    await assertDirectory(layout.snapshotsDir);
    await assertDirectory(layout.reportsDir);
  });

  it("computes the expected environment variables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-env-"));
    tempFolders.push(root);

    const layout: ValidationRunLayout = await ensureValidationRunLayout(root);
    const env = computeValidationRunEnv(layout);

    expect(env).to.deep.equal({
      MCP_RUNS_ROOT: layout.root,
      MCP_LOG_FILE: path.join(layout.logsDir, "self-codex.log"),
      MCP_LOG_ROTATE_SIZE: "10mb",
      MCP_LOG_ROTATE_KEEP: "5",
    });
  });

  it("migrates legacy validation_runs directories into the canonical root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-run-migration-"));
    tempFolders.push(root);

    // Seed a minimal `validation_runs/` tree to confirm the migration preserves
    // existing artefacts before cleaning up the deprecated directory.
    const legacyRoot = path.join(root, "validation_runs");
    const legacyLogs = path.join(legacyRoot, "logs");
    await mkdir(legacyLogs, { recursive: true });
    const legacyLogFile = path.join(legacyLogs, "legacy.log");
    await writeFile(legacyLogFile, "legacy-artifact");

    const canonicalRoot = path.join(root, "validation_run");
    const layout = await ensureValidationRunLayout(canonicalRoot);

    // The migrated log file must be accessible from the canonical logs
    // directory so downstream scripts keep resolving the same path.
    const migratedLogPath = path.join(layout.logsDir, "legacy.log");
    const migratedContent = await readFile(migratedLogPath, "utf8");
    expect(migratedContent).to.equal("legacy-artifact");

    const legacyStillExists = await pathExists(legacyRoot);
    expect(legacyStillExists).to.equal(false);
  });
});

async function assertDirectory(target: string): Promise<void> {
  const stats = await stat(target);
  expect(stats.isDirectory(), `expected ${target} to be a directory`).to.equal(true);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
