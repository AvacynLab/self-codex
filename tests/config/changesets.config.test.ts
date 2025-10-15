import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "mocha";
import { expect } from "chai";

/**
 * The Changesets config should stay predictable so CI workflows can rely on the
 * release metadata. This test guards the presence of the configuration file and
 * a handful of key flags.
 */
describe("changesets configuration", () => {
  it("exposes the expected base branch and changelog handler", async () => {
    const configPath = resolve(process.cwd(), ".changeset", "config.json");
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw) as {
      baseBranch?: string;
      changelog?: unknown;
      commit?: boolean;
    };

    expect(config.baseBranch).to.equal("main");
    expect(config.commit).to.be.false;
    expect(config.changelog).to.deep.equal(["@changesets/changelog-git", { repo: "" }]);
  });
});
