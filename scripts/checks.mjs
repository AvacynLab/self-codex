#!/usr/bin/env node
"use strict";

/**
 * Aggregated developer experience checks. The script orchestrates the builtin
 * import lint, scans for unused runtime dependencies, and enforces bundle size
 * limits so the orchestrator remains lean.
 */
import { spawn } from "node:child_process";
import { readFile, stat, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import process from "node:process";

const ROOT_DIR = resolve(process.cwd());
const NODE_BIN = process.execPath;
const NODE_BUILTIN_SCRIPT = resolve(ROOT_DIR, "scripts", "checkNodeBuiltins.ts");
const SOURCE_DIRECTORIES = ["src", "scripts", "graph-forge/src"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const BUNDLE_LIMITS = [
  { path: "dist/server.js", maxBytes: 5 * 1024 * 1024 },
  { path: "graph-forge/dist/index.js", maxBytes: 3 * 1024 * 1024 },
];
const DEPENDENCY_ALLOWLIST = new Set(["@types/node"]);

async function runNodeBuiltinCheck() {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(NODE_BIN, ["--import", "tsx", NODE_BUILTIN_SCRIPT], {
      stdio: "inherit",
      cwd: ROOT_DIR,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (typeof code === "number" && code === 0) {
        resolvePromise();
        return;
      }
      const reason = typeof code === "number" ? `exit code ${code}` : `signal ${signal ?? "unknown"}`;
      rejectPromise(new Error(`Node builtin import check failed (${reason})`));
    });
  });
}

async function collectFiles(directory) {
  const absoluteDir = resolve(ROOT_DIR, directory);
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch((error) => {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
    const entryPath = resolve(ROOT_DIR, relativePath);
    if (entry.isDirectory()) {
      const nested = await collectFiles(relativePath);
      files.push(...nested);
      continue;
    }
    if (SCANNED_EXTENSIONS.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function dependencyReferenced(contents, dependency) {
  if (contents.includes(`"${dependency}`) || contents.includes(`'${dependency}`)) {
    return true;
  }
  if (contents.includes(`${dependency}/`)) {
    return true;
  }
  return false;
}

async function checkDependencies() {
  const pkg = JSON.parse(await readFile(resolve(ROOT_DIR, "package.json"), "utf8"));
  const dependencies = Object.keys(pkg.dependencies ?? {});
  const usage = new Map();
  dependencies.forEach((dep) => usage.set(dep, false));

  const targets = await Promise.all(SOURCE_DIRECTORIES.map((dir) => collectFiles(dir)));
  const files = targets.flat();

  for (const filePath of files) {
    const contents = await readFile(filePath, "utf8");
    for (const dep of dependencies) {
      if (usage.get(dep)) {
        continue;
      }
      if (dependencyReferenced(contents, dep)) {
        usage.set(dep, true);
      }
    }
  }

  const unused = dependencies.filter((dep) => !usage.get(dep) && !DEPENDENCY_ALLOWLIST.has(dep));
  if (unused.length > 0) {
    throw new Error(`Unused runtime dependencies detected: ${unused.join(", ")}`);
  }
}

async function checkBundleSizes() {
  const violations = [];
  for (const { path, maxBytes } of BUNDLE_LIMITS) {
    const absolute = resolve(ROOT_DIR, path);
    try {
      const stats = await stat(absolute);
      if (stats.size > maxBytes) {
        violations.push(`${path} (${stats.size} bytes, limit ${maxBytes} bytes)`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        violations.push(`${path} is missing (build artefact required)`);
        continue;
      }
      throw error;
    }
  }
  if (violations.length > 0) {
    throw new Error(`Bundle size check failed:\n - ${violations.join("\n - ")}`);
  }
}

async function main() {
  await runNodeBuiltinCheck();
  await checkDependencies();
  await checkBundleSizes();
  console.log("All DX checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
