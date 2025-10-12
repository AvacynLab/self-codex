// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/**
 * Stage 4 validation helpers covering the Graph Forge tooling and graph state
 * autosave workflow. The module exposes a reusable runner invoked by the CLI so
 * operators can persist artefacts within the canonical validation layout
 * described in AGENTS.md.  The implementation mirrors the existing phase
 * runners (introspection, log stimulus, transactions) while remaining focused on
 * the tasks listed under "Outils graph forge / analyse".
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckArtefactTargets,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
} from "./runSetup.js";
import { ensureDirectory } from "../paths.js";

/** Relative JSONL targets dedicated to the Graph Forge validation workflow. */
export const GRAPH_FORGE_JSONL_FILES = {
  inputs: "inputs/04_forge.jsonl",
  outputs: "outputs/04_forge.jsonl",
  events: "events/04_forge.jsonl",
  log: "logs/graph_forge_http.json",
} as const;

/** Internal artefact routing helper shared by every JSON-RPC call. */
const GRAPH_FORGE_TARGETS: HttpCheckArtefactTargets = {
  inputs: GRAPH_FORGE_JSONL_FILES.inputs,
  outputs: GRAPH_FORGE_JSONL_FILES.outputs,
};

/** Directory (relative to the run root) storing DSL sources and summaries. */
const GRAPH_FORGE_ARTIFACT_DIR = "artifacts/forge";

/** Filenames persisted by the runner for traceability. */
const GRAPH_FORGE_DSL_FILENAME = "sample_pipeline.gf";
const GRAPH_FORGE_ANALYSIS_FILENAME = "analysis_result.json";
const GRAPH_FORGE_AUTOSAVE_FILENAME = "autosave_snapshot.json";
const GRAPH_FORGE_AUTOSAVE_SUMMARY = "autosave_summary.json";

/** Event type recorded when the autosave stream is confirmed quiescent. */
const GRAPH_FORGE_AUTOSAVE_QUIESCENCE_EVENT = "autosave.quiescence";

/**
 * Shape describing the textual content captured for each autosave tick. The
 * samples are written to `events/04_forge.jsonl` so operators can inspect the
 * cadence without opening the summary document.
 */
export interface AutosaveTickSample {
  /** Timestamp (ISO8601) when the validation runner captured the observation. */
  readonly capturedAt: string;
  /** Timestamp persisted by the autosave tool inside the JSON payload. */
  readonly savedAt: string | null;
  /** Size of the autosave file when the observation was taken (bytes). */
  readonly fileSize: number;
}

/** Options accepted by {@link observeAutosaveTicks}. */
export interface AutosaveObservationOptions {
  /** Minimum number of distinct tick snapshots required before resolving. */
  readonly requiredTicks?: number;
  /** Polling cadence (milliseconds) while waiting for the autosave file. */
  readonly pollIntervalMs?: number;
  /** Timeout (milliseconds) after which the observer gives up. */
  readonly timeoutMs?: number;
}

/** Behavioural knobs used when verifying that autosave stops emitting ticks. */
export interface AutosaveQuiescenceOptions {
  /** Polling cadence (milliseconds) while checking the autosave artefact. */
  readonly pollIntervalMs?: number;
  /**
   * Duration (milliseconds) over which the checker must observe a stable state.
   * The window defaults to a multiple of the observation poll interval so short
   * fluctuations are smoothed out before raising an error.
   */
  readonly durationMs?: number;
}

/**
 * Result returned by {@link observeAutosaveTicks}. The structure is persisted
 * as JSON so operators can compare the theoretical autosave interval with the
 * effective cadence observed locally.
 */
export interface AutosaveObservationResult {
  /** Absolute path inspected on disk. */
  readonly path: string;
  /** Number of unique tick snapshots requested by the operator. */
  readonly requiredTicks: number;
  /** Number of distinct ticks actually captured before completing. */
  readonly observedTicks: number;
  /** Total wall-clock time spent waiting for ticks (milliseconds). */
  readonly durationMs: number;
  /** Whether the observer collected the requested number of ticks. */
  readonly completed: boolean;
  /** Optional error message captured during the last polling iteration. */
  readonly lastError?: string;
  /** Detailed samples written to the events JSONL artefact. */
  readonly samples: AutosaveTickSample[];
}

/** Summary describing the quiescence check executed after stopping autosave. */
export interface AutosaveQuiescenceResult {
  /** Autosave artefact monitored on disk. */
  readonly path: string;
  /** Expected timestamp captured during the last observed autosave tick. */
  readonly expectedSavedAt: string | null;
  /** Latest timestamp read while verifying that the autosave stream stopped. */
  readonly observedSavedAt: string | null;
  /** Size of the autosave file during the final verification attempt. */
  readonly observedFileSize: number | null;
  /** Total time spent checking for additional ticks (milliseconds). */
  readonly durationMs: number;
  /** Number of polling attempts performed during the quiescence check. */
  readonly attempts: number;
  /** Poll interval applied between consecutive checks (milliseconds). */
  readonly pollIntervalMs: number;
  /** Whether the artefact remained stable throughout the verification window. */
  readonly verified: boolean;
  /** Whether the autosave artefact disappeared (treated as quiescent). */
  readonly fileMissing: boolean;
  /** Optional diagnostic captured when filesystem access returned an error. */
  readonly lastError?: string;
}

/**
 * Configuration accepted by {@link runGraphForgePhase}. Callers may override
 * the autosave path, interval, or observation strategy to accommodate bespoke
 * environments (for example when the validation run lives outside the workspace
 * root during automated tests).
 */
export interface GraphForgePhaseOptions {
  /** Absolute path of the workspace root (defaults to `process.cwd()`). */
  readonly workspaceRoot?: string;
  /** Custom relative path (from `workspaceRoot`) for the autosave artefact. */
  readonly autosaveRelativePath?: string;
  /** Autosave interval forwarded to the MCP tool (milliseconds). */
  readonly autosaveIntervalMs?: number;
  /** Behavioural tuning for the autosave observer. */
  readonly autosaveObservation?: AutosaveObservationOptions;
  /** Behavioural tuning for the post-stop quiescence verification. */
  readonly autosaveQuiescence?: AutosaveQuiescenceOptions;
  /**
   * Dependency injection hook used by tests to simulate autosave ticks without
   * relying on a running server.
   */
  readonly autosaveObserver?: (
    path: string,
    options: AutosaveObservationOptions,
  ) => Promise<AutosaveObservationResult>;
}

/**
 * Captures the essential artefact locations generated by the Graph Forge
 * workflow so callers can surface them in CLI summaries.
 */
export interface GraphForgePhaseResult {
  /** Snapshot describing the Graph Forge analysis request/response. */
  readonly analysis: {
    /** HTTP metadata captured for the `graph_forge_analyze` invocation. */
    readonly check: HttpCheckSnapshot;
    /** Absolute path of the persisted DSL script for reproducibility. */
    readonly dslPath: string;
    /** Absolute path of the parsed analysis report. */
    readonly resultPath: string;
  };
  /** Snapshot describing the autosave lifecycle. */
  readonly autosave: {
    /** HTTP metadata captured for the `graph_state_autosave` start call. */
    readonly start: HttpCheckSnapshot;
    /** HTTP metadata captured for the `graph_state_autosave` stop call. */
    readonly stop: HttpCheckSnapshot;
    /** Relative path (workspace-root based) advertised to the MCP tool. */
    readonly relativePath: string;
    /** Absolute path monitored on disk by the observer. */
    readonly absolutePath: string;
    /** Autosave cadence observation captured during the run. */
    readonly observation: AutosaveObservationResult;
    /** Result of the quiescence verification executed after stopping autosave. */
    readonly quiescence: AutosaveQuiescenceResult;
    /** Absolute path of the persisted summary JSON document. */
    readonly summaryPath: string;
  };
}

/**
 * Builds the sample Graph Forge DSL used during validation. The pipeline keeps
 * the structure compact (three stages) yet exercises both the DSL compiler and
 * the bundled analyses to ensure the server returns a rich payload.
 */
function buildSampleGraphForgeScript(): { source: string; entryGraph: string } {
  const entryGraph = "ValidationPipeline";
  const source = [
    `graph ${entryGraph} {`,
    "  directive allowCycles false;",
    "  node Fetch    { label: \"Fetch dependencies\" cost: 2 }",
    "  node Build    { label: \"Compile\" cost: 3 }",
    "  node Test     { label: \"Test suite\" cost: 1 }",
    "  edge Fetch -> Build { weight: 1 }",
    "  edge Build -> Test  { weight: 1 }",
    "  @analysis shortestPath Fetch Test;",
    "  @analysis criticalPath;",
    "}",
  ].join("\n");
  return { source, entryGraph };
}

/** Lightweight helper ensuring asynchronous waits remain readable. */
async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Extracts the `result` property from a JSON-RPC response when present. The
 * helper tolerates unexpected envelopes by returning `null` instead of throwing
 * so callers can persist diagnostic payloads verbatim.
 */
function extractJsonRpcResult(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const candidate = (body as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  return candidate as Record<string, unknown>;
}

/**
 * Retrieves the first textual content entry exposed by a MCP tool response.
 * Many tools return a single JSON blob encoded as a string; by extracting the
 * content we can parse it into structured artefacts for the operator.
 */
function extractFirstTextContent(result: Record<string, unknown>): string | null {
  const content = result.content;
  if (!Array.isArray(content)) {
    return null;
  }

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      return typed.text;
    }
  }

  return null;
}

/**
 * Derives the autosave target relative to the workspace root. When the
 * validation run lives outside of the workspace the helper throws so callers
 * can provide an explicit override.
 */
function resolveAutosaveRelativePath(
  workspaceRoot: string,
  autosaveAbsolute: string,
): string {
  const relativePath = relative(workspaceRoot, autosaveAbsolute);
  if (relativePath.startsWith("..") || relativePath.includes(":")) {
    throw new Error(
      `Unable to derive autosave path: ${autosaveAbsolute} is outside the workspace root ${workspaceRoot}`,
    );
  }
  const normalised = relativePath.split(sep).filter(Boolean).join("/");
  if (!normalised) {
    throw new Error("Autosave relative path resolved to an empty string");
  }
  return normalised;
}

/**
 * Normalises a caller provided relative path. The helper strips duplicate
 * separators, rejects directory traversal, and returns a POSIX-style path so
 * the value can be forwarded directly to the MCP HTTP endpoint.
 */
function sanitiseRelativePath(candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error("autosave relative path must not be empty");
  }

  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error("autosave relative path must not contain '..'");
    }
  }

  return segments.join("/");
}

/**
 * Polls the autosave file until the requested number of ticks have been
 * observed or the timeout expires. The function records distinct `saved_at`
 * timestamps and surfaces the samples so they can be appended to the events
 * JSONL artefact.
 */
export async function observeAutosaveTicks(
  autosavePath: string,
  options: AutosaveObservationOptions = {},
): Promise<AutosaveObservationResult> {
  const requiredTicks = Math.max(options.requiredTicks ?? 2, 1);
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? 250, 50);
  const timeoutMs = Math.max(options.timeoutMs ?? requiredTicks * pollIntervalMs * 8, pollIntervalMs * 4);

  const samples: AutosaveTickSample[] = [];
  let lastSeenSavedAt: string | null = null;
  let lastError: string | undefined;

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs && samples.length < requiredTicks) {
    try {
      const content = await readFile(autosavePath, "utf8");
      const size = Buffer.byteLength(content, "utf8");
      const parsed = JSON.parse(content) as { metadata?: { saved_at?: unknown } };
      const savedAt = typeof parsed?.metadata?.saved_at === "string" ? parsed.metadata.saved_at : null;

      // Only record unique timestamps so a single snapshot does not satisfy the
      // "two ticks" requirement. The file is overwritten on every tick so the
      // value reflects the latest autosave time emitted by the server.
      if (savedAt && savedAt !== lastSeenSavedAt) {
        lastSeenSavedAt = savedAt;
        samples.push({ capturedAt: new Date().toISOString(), savedAt, fileSize: size });
      } else if (!savedAt && samples.length === 0) {
        // Record a placeholder sample when the metadata is missing so operators
        // can diagnose unexpected payloads.
        samples.push({ capturedAt: new Date().toISOString(), savedAt: null, fileSize: size });
      }

      lastError = undefined;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code !== "ENOENT") {
        lastError = error instanceof Error ? error.message : String(error);
      } else {
        lastError = "ENOENT";
      }
    }

    if (samples.length >= requiredTicks) {
      break;
    }

    await delay(pollIntervalMs);
  }

  return {
    path: autosavePath,
    requiredTicks,
    observedTicks: samples.length,
    durationMs: Date.now() - startedAt,
    completed: samples.length >= requiredTicks,
    lastError,
    samples,
  };
}

/**
 * Persists the captured autosave tick samples into the phase-specific events
 * JSONL file so the operator can review them alongside other telemetry.
 */
async function appendAutosaveEvents(
  runRoot: string,
  samples: AutosaveTickSample[],
): Promise<void> {
  if (!samples.length) {
    return;
  }

  const payload = samples
    .map((sample, index) =>
      toJsonlLine({
        type: "autosave.tick",
        index,
        capturedAt: sample.capturedAt,
        savedAt: sample.savedAt,
        fileSize: sample.fileSize,
      }),
    )
    .join("");

  await writeFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/**
 * Appends the quiescence verification outcome to the shared events JSONL file
 * so operators can confirm that autosave stopped producing ticks after the
 * `stop` request completed.
 */
async function appendAutosaveQuiescenceEvent(
  runRoot: string,
  result: AutosaveQuiescenceResult,
): Promise<void> {
  const payload = toJsonlLine({
    type: GRAPH_FORGE_AUTOSAVE_QUIESCENCE_EVENT,
    path: result.path,
    expectedSavedAt: result.expectedSavedAt,
    observedSavedAt: result.observedSavedAt,
    observedFileSize: result.observedFileSize,
    durationMs: result.durationMs,
    attempts: result.attempts,
    pollIntervalMs: result.pollIntervalMs,
    verified: result.verified,
    fileMissing: result.fileMissing,
    lastError: result.lastError ?? null,
  });

  await writeFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.events), payload, { encoding: "utf8", flag: "a" });
}

/**
 * Ensures the autosave artefact remains stable once the server acknowledges the
 * `stop` request. The helper polls the file for a short window and flags any
 * additional ticks or unexpected payload changes.
 */
export async function verifyAutosaveQuiescence(
  autosavePath: string,
  expectedSavedAt: string | null,
  options: AutosaveQuiescenceOptions = {},
): Promise<AutosaveQuiescenceResult> {
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? 250, 50);
  const durationLimit = Math.max(options.durationMs ?? pollIntervalMs * 6, pollIntervalMs);

  let observedSavedAt: string | null = null;
  let observedFileSize: number | null = null;
  let attempts = 0;
  let lastError: string | undefined;
  let fileMissing = false;
  let verified = true;

  const startedAt = Date.now();

  do {
    attempts += 1;
    try {
      const content = await readFile(autosavePath, "utf8");
      observedFileSize = Buffer.byteLength(content, "utf8");
      const parsed = JSON.parse(content) as { metadata?: { saved_at?: unknown } };
      observedSavedAt = typeof parsed?.metadata?.saved_at === "string" ? parsed.metadata.saved_at : null;
      fileMissing = false;
      lastError = undefined;

      if (observedSavedAt !== expectedSavedAt) {
        verified = false;
        break;
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === "ENOENT") {
        fileMissing = true;
        observedSavedAt = null;
        observedFileSize = null;
        lastError = "ENOENT";
      } else {
        lastError = error instanceof Error ? error.message : String(error);
        verified = false;
        break;
      }
    }

    if (Date.now() - startedAt >= durationLimit) {
      break;
    }
    await delay(pollIntervalMs);
  } while (Date.now() - startedAt < durationLimit);

  const durationMs = Date.now() - startedAt;

  return {
    path: autosavePath,
    expectedSavedAt,
    observedSavedAt,
    observedFileSize,
    durationMs,
    attempts,
    pollIntervalMs,
    verified,
    fileMissing,
    lastError,
  };
}

/**
 * Executes the Graph Forge validation workflow:
 *
 * 1. Calls `graph_forge_analyze` with a deterministic DSL snippet and persists
 *    the returned analysis under `artifacts/forge/`.
 * 2. Starts `graph_state_autosave`, waits for the configured number of ticks,
 *    writes the summary + events, then stops the autosave loop.
 */
export async function runGraphForgePhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: GraphForgePhaseOptions = {},
): Promise<GraphForgePhaseResult> {
  if (!runRoot) {
    throw new Error("runGraphForgePhase requires a run root directory");
  }
  if (!environment || !environment.baseUrl) {
    throw new Error("runGraphForgePhase requires a valid HTTP environment");
  }

  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const artifactsDir = await ensureDirectory(runRoot, ...GRAPH_FORGE_ARTIFACT_DIR.split("/"));

  const autosaveAbsoluteDefault = join(artifactsDir, GRAPH_FORGE_AUTOSAVE_FILENAME);
  const autosaveRelative = options.autosaveRelativePath
    ? sanitiseRelativePath(options.autosaveRelativePath)
    : resolveAutosaveRelativePath(workspaceRoot, autosaveAbsoluteDefault);

  const autosaveAbsolute = options.autosaveRelativePath
    ? join(workspaceRoot, ...autosaveRelative.split("/"))
    : autosaveAbsoluteDefault;

  // Ensure the parent directory exists so the autosave tool can write files
  // without racing with our observation logic. The runner mirrors the server
  // behaviour by creating the directory eagerly.
  await mkdir(dirname(autosaveAbsolute), { recursive: true });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const { source: dslSource, entryGraph } = buildSampleGraphForgeScript();
  const dslPath = join(artifactsDir, GRAPH_FORGE_DSL_FILENAME);
  await writeFile(dslPath, `${dslSource}\n`, "utf8");

  const analysisRequest = {
    jsonrpc: "2.0" as const,
    id: "graph_forge_analyze_stage4",
    method: "tools/call",
    params: {
      name: "graph_forge_analyze",
      arguments: {
        source: dslSource,
        entry_graph: entryGraph,
        use_defined_analyses: true,
      },
    },
  };

  const analysisCheck = await performHttpCheck("graph_forge_analyze", {
    method: "POST",
    url: environment.baseUrl,
    headers,
    body: analysisRequest,
  });

  await appendHttpCheckArtefactsToFiles(runRoot, GRAPH_FORGE_TARGETS, analysisCheck, GRAPH_FORGE_JSONL_FILES.log);

  const analysisResult = extractJsonRpcResult(analysisCheck.response.body);
  const analysisText = analysisResult ? extractFirstTextContent(analysisResult) : null;
  let parsedAnalysis: unknown = null;
  let analysisParseError: string | undefined;

  if (analysisText) {
    try {
      parsedAnalysis = JSON.parse(analysisText);
    } catch (error) {
      analysisParseError = error instanceof Error ? error.message : String(error);
    }
  }

  const analysisDocument = {
    capturedAt: new Date().toISOString(),
    requestId: analysisRequest.id,
    entryGraph,
    rawText: analysisText,
    parsed: parsedAnalysis,
    parseError: analysisParseError ?? null,
  };
  const analysisPath = join(artifactsDir, GRAPH_FORGE_ANALYSIS_FILENAME);
  await writeJsonFile(analysisPath, analysisDocument);

  const autosaveRequestStart = {
    jsonrpc: "2.0" as const,
    id: "graph_state_autosave_start_stage4",
    method: "tools/call",
    params: {
      name: "graph_state_autosave",
      arguments: {
        action: "start",
        path: autosaveRelative,
        interval_ms: options.autosaveIntervalMs ?? 1500,
      },
    },
  };

  const autosaveStartCheck = await performHttpCheck("graph_state_autosave:start", {
    method: "POST",
    url: environment.baseUrl,
    headers,
    body: autosaveRequestStart,
  });

  await appendHttpCheckArtefactsToFiles(runRoot, GRAPH_FORGE_TARGETS, autosaveStartCheck, GRAPH_FORGE_JSONL_FILES.log);

  const observer = options.autosaveObserver ?? observeAutosaveTicks;
  const requestedTicks = options.autosaveObservation?.requiredTicks ?? 2;
  const observerPollInterval = options.autosaveObservation?.pollIntervalMs ?? 250;
  const observerOptions: AutosaveObservationOptions = {
    requiredTicks: requestedTicks,
    pollIntervalMs: observerPollInterval,
    timeoutMs:
      options.autosaveObservation?.timeoutMs ??
      Math.max((options.autosaveIntervalMs ?? 1500) * requestedTicks * 4, observerPollInterval * 8),
  };

  const observation = await observer(autosaveAbsolute, observerOptions);
  await appendAutosaveEvents(runRoot, observation.samples);

  const autosaveRequestStop = {
    jsonrpc: "2.0" as const,
    id: "graph_state_autosave_stop_stage4",
    method: "tools/call",
    params: {
      name: "graph_state_autosave",
      arguments: {
        action: "stop",
      },
    },
  };

  const autosaveStopCheck = await performHttpCheck("graph_state_autosave:stop", {
    method: "POST",
    url: environment.baseUrl,
    headers,
    body: autosaveRequestStop,
  });

  await appendHttpCheckArtefactsToFiles(runRoot, GRAPH_FORGE_TARGETS, autosaveStopCheck, GRAPH_FORGE_JSONL_FILES.log);

  const lastObservedSample = observation.samples[observation.samples.length - 1] ?? null;
  const expectedSavedAt = lastObservedSample?.savedAt ?? null;
  const quiescenceOptions: AutosaveQuiescenceOptions = {
    pollIntervalMs: options.autosaveQuiescence?.pollIntervalMs ?? observerPollInterval,
    durationMs:
      options.autosaveQuiescence?.durationMs ?? Math.max(options.autosaveIntervalMs ?? 1500, observerPollInterval * 6),
  };
  const quiescence = await verifyAutosaveQuiescence(autosaveAbsolute, expectedSavedAt, quiescenceOptions);
  await appendAutosaveQuiescenceEvent(runRoot, quiescence);

  const summaryPayload = {
    capturedAt: new Date().toISOString(),
    autosave: {
      relativePath: autosaveRelative,
      absolutePath: autosaveAbsolute,
      observation,
      quiescence,
    },
    analysis: {
      dslPath,
      analysisPath,
    },
  };
  const summaryPath = join(artifactsDir, GRAPH_FORGE_AUTOSAVE_SUMMARY);
  await writeJsonFile(summaryPath, summaryPayload);

  if (!quiescence.verified) {
    throw new Error(
      `Autosave did not quiesce: expected saved_at ${quiescence.expectedSavedAt ?? "<none>"} but observed ${
        quiescence.observedSavedAt ?? "<none>"
      }`,
    );
  }

  return {
    analysis: {
      check: analysisCheck,
      dslPath,
      resultPath: analysisPath,
    },
    autosave: {
      start: autosaveStartCheck,
      stop: autosaveStopCheck,
      relativePath: autosaveRelative,
      absolutePath: autosaveAbsolute,
      observation,
      quiescence,
      summaryPath,
    },
  };
}

