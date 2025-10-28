import { writeFile } from "node:fs/promises";

import {
  initialiseScenarioRun,
  resolveScenarioById,
  type ScenarioRunPaths,
} from "./scenario.js";
import { type ValidationRunLayout } from "./layout.js";

/**
 * Identifies the supported timing buckets collected for each scenario. Every
 * bucket captures the p50/p95/p99 latency in milliseconds, mirroring the
 * checklist requirements.
 */
export interface ScenarioTimingBucket {
  /** Median latency (p50) captured in milliseconds. */
  readonly p50: number;
  /** High percentile latency (p95) captured in milliseconds. */
  readonly p95: number;
  /** Tail latency (p99) captured in milliseconds. */
  readonly p99: number;
}

/**
 * Timing report persisted to `timings.json`. The structure is intentionally
 * explicit so operators can quickly eyeball the critical steps for each run.
 */
export interface ScenarioTimingReport {
  /** Aggregated latencies for the Searx query stage. */
  readonly searxQuery: ScenarioTimingBucket;
  /** Aggregated latencies for the HTTP fetch stage. */
  readonly fetchUrl: ScenarioTimingBucket;
  /** Latencies captured while processing documents through Unstructured. */
  readonly extractWithUnstructured: ScenarioTimingBucket;
  /** Latencies observed while writing to the knowledge graph. */
  readonly ingestToGraph: ScenarioTimingBucket;
  /** Latencies observed while writing to the vector index. */
  readonly ingestToVector: ScenarioTimingBucket;
  /** Total time spent for the scenario execution (milliseconds). */
  readonly tookMs: number;
  /** Number of documents successfully ingested. */
  readonly documentsIngested: number;
  /**
   * Aggregated error counters keyed by taxonomy category
   * (`network_error`, `robots_denied`, ...).
   */
  readonly errors: Record<string, number>;
}

/**
 * Structured representation of the `errors.json` artefact. Each entry documents
 * the classification, context and failure mode encountered during the scenario.
 */
export interface ScenarioErrorEntry {
  /** Taxonomy key (network_error, robots_denied, ...). */
  readonly category: string;
  /** Optional human readable description. */
  readonly message?: string;
  /** Optional URL that triggered the failure. */
  readonly url?: string;
  /** Additional metadata useful for debugging (HTTP status, engine, ...). */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Parameters accepted when persisting artefacts for a scenario. Operators can
 * selectively provide the files they collected during the execution.
 */
export interface ScenarioArtefactPayload {
  /** Optional override for the canonical input payload. */
  readonly input?: unknown;
  /** Tool response returned by the orchestrator. */
  readonly response?: unknown;
  /** Event store export serialised as discrete JSON objects. */
  readonly events?: ReadonlyArray<Record<string, unknown>>;
  /** Per-step timing metrics matching {@link ScenarioTimingReport}. */
  readonly timings?: ScenarioTimingReport;
  /** Structured error taxonomy for the scenario. */
  readonly errors?: ReadonlyArray<ScenarioErrorEntry>;
  /** Knowledge graph diff entries written as plain JSON objects. */
  readonly kgChanges?: ReadonlyArray<Record<string, unknown>>;
  /** Vector store upsert summaries. */
  readonly vectorUpserts?: ReadonlyArray<Record<string, unknown>>;
  /** Extract of the server log covering the scenario window. */
  readonly serverLog?: string | ReadonlyArray<string>;
}

/**
 * Options controlling how the recorder resolves the validation layout and
 * scenario definition.
 */
export interface RecordScenarioRunOptions {
  /** Optional precomputed layout to avoid hitting the filesystem twice. */
  readonly layout?: ValidationRunLayout;
  /** Optional base root forwarded to the scenario initialiser. */
  readonly baseRoot?: string;
}

/**
 * Persists the artefacts collected for the provided scenario. The helper is
 * idempotent: each call rewrites the target files with the provided data,
 * making it straightforward to re-run a scenario and update the outputs.
 */
export async function recordScenarioRun(
  scenarioId: number,
  artefacts: ScenarioArtefactPayload,
  options: RecordScenarioRunOptions = {},
): Promise<ScenarioRunPaths> {
  const scenario = resolveScenarioById(scenarioId);
  const runPaths = await initialiseScenarioRun(scenario, options);

  if (artefacts.input !== undefined) {
    await writeJson(runPaths.input, artefacts.input);
  }
  if (artefacts.response !== undefined) {
    await writeJson(runPaths.response, artefacts.response);
  }
  if (artefacts.events !== undefined) {
    await writeNdjson(runPaths.events, artefacts.events);
  }
  if (artefacts.timings !== undefined) {
    await writeJson(runPaths.timings, artefacts.timings);
  }
  if (artefacts.errors !== undefined) {
    await writeJson(runPaths.errors, artefacts.errors);
  }
  if (artefacts.kgChanges !== undefined) {
    await writeNdjson(runPaths.kgChanges, artefacts.kgChanges);
  }
  if (artefacts.vectorUpserts !== undefined) {
    await writeJson(runPaths.vectorUpserts, artefacts.vectorUpserts);
  }
  if (artefacts.serverLog !== undefined) {
    await writeServerLog(runPaths.serverLog, artefacts.serverLog);
  }

  return runPaths;
}

/** Serialises the payload to prettified JSON with a trailing newline. */
async function writeJson(targetPath: string, payload: unknown): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
  });
}

/**
 * Serialises an array of objects to newline-delimited JSON. Empty arrays produce
 * an empty file to preserve the semantics of "no events recorded".
 */
async function writeNdjson(
  targetPath: string,
  items: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const lines = items.map((item) => JSON.stringify(item));
  const serialised = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await writeFile(targetPath, serialised, { encoding: "utf8" });
}

/**
 * Normalises the server log payload before writing it to disk. Both raw strings
 * and string arrays are accepted to simplify CLI integrations.
 */
async function writeServerLog(
  targetPath: string,
  payload: string | ReadonlyArray<string>,
): Promise<void> {
  const content = Array.isArray(payload) ? payload.join("\n") : payload;
  const withTrailingNewline = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(targetPath, withTrailingNewline, { encoding: "utf8" });
}

