import { describe, it } from "mocha";
import { expect } from "chai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guarantees the `.gitignore` stays aligned with the hygiene checklist tracked in `AGENTS.md`.
 * The test focuses on patterns explicitly demanded by the "Vérifier .gitignore" task so future
 * contributors cannot accidentally drop them when reorganising ignore rules.
 */
describe("repository hygiene", () => {
  it("keeps the required ignore patterns", async () => {
    const __filename = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(__filename), "..");
    const gitignorePath = path.join(repoRoot, ".gitignore");
    const content = await readFile(gitignorePath, "utf8");
    const patterns = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    const REQUIRED_PATTERNS = new Map<string, string>([
      ["dist/", "Build output of the orchestrator root project"],
      ["runs/", "Runtime artefacts produced by evaluation scripts"],
      ["children/", "Child workspace roots that should never leak into git"],
      ["graph-forge/dist/", "Graph-Forge compilation artefacts"],
      ["graph-forge/test/**/*.js", "Transpiled fixtures produced by Graph-Forge tests"],
      ["*.log", "Structured log outputs toggled via MCP_LOG_FILE"],
    ]);

    for (const [pattern, rationale] of REQUIRED_PATTERNS.entries()) {
      expect(
        patterns,
        `La règle "${pattern}" (${rationale}) doit rester dans .gitignore pour respecter la feuille de route.`,
      ).to.include(pattern);
    }
  });
});
