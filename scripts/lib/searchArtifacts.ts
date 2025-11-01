import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  initialiseScenarioRun,
  type ScenarioRunPaths,
  type ValidationScenarioDefinition,
} from "../../src/validationRun/scenario.js";

/**
 * Structured payload persisted for a search validation scenario. The shape mirrors the
 * canonical artefacts mandated in `AGENTS.md` so every consumer (docs, dashboards, QA)
 * receives a consistent bundle under `validation_run/`.
 */
export interface SearchScenarioArtefactBundle {
  /** JSON payload describing the request executed during the run. */
  readonly input: unknown;
  /** Structured response returned by the pipeline or façade under test. */
  readonly response: unknown;
  /** Chronological list of orchestrator events emitted while executing the scenario. */
  readonly events: ReadonlyArray<Record<string, unknown>>;
  /** Timing summary derived from events/metrics (kept JSON serialisable). */
  readonly timings: Record<string, unknown>;
  /** Machine readable error taxonomy (empty array when the scenario succeeded). */
  readonly errors: ReadonlyArray<Record<string, unknown>>;
  /** Knowledge graph changes represented as plain objects and serialised as NDJSON. */
  readonly kgChanges: ReadonlyArray<Record<string, unknown>>;
  /** Vector memory upserts summarised for auditing and regression comparisons. */
  readonly vectorUpserts: ReadonlyArray<Record<string, unknown>>;
  /** Extract of the relevant server logs (may contain plain text). */
  readonly serverLog: string;
}

/** Options accepted when persisting search scenario artefacts. */
export interface PersistSearchScenarioOptions {
  /** Scenario definition used to derive the canonical folder slug. */
  readonly scenario: ValidationScenarioDefinition;
  /** Optional override for the `validation_run/` root. */
  readonly baseRoot?: string;
  /** Optional slug override when reusing the helper for ad-hoc runs (smoke/e2e). */
  readonly slugOverride?: string;
}

/**
 * Persists the provided artefact bundle under the canonical scenario directory. The
 * helper eagerly creates the scenario structure (input/response/events/timings/errors/
 * kg_changes/vector_upserts/server.log) so subsequent reruns simply overwrite the files
 * with fresh data. The implementation omits `undefined` values and always terminates
 * JSON files with a newline to keep diffs ergonomic.
 */
export async function persistSearchScenarioArtefacts(
  bundle: SearchScenarioArtefactBundle,
  options: PersistSearchScenarioOptions,
): Promise<ScenarioRunPaths> {
  const runPaths = await initialiseScenarioRun(options.scenario, {
    baseRoot: options.baseRoot,
    slugOverride: options.slugOverride,
    overwriteInput: true,
  });

  await writePrettyJson(runPaths.input, bundle.input);
  await writePrettyJson(runPaths.response, bundle.response);
  await writeNdjson(runPaths.events, bundle.events);
  await writePrettyJson(runPaths.timings, bundle.timings);
  await writePrettyJson(runPaths.errors, bundle.errors);
  await writeNdjson(runPaths.kgChanges, bundle.kgChanges);
  await writePrettyJson(runPaths.vectorUpserts, bundle.vectorUpserts);
  await writeServerLog(runPaths.serverLog, bundle.serverLog);

  return runPaths;
}

async function writePrettyJson(targetPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const serialised = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(targetPath, serialised, { encoding: "utf8" });
}

async function writeNdjson(
  targetPath: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  if (entries.length === 0) {
    await writeFile(targetPath, "", { encoding: "utf8" });
    return;
  }
  const lines = entries.map((entry) => JSON.stringify(entry));
  await writeFile(targetPath, `${lines.join("\n")}\n`, { encoding: "utf8" });
}

async function writeServerLog(targetPath: string, logContent: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const trimmed = logContent.endsWith("\n") ? logContent : `${logContent}\n`;
  await writeFile(targetPath, trimmed, { encoding: "utf8" });
}

/**
 * Reads and parses a JSON artefact produced by {@link persistSearchScenarioArtefacts}.
 * Mainly exported for the unit suite verifying the helper behaviour.
 */
export async function readJsonArtefact(targetPath: string): Promise<unknown> {
  const raw = await readFile(targetPath, "utf8");
  return JSON.parse(raw);
}

/** Convenience reader returning the NDJSON artefact as an array. */
export async function readNdjsonArtefact(targetPath: string): Promise<unknown[]> {
  const raw = await readFile(targetPath, "utf8");
  if (!raw.trim()) {
    return [];
  }
  return raw
    .trim()
    .split(/\n+/)
    .map((line) => JSON.parse(line));
}
