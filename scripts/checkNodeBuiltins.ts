/**
 * @fileoverview Custom lint check ensuring all Node.js builtin imports explicitly use the `node:` prefix.
 * The script scans TypeScript sources and fails when a builtin module is imported without the recommended prefix.
 */

import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readdir, stat } from "node:fs/promises";
import ts from "typescript";

/**
 * Normalised list of builtin module names without the `node:` prefix.
 * The Node.js runtime exposes each builtin module both with and without the prefix in `module.builtinModules`;
 * we canonicalise to the bare name to make comparisons easier.
 */
const builtinModuleNames = new Set(
  builtinModules
    .map((name) => (name.startsWith("node:") ? name.slice("node:".length) : name))
    .filter((name) => !name.includes("/"))
);

/**
 * Recursively collect all files that satisfy the provided predicate.
 *
 * @param root Absolute or relative path serving as the traversal origin.
 * @param predicate Function deciding whether to include the file in the result set.
 * @returns Absolute file paths respecting the predicate.
 */
async function collectFiles(
  root: string,
  predicate: (entryPath: string) => boolean
): Promise<string[]> {
  const absoluteRoot = resolve(root);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(absoluteRoot, entry.name);

    if (entry.isDirectory()) {
      const nested = await collectFiles(entryPath, predicate);
      results.push(...nested);
      continue;
    }

    if (predicate(entryPath)) {
      results.push(entryPath);
    }
  }

  return results;
}

/**
 * Analyse a TypeScript source file and return the list of invalid builtin imports.
 *
 * @param filePath Absolute file path, used solely for diagnostics.
 * @param sourceText TypeScript source contents to analyse.
 * @returns Diagnostics describing each offending import.
 */
export function findInvalidBuiltinImports(
  filePath: string,
  sourceText: string
): Array<{ moduleName: string; line: number; column: number }> {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ESNext,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS
  );

  const diagnostics: Array<{ moduleName: string; line: number; column: number }> = [];

  const addDiagnostic = (node: ts.Node, moduleName: string) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({ moduleName, line: line + 1, column: character + 1 });
  };

  const checkModuleSpecifier = (node: ts.Node, moduleLiteral: ts.StringLiteralLike) => {
    const rawName = moduleLiteral.text;
    if (rawName.startsWith("node:")) {
      return;
    }

    if (builtinModuleNames.has(rawName)) {
      addDiagnostic(node, rawName);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      checkModuleSpecifier(node.moduleSpecifier, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (expr && ts.isStringLiteralLike(expr)) {
        checkModuleSpecifier(expr, expr);
      }
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        checkModuleSpecifier(node.arguments[0], node.arguments[0]);
      }

      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        checkModuleSpecifier(node.arguments[0], node.arguments[0]);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
}

/**
 * Execute the lint rule against every relevant TypeScript file in the project.
 */
export async function runNodeBuiltinCheck(): Promise<void> {
  const targets = ["src", "graph-forge/src"];
  const files: string[] = [];

  for (const target of targets) {
    try {
      const stats = await stat(target);
      if (!stats.isDirectory()) {
        continue;
      }
      const collected = await collectFiles(target, (entryPath) => entryPath.endsWith(".ts"));
      files.push(...collected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  const failures: Array<{ filePath: string; moduleName: string; line: number; column: number }> = [];

  await Promise.all(
    files.map(async (filePath) => {
      const contents = await readFile(filePath, "utf8");
      const diagnostics = findInvalidBuiltinImports(filePath, contents);
      diagnostics.forEach((diagnostic) => {
        failures.push({ filePath, ...diagnostic });
      });
    })
  );

  if (failures.length > 0) {
    console.error("Node builtin import lint failed. The following imports must use the `node:` prefix:\n");
    for (const failure of failures) {
      console.error(
        `${failure.filePath}:${failure.line}:${failure.column} — import from \"${failure.moduleName}\" should use \"node:${failure.moduleName}\"`
      );
    }
    console.error("\nUpdate the offending imports to include the `node:` prefix.");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(resolve("scripts/checkNodeBuiltins.ts")).href) {
  runNodeBuiltinCheck().catch((error) => {
    console.error("Unexpected error while running the Node builtin import check:", error);
    process.exitCode = 1;
  });
}
