import { describe, it, before } from "mocha";
import { expect } from "chai";

let helpers: any;

/**
 * The environment scripts enforce a "no-write" policy for production
 * maintenance tasks. These tests exercise the shared helper module so that the
 * policy remains encoded in code rather than comments.
 */
describe("environment script helpers", () => {
  before(async () => {
    // @ts-expect-error The helper is authored as an ESM script without
    // TypeScript declarations; runtime import keeps the behaviour aligned with
    // production usage while tests focus on observable outputs.
    helpers = await import("../scripts/lib/env-helpers.mjs");
  });

  it("detects patch branches regardless of casing", () => {
    expect(helpers.isBranchBlocked("apply_patch"), "underscored branch").to.equal(true);
    expect(helpers.isBranchBlocked("Codex-Apply-Patch"), "mixed case branch").to.equal(true);
    expect(helpers.isBranchBlocked("feature/main"), "regular feature branch").to.equal(false);
  });

  it("rejects the maintenance flow on blocked branches", async () => {
    try {
      await helpers.ensureBranchAllowed(async () => "codex/apply-patch");
      expect.fail("blocked branches must cause the guard to throw");
    } catch (error) {
      expect((error as Error).message).to.include("disabled on patch branches");
    }
  });

  it("returns the trimmed branch name for allowed flows", async () => {
    const branch = await helpers.ensureBranchAllowed(async () => " main \n");
    expect(branch).to.equal("main");
  });

  it("builds the command plan with read-only installs when no lockfile is present", () => {
    const plan = helpers.buildCommandPlan(false);
    expect(plan).to.have.length(3);
    expect(plan[0]?.args).to.deep.equal([
      "install",
      "--omit=dev",
      "--no-save",
      "--no-package-lock",
    ]);
    expect(plan[1]?.args).to.deep.equal([
      "install",
      "@types/node@latest",
      "--no-save",
      "--no-package-lock",
    ]);
    expect(plan[2]?.args).to.deep.equal(["run", "build"]);
  });

  it("switches to npm ci when the lockfile is available", () => {
    const plan = helpers.buildCommandPlan(true);
    expect(plan[0]?.args).to.deep.equal(["ci"]);
  });
});
