"use strict";

/**
 * Minimal runtime helpers used by the validation harness to manage the
 * filesystem layout and trace identifier generation.  The implementation mirrors
 * the historical TypeScript utilities that lived under
 * `validation_runs/20251007T184620Z/lib`, but the logic is intentionally kept in
 * plain JavaScript so it can be consumed directly by the Node-based scripts in
 * this repository.
 */
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * Ensures that all validation artefact sub-directories exist under the provided
 * run root.  Missing folders are created, whereas pre-existing ones are left
 * untouched so operators can keep manual notes between iterations.
 *
 * @param {string} runRoot absolute path to the validation run directory.
 * @returns {Promise<{inputs:string, outputs:string, events:string, logs:string, resources:string, report:string}>}
 */
export async function ensureRunDirectories(runRoot) {
  const directories = {
    inputs: join(runRoot, "inputs"),
    outputs: join(runRoot, "outputs"),
    events: join(runRoot, "events"),
    logs: join(runRoot, "logs"),
    resources: join(runRoot, "resources"),
    report: join(runRoot, "report"),
  };

  await Promise.all(
    Object.values(directories).map(async (dir) => {
      try {
        const stats = await stat(dir);
        if (!stats.isDirectory()) {
          throw new Error(`Path ${dir} exists but is not a directory`);
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          await mkdir(dir, { recursive: true });
          return;
        }
        throw error;
      }
    }),
  );

  return directories;
}

/**
 * Creates a deterministic trace identifier factory.  The helper derives a
 * reproducible SHA-256 digest from the provided seed combined with a monotonic
 * counter so retries can reuse the same trace identifier sequence.
 *
 * @param {string=} seed optional seed that keeps trace identifiers reproducible.
 * @returns {() => string} function returning a stable `trace-xxxxxxxx` string.
 */
export function createTraceIdFactory(seed = randomUUID()) {
  const sanitizedSeed = seed.replace(/[^a-zA-Z0-9_-]/g, "");
  let counter = 0;

  return () => {
    counter += 1;
    const hash = createHash("sha256");
    hash.update(sanitizedSeed);
    hash.update(":");
    hash.update(counter.toString(10));
    return `trace-${hash.digest("hex").slice(0, 32)}`;
  };
}

/**
 * Creates the validation run context shared across the harness.  The context
 * exposes the resolved directories and a trace identifier generator so stages
 * can record artefacts deterministically.
 *
 * @param {{runId:string, workspaceRoot:string, runRoot?:string, traceSeed?:string}} params
 * @returns {Promise<{runId:string, rootDir:string, directories:ReturnType<typeof ensureRunDirectories>, createTraceId:() => string}>}
 */
export async function createRunContext(params) {
  const runId = params.runId;
  const workspaceRoot = resolve(params.workspaceRoot);
  const rootDir = params.runRoot ? resolve(params.runRoot) : join(workspaceRoot, "validation_runs", runId);
  const directories = await ensureRunDirectories(rootDir);

  return {
    runId,
    rootDir,
    directories,
    createTraceId: createTraceIdFactory(params.traceSeed),
  };
}
