import { afterEach, before, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Integration-style assertions for the runtime helpers used by the validation
 * harness.  The suite exercises the JavaScript module that prepares
 * `runs/validation_<DATE-ISO>/` so we guarantee the folder structure matches the
 * updated checklist captured in AGENTS.md.
 */
describe("validation run context (scripts)", () => {
  type RunContextModule = typeof import("../../scripts/lib/validation/run-context.mjs");
  let moduleExports: RunContextModule;
  let workspaceRoot: string;

  before(async () => {
    moduleExports = await import("../../scripts/lib/validation/run-context.mjs");
  });

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-run-context-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("creates the updated run layout with an artifacts bucket", async () => {
    const runId = "validation_2099-01-01";
    const context = await moduleExports.createRunContext({ runId, workspaceRoot });

    expect(context.rootDir).to.equal(join(workspaceRoot, "runs", runId));
    expect(context.directories).to.have.property("artifacts");

    const requiredKeys = ["inputs", "outputs", "events", "logs", "artifacts", "report"] as const;
    for (const key of requiredKeys) {
      const folderPath = context.directories[key];
      const stats = await stat(folderPath);
      expect(stats.isDirectory()).to.equal(true, `Expected ${folderPath} to be a directory`);
    }
  });

  it("honours explicit runRoot overrides while keeping directory semantics", async () => {
    const runId = "validation_2099-01-02";
    const overrideRoot = join(workspaceRoot, "custom-root");

    const context = await moduleExports.createRunContext({
      runId,
      workspaceRoot,
      runRoot: overrideRoot,
    });

    expect(context.rootDir).to.equal(overrideRoot);
    const replay = await moduleExports.ensureRunDirectories(overrideRoot);
    expect(replay).to.deep.equal(context.directories);
  });
});
