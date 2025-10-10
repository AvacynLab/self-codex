import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeValidationRunLayout } from "../../src/validation/runLayout.js";

const FIXED_DATE = "2025-10-10";

describe("validation run layout helper", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-run-layout-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("creates the expected directory structure", async () => {
    const layout = await initializeValidationRunLayout({
      workspaceRoot,
      isoDate: FIXED_DATE,
    });

    expect(layout.runId).to.equal(`validation_${FIXED_DATE}`);
    expect(layout.rootDir).to.equal(join(workspaceRoot, "runs", `validation_${FIXED_DATE}`));

    for (const [key, folder] of Object.entries(layout.directories)) {
      await stat(folder);
      expect(folder).to.equal(join(layout.rootDir, key));
    }
  });

  it("optionally drops .gitkeep markers in every folder", async () => {
    const layout = await initializeValidationRunLayout({
      workspaceRoot,
      isoDate: FIXED_DATE,
      createGitkeepFiles: true,
    });

    for (const folder of Object.values(layout.directories)) {
      const gitkeepPath = join(folder, ".gitkeep");
      const contents = await readFile(gitkeepPath, "utf8");
      expect(contents).to.equal("");
    }
  });

  it("rejects non ISO formatted dates", async () => {
    let capturedError: unknown;
    try {
      await initializeValidationRunLayout({ workspaceRoot, isoDate: "10/10/2025" });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).to.be.instanceOf(Error);
    expect((capturedError as Error).message).to.match(/Expected isoDate to match YYYY-MM-DD/);
  });

  it("is idempotent when invoked multiple times", async () => {
    const first = await initializeValidationRunLayout({
      workspaceRoot,
      isoDate: FIXED_DATE,
      createGitkeepFiles: true,
    });

    const second = await initializeValidationRunLayout({
      workspaceRoot,
      isoDate: FIXED_DATE,
      createGitkeepFiles: true,
    });

    expect(second).to.deep.equal(first);
  });
});
