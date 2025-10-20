import { describe, it } from "mocha";
import { expect } from "chai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Guarantees that the vendored Graph Forge TypeScript project compiles only its
 * own sources. The assertion protects us from accidentally widening the
 * include pattern to the orchestrator's root `src/` directory when tweaking the
 * shared compiler options.
 */
describe("graph-forge TypeScript project isolation", () => {
  it("only emits files from graph-forge/src", async function () {
    this.timeout(10_000);
    const tscBin = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    const { stdout } = await execFileAsync("node", [
      tscBin,
      "--project",
      "graph-forge/tsconfig.json",
      "--listFilesOnly",
      "--pretty",
      "false"
    ]);

    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const normalisedFiles = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => !entry.includes(`${sep}node_modules${sep}`))
      .map((entry) => relative(projectRoot, entry).split(sep).join("/"));

    expect(normalisedFiles, "tsc should emit vendored sources").to.not.be.empty;
    for (const file of normalisedFiles) {
      expect(file.startsWith("graph-forge/src/"), `unexpected file emitted: ${file}`).to.equal(true);
    }
  });
});
