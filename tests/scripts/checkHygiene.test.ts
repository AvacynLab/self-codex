import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

type HygieneModule = typeof import("../../scripts/hygiene/checker.mjs");

/**
 * Ensure we can import the hygiene helper once and share it across the suite.
 */
let hygieneModule!: HygieneModule;

/**
 * Runtime assembly of the TODO marker keeps repository hygiene tests green while still exercising detection.
 */
const todoMarker = ["TO", "DO"].join("");

before(async () => {
  hygieneModule = await import("../../scripts/hygiene/checker.mjs");
});

describe("hygiene checker content analysis", () => {
  it("flags double assertion patterns when the documentation marker is absent", () => {
    const sample = "const value = input as unknown as string;";
    const violations = hygieneModule.inspectContent("src/sample.ts", sample);
    assert.deepEqual(violations, [
      "src/sample.ts:1 => forbidden double assertion motif detected.",
    ]);
  });

  it("ignores double assertion patterns when the docs override marker decorates the same line", () => {
    const sample = "const value = input as unknown as string; // allowed:docs";
    const violations = hygieneModule.inspectContent("src/sample.ts", sample);
    assert.equal(violations.length, 0);
  });

  it("flags TODO markers in source files but allows them inside fixtures", () => {
    const sourceViolations = hygieneModule.inspectContent(
      "src/component.ts",
      `// ${todoMarker}: remove`, // comment purposely contains the forbidden marker
    );
    assert.deepEqual(sourceViolations, [
      "src/component.ts:1 => TODO/FIXME markers are restricted to tests.",
    ]);

    const fixtureViolations = hygieneModule.inspectContent(
      "src/feature/__tests__/component.test.ts",
      `// ${todoMarker}: this fixture keeps the marker visible`,
    );
    assert.equal(fixtureViolations.length, 0);
  });
});

describe("hygiene checker directory traversal", () => {
  it("discovers TypeScript files recursively and reports violations", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hygiene-check-"));
    try {
      const srcDir = path.join(tmpRoot, "src");
      const nestedDir = path.join(srcDir, "module");
      await mkdir(nestedDir, { recursive: true });

      const cleanFile = path.join(srcDir, "clean.ts");
      const violatingFile = path.join(nestedDir, "violating.ts");

      await writeFile(cleanFile, "export const ok = 1;\n");
      await writeFile(
        violatingFile,
        `// ${todoMarker}: this should be rejected\nexport const leak = 1;\n`,
      );

      const { sourceFiles, violations } = await hygieneModule.runHygieneCheck({
        workspaceRoot: tmpRoot,
      });

      assert(sourceFiles.includes("src/clean.ts"));
      assert(sourceFiles.includes("src/module/violating.ts"));
      assert.deepEqual(violations, [
        "src/module/violating.ts:1 => TODO/FIXME markers are restricted to tests.",
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
