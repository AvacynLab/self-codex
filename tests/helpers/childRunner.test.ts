import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { stat, rm, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFixture, runnerArgs } from "./childRunner.js";

describe("child runner helper", () => {
  const fixtureUrl = new URL("../fixtures/mock-runner.ts", import.meta.url);
  const fixturePath = fileURLToPath(fixtureUrl);
  const compiledPath = join(process.cwd(), "tmp", "compiled-fixtures", `${basename(fixturePath, ".ts")}.mjs`);

  beforeEach(async () => {
    if (existsSync(compiledPath)) {
      await rm(compiledPath, { force: true });
    }
  });

  it("resolves fixtures relative to the caller", () => {
    const resolved = resolveFixture(import.meta.url, "../fixtures/mock-runner.ts");
    expect(resolved).to.equal(fixturePath);
  });

  it("compiles fixtures into the tmp/compiled-fixtures directory", async () => {
    const [compiled] = runnerArgs(fixturePath);

    expect(compiled.endsWith("mock-runner.mjs")).to.equal(true);
    const relativePath = relative(process.cwd(), compiled);
    expect(relativePath.startsWith(`tmp${sep}compiled-fixtures`)).to.equal(true);

    const stats = await stat(compiled);
    expect(stats.isFile()).to.equal(true);
    expect(stats.size).to.be.greaterThan(0);
  });

  it("recompiles when the source timestamp advances", async () => {
    const [compiled] = runnerArgs(fixturePath);
    const firstStats = await stat(compiled);

    // Force the compiled artefact timestamp to predate the source so the helper
    // detects the staleness and regenerates the ES module on the next call.
    await utimes(compiled, new Date(0), new Date(0));

    const [recompiledPath] = runnerArgs(fixturePath);
    expect(recompiledPath).to.equal(compiled);

    const updatedStats = await stat(compiled);
    expect(updatedStats.mtimeMs).to.be.greaterThan(firstStats.mtimeMs);
  });
});
