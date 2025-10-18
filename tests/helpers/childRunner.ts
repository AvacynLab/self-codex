import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import ts from "typescript";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const compiledFixturesDir = join(projectRoot, "tmp", "compiled-fixtures");

mkdirSync(compiledFixturesDir, { recursive: true });

/**
 * Resolve a fixture path relative to the current test module using
 * `import.meta.url`. The helper keeps the relative URLs co-located with the
 * caller which avoids surprising path traversal when tests move between
 * directories.
 */
export function resolveFixture(metaUrl: string, relativePath: string): string {
  return fileURLToPath(new URL(relativePath, metaUrl));
}

function compileFixture(sourcePath: string): string {
  const sourceStat = statSync(sourcePath);
  const outputPath = join(
    compiledFixturesDir,
    `${basename(sourcePath, ".ts")}.mjs`,
  );

  const needsRecompile = !existsSync(outputPath)
    || statSync(outputPath).mtimeMs < sourceStat.mtimeMs;

  if (needsRecompile) {
    const source = readFileSync(sourcePath, "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        sourceMap: false,
      },
      fileName: sourcePath,
    });
    const header = `// Auto-generated from ${sourcePath} for sandboxed execution\n`;
    writeFileSync(outputPath, header + transpiled.outputText, "utf8");
  }

  return outputPath;
}

/**
 * Build the command-line arguments required to execute a TypeScript child
 * runner. The helper compiles the fixture to an isolated ES module so the
 * sandboxed runtime does not depend on the `tsx` loader, which attempts to
 * access network primitives.
 */
export function runnerArgs(fixturePath: string, ...rest: string[]): string[] {
  const compiledPath = compileFixture(fixturePath);
  return [compiledPath, ...rest];
}

