import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
});

async function assertDirectory(target: string): Promise<void> {
  const stats = await stat(target);
  expect(stats.isDirectory(), `expected ${target} to be a directory`).to.equal(true);
}
