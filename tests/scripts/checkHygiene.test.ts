import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

type HygieneModule = typeof import("../../scripts/hygiene/checker.mjs");

/**
 * Ensure we can import the hygiene helper once and share it across the suite.
 */
let hygieneModule!: HygieneModule;
const execFileAsync = promisify(execFile);

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

  it("respects the explicit TODO allowlist for sanctioned files", () => {
    const literalTodo = `// ${todoMarker}: readability matters`;

    const allowlistedViolations = hygieneModule.inspectContent(
      "src/agents/__tests__/selfReflect.fixtures.ts",
      literalTodo,
      {
        todoAllowlist: ["src/agents/__tests__/selfReflect.fixtures.ts"],
      },
    );
    assert.equal(allowlistedViolations.length, 0);

    const unlistedViolations = hygieneModule.inspectContent(
      "src/agents/selfReflect.ts",
      literalTodo,
    );
    assert.deepEqual(unlistedViolations, [
      "src/agents/selfReflect.ts:1 => TODO/FIXME markers are restricted to tests.",
    ]);
  });

  it("normalizes allowlist entries containing Windows separators", () => {
    const literalTodo = `// ${todoMarker}: keep parity with production diagnostics`;
    const violations = hygieneModule.inspectContent(
      "src/agents/__tests__/selfReflect.fixtures.ts",
      literalTodo,
      {
        todoAllowlist: ["src\\agents\\__tests__\\selfReflect.fixtures.ts"],
      },
    );
    assert.equal(violations.length, 0);
  });

  it("ignores invalid TODO allowlist entries when constructing sets", () => {
    const allowlist = hygieneModule.createTodoAllowlistSet([
      "src/agents/__tests__/selfReflect.fixtures.ts",
      "../escape.ts",
      "",
      "src/agents/__tests__/selfReflect.fixtures.ts",
    ]);
    assert.deepEqual(Array.from(allowlist), ["src/agents/__tests__/selfReflect.fixtures.ts"]);
  });
});

describe("todo allowlist normalization", () => {
  it("rejects absolute and escaping entries", () => {
    const relativeResult = hygieneModule.normalizeAllowlistEntry(" ./src/fixture.ts ");
    assert(relativeResult.ok);
    assert.equal(relativeResult.value, "src/fixture.ts");

    const absoluteResult = hygieneModule.normalizeAllowlistEntry("/etc/passwd");
    assert(!absoluteResult.ok);
    assert.equal(absoluteResult.reason, hygieneModule.allowlistNormalizationFailures.ABSOLUTE);

    const escapingResult = hygieneModule.normalizeAllowlistEntry("../outside.ts");
    assert(!escapingResult.ok);
    assert.equal(escapingResult.reason, hygieneModule.allowlistNormalizationFailures.ESCAPES);
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

      assert.deepEqual(sourceFiles, ["src/clean.ts", "src/module/violating.ts"]);
      assert.deepEqual(violations, [
        "src/module/violating.ts:1 => TODO/FIXME markers are restricted to tests.",
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Validate the CLI wrapper refuses stale allowlist entries and honours normalized paths.
 */
describe("checkHygiene CLI configuration validation", () => {
  it("fails fast when the allowlist references a missing file", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hygiene-cli-"));
    try {
      const scriptsDir = path.join(tmpRoot, "scripts");
      const hygieneDir = path.join(scriptsDir, "hygiene");
      const configDir = path.join(tmpRoot, "config");
      const srcDir = path.join(tmpRoot, "src");
      await mkdir(hygieneDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(srcDir, { recursive: true });

      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const scriptSource = await readFile(path.join(repoRoot, "scripts", "checkHygiene.mjs"), "utf8");
      const checkerSource = await readFile(path.join(repoRoot, "scripts", "hygiene", "checker.mjs"), "utf8");
      await writeFile(path.join(scriptsDir, "checkHygiene.mjs"), scriptSource);
      await writeFile(path.join(hygieneDir, "checker.mjs"), checkerSource);

      const configPath = path.join(configDir, "hygiene.config.json");
      const configContent = {
        todoAllowlist: ["src/non-existent-fixture.ts"],
      };
      await writeFile(configPath, `${JSON.stringify(configContent, null, 2)}\n`);
      await writeFile(path.join(srcDir, "entry.ts"), "export const keepBuildGreen = 1;\n");

      try {
        await execFileAsync(process.execPath, [path.join(scriptsDir, "checkHygiene.mjs")], {
          cwd: tmpRoot,
        });
        assert.fail("Expected hygiene check to fail when allowlist file is missing");
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        assert.ok(failure.stderr?.includes("Allowlist entry does not resolve to a file"));
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects allowlist entries attempting to escape the repository", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hygiene-cli-escape-"));
    try {
      const scriptsDir = path.join(tmpRoot, "scripts");
      const hygieneDir = path.join(scriptsDir, "hygiene");
      const configDir = path.join(tmpRoot, "config");
      const srcDir = path.join(tmpRoot, "src");
      await mkdir(srcDir, { recursive: true });
      await mkdir(hygieneDir, { recursive: true });
      await mkdir(configDir, { recursive: true });

      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const scriptSource = await readFile(path.join(repoRoot, "scripts", "checkHygiene.mjs"), "utf8");
      const checkerSource = await readFile(path.join(repoRoot, "scripts", "hygiene", "checker.mjs"), "utf8");
      await writeFile(path.join(scriptsDir, "checkHygiene.mjs"), scriptSource);
      await writeFile(path.join(hygieneDir, "checker.mjs"), checkerSource);

      const configPath = path.join(configDir, "hygiene.config.json");
      const configContent = {
        todoAllowlist: ["../malicious-fixture.ts"],
      };
      await writeFile(configPath, `${JSON.stringify(configContent, null, 2)}\n`);

      await writeFile(path.join(srcDir, "entry.ts"), "export const keepBuildGreen = 1;\n");

      try {
        await execFileAsync(process.execPath, [path.join(scriptsDir, "checkHygiene.mjs")], {
          cwd: tmpRoot,
        });
        assert.fail("Expected hygiene check to fail when allowlist escapes workspace");
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        assert.ok(failure.stderr?.includes("escapes the workspace boundaries"));
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("accepts normalized allowlist paths pointing to fixtures", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hygiene-cli-pass-"));
    try {
      const scriptsDir = path.join(tmpRoot, "scripts");
      const hygieneDir = path.join(scriptsDir, "hygiene");
      const configDir = path.join(tmpRoot, "config");
      const fixtureDir = path.join(tmpRoot, "src", "agents", "__tests__");
      await mkdir(fixtureDir, { recursive: true });
      await mkdir(hygieneDir, { recursive: true });
      await mkdir(configDir, { recursive: true });

      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const scriptSource = await readFile(path.join(repoRoot, "scripts", "checkHygiene.mjs"), "utf8");
      const checkerSource = await readFile(path.join(repoRoot, "scripts", "hygiene", "checker.mjs"), "utf8");
      await writeFile(path.join(scriptsDir, "checkHygiene.mjs"), scriptSource);
      await writeFile(path.join(hygieneDir, "checker.mjs"), checkerSource);

      const fixturePath = path.join(fixtureDir, "selfReflect.fixtures.ts");
      await writeFile(
        fixturePath,
        `// ${todoMarker}: fixture replicates production backlog\nexport const sample = true;\n`,
      );

      const configPath = path.join(configDir, "hygiene.config.json");
      const configContent = {
        todoAllowlist: ["src\\agents\\__tests__\\selfReflect.fixtures.ts"],
      };
      await writeFile(configPath, `${JSON.stringify(configContent, null, 2)}\n`);

      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(scriptsDir, "checkHygiene.mjs")], {
        cwd: tmpRoot,
      });
      assert.equal(stderr, "");
      assert.ok(stdout.includes("Hygiene check passed"));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
