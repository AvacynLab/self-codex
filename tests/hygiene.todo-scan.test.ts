import { describe, it } from "mocha";
import { expect } from "chai";
import { readdir, readFile } from "node:fs/promises";
import type { ErrnoException } from "../src/nodePrimitives.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository hygiene guard ensuring no stale TODO/FIXME comment markers linger in the codebase.
 * The scan intentionally targets source and test directories so follow-up contributors cannot
 * accidentally leave placeholders that would undermine the "Supprimer code mort et TODOs"
 * checklist item tracked in {@link AGENTS.md}.
 */
describe("repository hygiene", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..");

  const DIRECTORIES_TO_SCAN = ["src", "tests", "scripts", path.join("graph-forge", "src"), path.join("graph-forge", "test")];
  const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".git", "tmp", "playground_codex_demo", "tmp_before.txt"]);
  const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
  const COMMENT_MARKER_PATTERN = /\/\/\s*(?:TODO|FIXME)|\/\*\s*(?:TODO|FIXME)/g;
  const hygieneConfigPath = path.resolve(repoRoot, "config", "hygiene.config.json");
  let todoAllowlist = new Set<string>();
  let normalizeRelativePath: (input: string) => string = (input) => path.posix.normalize(input.replace(/\\/g, "/"));
  type HygieneHelpers = typeof import("../scripts/hygiene/checker.mjs");
  type NormalizeAllowlistEntryResult = ReturnType<HygieneHelpers["normalizeAllowlistEntry"]>;
  let normalizeAllowlistEntry: (entry: unknown) => NormalizeAllowlistEntryResult = (entry) => {
    if (typeof entry !== "string") {
      return { ok: false, reason: "empty" } as NormalizeAllowlistEntryResult;
    }
    const normalized = normalizeRelativePath(entry);
    if (normalized.length === 0) {
      return { ok: false, reason: "empty" } as NormalizeAllowlistEntryResult;
    }
    return { ok: true, value: normalized } as NormalizeAllowlistEntryResult;
  };

  before(async () => {
    const hygieneHelpers = await import("../scripts/hygiene/checker.mjs");
    normalizeRelativePath = hygieneHelpers.normalizeRelativePath;
    normalizeAllowlistEntry = hygieneHelpers.normalizeAllowlistEntry;
    try {
      const rawConfig = await readFile(hygieneConfigPath, "utf8");
      const parsed = JSON.parse(rawConfig);
      if (Array.isArray(parsed.todoAllowlist)) {
        const entries: string[] = [];
        for (const entry of parsed.todoAllowlist) {
          const normalization = normalizeAllowlistEntry(entry);
          if (normalization.ok) {
            entries.push(normalization.value);
          }
        }
        todoAllowlist = new Set(entries);
      }
    } catch (error) {
      const errno = error as ErrnoException;
      if (errno.code !== "ENOENT") {
        throw error;
      }
    }
  });

  async function collectFiles(relativeDir: string): Promise<string[]> {
    const absoluteDir = path.resolve(repoRoot, relativeDir);
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      const errno = error as ErrnoException;
      if (errno.code === "ENOENT") {
        // Lorsque certains sous-répertoires (ex. l'ancien `graph-forge/test/`)
        // sont supprimés, nous considérons simplement qu'il n'y a rien à
        // analyser. Cela permet de conserver la garde tout en laissant la base
        // évoluer sans faire échouer la suite d'hygiène.
        return [];
      }
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        const nested = await collectFiles(entryPath);
        files.push(...nested);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(extension)) {
          files.push(entryPath);
        }
      }
    }
    return files;
  }

  it("contains no TODO or FIXME comment markers", async () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];

    for (const directory of DIRECTORIES_TO_SCAN) {
      const candidateFiles = await collectFiles(directory);
      for (const relativePath of candidateFiles) {
        const absolutePath = path.resolve(repoRoot, relativePath);
        const normalizedRelativePath = normalizeRelativePath(relativePath);
        if (todoAllowlist.has(normalizedRelativePath)) {
          continue;
        }
        const content = await readFile(absolutePath, "utf8");
        const matches = content.matchAll(COMMENT_MARKER_PATTERN);
        for (const match of matches) {
          const index = match.index ?? 0;
          const line = content.slice(0, index).split(/\r?\n/).length;
          offenders.push({ file: relativePath, line, snippet: match[0] });
        }
      }
    }

    const diagnostic = offenders
      .map((offender) => `${offender.file}:${offender.line} -> ${offender.snippet}`)
      .join("\n");
    expect(
      offenders,
      diagnostic.length > 0
        ? `Found forbidden TODO/FIXME markers:\n${diagnostic}`
        : "Unexpected TODO/FIXME marker detected",
    ).to.be.empty;
  });
});
