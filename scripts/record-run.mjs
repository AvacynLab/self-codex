#!/usr/bin/env node
/**
 * Record-run utility.
 *
 * This script prepares a validation dataset by driving the MCP HTTP transport
 * end-to-end.  It spawns the compiled server, executes a representative set of
 * JSON-RPC calls (handshake, tool discovery, echo helpers, graph transactions,
 * and child-runtime lifecycle), and persists every request/response pair as
 * JSON Lines artefacts under `runs/validation_<ISO timestamp>/`.
 *
 * The resulting directory tree contains dedicated buckets for inputs, outputs,
 * events, logs, additional artefacts, and human-readable reports.  Operators can
 * archive the directory to demonstrate the health of the deployment or feed it
 * into downstream auditing pipelines.
 *
 * A lightweight test mode is available via `CODEX_RECORD_RUN_TEST=1`.  When
 * enabled, the script skips process spawning and writes deterministic fixtures so
 * unit tests can assert the filesystem layout without depending on external
 * binaries.
 */
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

const require = createRequire(import.meta.url);
const tsxLoaderModule = require.resolve("tsx");

const TEST_MODE = process.env.CODEX_RECORD_RUN_TEST === "1";
const workspaceRoot = resolve(process.cwd());
const runsRoot = resolve(process.env.RECORD_RUN_ROOT ?? "validation_run");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `validation_${timestamp}`;
const runRoot = resolve(runsRoot, runId);
const directories = {
  inputs: resolve(runRoot, "inputs"),
  outputs: resolve(runRoot, "outputs"),
  events: resolve(runRoot, "events"),
  logs: resolve(runRoot, "logs"),
  artifacts: resolve(runRoot, "artifacts"),
  report: resolve(runRoot, "report"),
};
const requestLogPath = resolve(directories.inputs, "requests.jsonl");
const responseLogPath = resolve(directories.outputs, "responses.jsonl");
const eventsLogPath = resolve(directories.events, "events.jsonl");
const summaryPath = resolve(directories.report, "summary.json");
const summaryMarkdownPath = resolve(directories.report, "summary.md");
const logDiagnosticsPath = resolve(directories.report, "log-diagnostics.json");
const eventsSummaryPath = resolve(directories.report, "events-summary.json");
const anomaliesPath = resolve(directories.report, "anomalies.json");
const baselineGraphPath = resolve(directories.artifacts, "graph-baseline.json");
const graphPatchPath = resolve(directories.artifacts, "graph-patch.json");
const infoOutputPath = resolve(directories.outputs, "info.json");
const toolsOutputPath = resolve(directories.outputs, "tools.json");
const resourcesOutputPath = resolve(directories.outputs, "resources.json");
const logProbeBaseName = "redaction-rotation-probe.log";

/** Ensures all validation subdirectories exist before recording artefacts. */
async function ensureDirectories() {
  await Promise.all(Object.values(directories).map((dir) => mkdir(dir, { recursive: true })));
}

/** Appends a JSON serialisable entry to a `.jsonl` log file. */
async function appendJsonl(targetPath, entry) {
  const payload = `${JSON.stringify(entry)}\n`;
  await appendFile(targetPath, payload, { encoding: "utf8" });
}

/**
 * Serialises an artefact into the `outputs/` directory tree.  Nested folders are
 * materialised automatically so individual validation steps (transactions,
 * errors, children lifecycle) can be examined without reading the aggregated
 * JSONL streams.
 */
async function writeOutputFile(relativeName, payload) {
  const absoluteTarget = resolve(directories.outputs, relativeName);
  await mkdir(dirname(absoluteTarget), { recursive: true });
  await writeFile(absoluteTarget, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return absoluteTarget;
}

/**
 * Extracts inline events embedded inside JSON-RPC payloads.  The server can
 * return observability entries inside either the `result.events` or
 * `error.data.events` collection; both shapes are handled explicitly.
 */
function extractEmbeddedEvents(body) {
  const events = [];
  if (!body || typeof body !== "object") {
    return events;
  }
  const result = body.result;
  if (result && typeof result === "object" && Array.isArray(result.events)) {
    events.push(...result.events);
  }
  const error = body.error;
  if (error && typeof error === "object" && Array.isArray(error.events)) {
    events.push(...error.events);
  } else if (error && typeof error === "object") {
    const data = error.data;
    if (data && typeof data === "object" && Array.isArray(data.events)) {
      events.push(...data.events);
    }
  }
  return events;
}

/** Creates a deterministic identifier for JSON-RPC requests. */
function createRequestId(method, index) {
  return `${method}-${index.toString().padStart(4, "0")}`;
}

/**
 * Computes percentile-based latency statistics for a list of operation
 * durations.  Values are rounded to two decimals for readability while keeping
 * enough precision to compare future captures.
 */
function computeLatencySummary(operations) {
  const samples = operations
    .map((entry) => entry.durationMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (samples.length === 0) {
    return { count: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction) => {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return Number(sorted[index].toFixed(2));
  };
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

/**
 * Builds a map of HTTP statuses returned by the MCP server for quick
 * inspection.  Successful and failing calls can be reviewed individually in
 * the archived JSON artefacts.
 */
function summariseStatuses(operations) {
  const counts = new Map();
  for (const entry of operations) {
    const key = Number.isFinite(entry.status) ? entry.status : 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(counts.entries());
}

/**
 * Generates a deterministic synthetic log that exercises rotation and redacted
 * secrets.  The helper writes a few hundred log lines spread across multiple
 * files inside `logs/` so operators can review the behaviour even when the
 * server itself does not emit enough data during short validation runs.
 */
async function generateLogProbe() {
  const rotationThreshold = 2_048; // bytes per chunk before rotation
  const totalEntries = 320;
  let chunk = "";
  let part = 0;
  let chunkEntries = 0;
  const files = [];

  const flush = async () => {
    if (!chunk) {
      return;
    }
    const fileName = part === 0 ? logProbeBaseName : `${logProbeBaseName}.${part}`;
    const absoluteTarget = resolve(directories.logs, fileName);
    const bytes = Buffer.byteLength(chunk, "utf8");
    await writeFile(absoluteTarget, chunk, "utf8");
    files.push({ name: fileName, entries: chunkEntries, size: bytes });
    part += 1;
    chunk = "";
    chunkEntries = 0;
  };

  for (let index = 0; index < totalEntries; index += 1) {
    const rawSecret = `API_KEY=SECRET_${index.toString().padStart(4, "0")}`;
    const redacted = rawSecret.replace(/API_KEY=[^\s]+/g, "API_KEY=***");
    const line = JSON.stringify({
      index,
      message: `rotation probe entry ${index.toString().padStart(3, "0")}`,
      sanitized: redacted,
    });
    const record = `${line}\n`;
    if (chunk.length + record.length > rotationThreshold) {
      await flush();
    }
    chunk += record;
    chunkEntries += 1;
  }

  await flush();

  return {
    baseName: logProbeBaseName,
    totalEntries,
    rotated: files.length > 1,
    files,
    notes: "Synthetic probe to verify rotation and redaction (sanitized secrets only)",
  };
}

/**
 * Reads the server-side log files (if any) and reports their rotation and
 * redaction status.  The helper limits itself to files starting with the
 * configured MCP log name so the synthetic probe does not interfere with the
 * diagnostics.
 */
async function collectLogDiagnostics() {
  const entries = await readdir(directories.logs);
  const serverLogFiles = entries.filter((name) => name.startsWith("server.jsonl"));
  serverLogFiles.sort((a, b) => a.localeCompare(b));
  const files = [];
  const redactionIssues = [];

  for (const fileName of serverLogFiles) {
    const absolutePath = resolve(directories.logs, fileName);
    const stats = await stat(absolutePath);
    let containsSecret = false;
    let properlyRedacted = true;
    if (stats.size > 0 && stats.size <= 512_000) {
      const contents = await readFile(absolutePath, "utf8");
      containsSecret = /API_KEY=/.test(contents);
      properlyRedacted = !/API_KEY=(?!\*{3})[^\s"']+/g.test(contents);
      if (containsSecret && !properlyRedacted) {
        redactionIssues.push(fileName);
      }
    }
    files.push({
      name: fileName,
      size: stats.size,
      containsSecret,
      properlyRedacted,
    });
  }

  return {
    files,
    rotated: serverLogFiles.length > 1,
    redactionIssues,
  };
}

/**
 * Reads the event log JSONL file and extracts aggregate metrics.  The summary
 * records how many events were captured per method and event type, highlights
 * autosave ticks, and inventories limit-related notifications emitted by the
 * child supervisor.
 */
async function collectEventSummary() {
  const baseSummary = {
    total: 0,
    invalidEntries: 0,
    byMethod: {},
    byType: {},
    autosave: { count: 0, timestamps: [] },
    limits: { count: 0, entries: [] },
  };

  let raw;
  try {
    raw = await readFile(eventsLogPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return baseSummary;
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const autosaveTimestamps = [];
  const limitEntries = [];
  const byMethod = new Map();
  const byType = new Map();

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      baseSummary.invalidEntries += 1;
      continue;
    }

    baseSummary.total += 1;

    const method = typeof record?.method === "string" && record.method.length > 0 ? record.method : null;
    if (method) {
      byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
    }

    const event = record?.event ?? {};
    const eventTypeCandidate = [event.type, event.kind, event.name, event.event_type].find(
      (value) => typeof value === "string" && value.length > 0,
    );
    const eventType = eventTypeCandidate ?? "unknown";
    byType.set(eventType, (byType.get(eventType) ?? 0) + 1);

    const timestampCandidate = [
      event.timestamp,
      event.time,
      event.at,
      event.tick_at,
      event.ts,
      event.occurred_at,
    ].find((value) => typeof value === "string" && value.length > 0);

    const normalizedType = eventType.toLowerCase();
    if (normalizedType.includes("autosave")) {
      if (timestampCandidate) {
        autosaveTimestamps.push(timestampCandidate);
      } else {
        autosaveTimestamps.push(null);
      }
    }

    if (
      normalizedType.includes("limit") ||
      normalizedType.includes("timeout") ||
      normalizedType.includes("budget")
    ) {
      const limitReason = typeof event.reason === "string" && event.reason.length > 0 ? event.reason : null;
      const limitNameCandidates = [event.limit, event.limit_type, event.limitName].filter(
        (value) => typeof value === "string" && value.length > 0,
      );
      limitEntries.push({
        type: eventType,
        reason: limitReason,
        limit: limitNameCandidates[0] ?? null,
        timestamp: timestampCandidate ?? null,
      });
    }
  }

  baseSummary.byMethod = Object.fromEntries(byMethod.entries());
  baseSummary.byType = Object.fromEntries(byType.entries());
  baseSummary.autosave = {
    count: autosaveTimestamps.length,
    timestamps: autosaveTimestamps.filter((value) => typeof value === "string" && value.length > 0),
  };
  baseSummary.limits = {
    count: limitEntries.length,
    entries: limitEntries,
  };

  return baseSummary;
}

/**
 * Formats a markdown report summarising the validation run.  The document
 * includes latency percentiles, success ratios, log diagnostics, and references
 * to the archived artefacts.
 */
function buildSummaryMarkdown(summary, anomalies, logProbeMetadata) {
  const lines = [
    "# MCP validation summary",
    "",
    `- **Run ID**: ${summary.runId}`,
    `- **Created at**: ${summary.createdAt}`,
    `- **Operations recorded**: ${summary.operations.length}`,
    `- **Success count**: ${(summary.statusCounts?.[200] ?? 0)}`,
    `- **Failure count**: ${summary.operations.length - (summary.statusCounts?.[200] ?? 0)}`,
    "",
    "## Latency distribution",
    `- p50: ${summary.latency?.p50 ?? 0} ms`,
    `- p95: ${summary.latency?.p95 ?? 0} ms`,
    `- max: ${summary.latency?.max ?? 0} ms`,
    "",
    "## Log diagnostics",
    `- Server log files analysed: ${summary.logDiagnostics?.server?.files?.length ?? 0}`,
    `- Server log rotation detected: ${summary.logDiagnostics?.server?.rotated ? "yes" : "no"}`,
    `- Synthetic probe rotated: ${logProbeMetadata?.rotated ? "yes" : "no"}`,
    `- Synthetic probe files: ${(logProbeMetadata?.files ?? []).map((file) => file.name).join(", ") || "n/a"}`,
    "",
    "## Event recap",
    `- Events captured: ${summary.eventSummary?.total ?? 0}`,
    `- Autosave ticks: ${summary.eventSummary?.autosave?.count ?? 0}`,
    `- Limit events: ${summary.eventSummary?.limits?.count ?? 0}`,
    summary.eventSummary?.autosave?.timestamps?.length
      ? `- Autosave timestamps: ${summary.eventSummary.autosave.timestamps.join(", ")}`
      : "- Autosave timestamps: n/a",
    summary.eventSummary?.invalidEntries && summary.eventSummary.invalidEntries > 0
      ? `- Invalid event records: ${summary.eventSummary.invalidEntries}`
      : "",
    "",
    "## Anomalies",
    anomalies.length === 0
      ? "Aucune anomalie détectée."
      : anomalies
          .map((entry) => `- ${entry.method} (${entry.status}) → ${entry.archive ?? "(pas d'archive)"}`)
          .join("\n"),
    "",
    "## Next steps",
    "- Examiner les artefacts JSON archivés pour confirmer les comportements observés.",
    "- Partager ce rapport avec l'équipe d'exploitation pour validation finale.",
  ];
  return `${lines.join("\n")}\n`;
}

/** Persists the JSON summary, markdown narrative, diagnostics, and anomalies. */
async function emitSummaryArtifacts(
  summary,
  anomalies,
  logDiagnostics,
  logProbeMetadata,
  eventSummary,
) {
  const payload = {
    ...summary,
    logDiagnostics: { server: logDiagnostics, probe: logProbeMetadata },
    anomalyCount: anomalies.length,
    eventSummary,
  };
  await writeFile(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const markdown = buildSummaryMarkdown(payload, anomalies, logProbeMetadata);
  await writeFile(summaryMarkdownPath, markdown, "utf8");
  await writeFile(
    logDiagnosticsPath,
    `${JSON.stringify({ server: logDiagnostics, probe: logProbeMetadata }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(eventsSummaryPath, `${JSON.stringify(eventSummary, null, 2)}\n`, "utf8");
  await writeFile(anomaliesPath, `${JSON.stringify(anomalies, null, 2)}\n`, "utf8");
}

/**
 * Waits until the HTTP endpoint is ready by polling `mcp_info`.  The helper
 * retries for ~5 seconds before yielding an error so operators get a meaningful
 * message when the server fails to boot.
 */
async function waitForReady(baseUrl, token) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const payload = JSON.stringify({ jsonrpc: "2.0", id: "record-run-health", method: "mcp_info", params: {} });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl, { method: "POST", headers, body: payload });
      if (response.status === 200 || response.status === 401) {
        return;
      }
    } catch {
      // Ignore transient socket errors while the server binds the loopback port.
    }
    await delay(100);
  }
  throw new Error(`record-run: HTTP endpoint did not become ready (${baseUrl})`);
}

/** Starts the MCP server with the feature set required by the capture workflow. */
async function startServer({ host, port, path, token }) {
  const serverEntry = resolve(workspaceRoot, "dist/server.js");
  if (!existsSync(serverEntry)) {
    throw new Error("record-run requires a compiled server. Run `npm run build` first.");
  }

  const childRunner = resolve(workspaceRoot, "tests/fixtures/mock-runner.ts");
  const childArgs = JSON.stringify(["--import", tsxLoaderModule, childRunner, "--scenario", "record-run"]);
  const childEnv = cloneDefinedEnv();
  // Ensure child processes inherit a clean environment without `undefined`
  // placeholders so strict optional semantics remain intact.
  childEnv.MCP_HTTP_TOKEN = token;
  childEnv.MCP_LOG_FILE = resolve(directories.logs, "server.jsonl");
  childEnv.MCP_LOG_REDACT = process.env.MCP_LOG_REDACT ?? "on";
  childEnv.MCP_LOG_ROTATE_SIZE = process.env.MCP_LOG_ROTATE_SIZE ?? "4096";
  childEnv.MCP_LOG_ROTATE_KEEP = process.env.MCP_LOG_ROTATE_KEEP ?? "3";
  childEnv.MCP_RUNS_ROOT = runRoot;
  childEnv.MCP_CHILDREN_ROOT = resolve(directories.artifacts, "children");
  childEnv.MCP_CHILD_COMMAND = process.execPath;
  childEnv.MCP_CHILD_ARGS = childArgs;
  childEnv.MCP_HTTP_STATELESS = "yes";

  const args = [
    serverEntry,
    "--no-stdio",
    "--http",
    "--http-host",
    host,
    "--http-port",
    String(port),
    "--http-path",
    path,
    "--http-json",
    "on",
    "--http-stateless",
    "yes",
    "--enable-events-bus",
    "--enable-cancellation",
    "--enable-tx",
    "--enable-locks",
    "--enable-diff-patch",
    "--enable-idempotency",
    "--enable-child-ops-fine",
    "--enable-autoscaler",
    "--enable-supervisor",
    "--enable-resources",
  ];

  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLogPath = resolve(directories.logs, "server-process.log");
  const logStream = createWriteStream(processLogPath, { flags: "a" });
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      logStream.write(`[stdout] ${chunk}`);
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      logStream.write(`[stderr] ${chunk}`);
    });
  }

  const baseUrl = new URL(path, `http://${host}:${port}`).href;
  await waitForReady(baseUrl, token);

  return { child, baseUrl, logStream };
}

/** Stops the spawned server and ensures file descriptors are closed. */
async function stopServer(handle) {
  if (!handle) {
    return;
  }
  const { child, logStream } = handle;
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore errors when the process has already exited.
  }
  try {
    await once(child, "exit");
  } catch {
    /* ignore */
  }
  logStream.end();
}

/** Issues a JSON-RPC request, records IO artefacts, and extracts events. */
async function issueJsonRpc({ baseUrl, token, method, params, headers = {}, id, skipToken = false }) {
  const requestHeaders = {
    "content-type": "application/json",
    accept: "application/json",
    ...headers,
  };
  if (token && !skipToken && !requestHeaders.authorization) {
    requestHeaders.authorization = `Bearer ${token}`;
  }

  const requestPayload = { jsonrpc: "2.0", id, method, params };
  await appendJsonl(requestLogPath, { id, method, headers: requestHeaders, params });

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestPayload),
    });
    const body = await response.json();
    await appendJsonl(responseLogPath, { id, method, status: response.status, body });
    const events = extractEmbeddedEvents(body);
    for (const event of events) {
      await appendJsonl(eventsLogPath, { id, method, event });
    }
    return { status: response.status, body };
  } catch (error) {
    const failure = {
      id,
      method,
      error: error instanceof Error ? { message: error.message } : { message: String(error) },
    };
    await appendJsonl(responseLogPath, failure);
    return { status: 0, body: failure };
  }
}

/** Implements the full validation capture when the script runs in live mode. */
async function runLiveCapture() {
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? "8765", 10);
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const token = process.env.MCP_HTTP_TOKEN ?? "record-run-token";

  const serverHandle = await startServer({ host, port, path, token });
  const operations = [];
  const anomalies = [];
  try {
    const { baseUrl } = serverHandle;
    let counter = 0;

    const graphId = `validation-graph-${timestamp}`;
    const baseGraph = {
      graph_id: graphId,
      graph_version: 1,
      name: "Validation baseline",
      nodes: [
        { id: "ingest", label: "Ingest" },
        { id: "process", label: "Process" },
      ],
      edges: [{ from: "ingest", to: "process", label: "next" }],
      metadata: { owner: "record-run" },
    };
    await writeFile(baselineGraphPath, `${JSON.stringify(baseGraph, null, 2)}\n`, "utf8");

    const patchOperations = [
      { op: "add", path: "/nodes/-", value: { id: "alpha", label: "Alpha" } },
      { op: "add", path: "/nodes/-", value: { id: "beta", label: "Beta" } },
      { op: "add", path: "/edges/-", value: { from: "alpha", to: "beta", label: "flow" } },
    ];
    await writeFile(graphPatchPath, `${JSON.stringify(patchOperations, null, 2)}\n`, "utf8");

    const call = async (method, params = {}, options = {}) => {
      const { headers = {}, archive, skipToken = false } = options;
      counter += 1;
      const id = createRequestId(method, counter);
      const startedAt = new Date();
      const startMark = performance.now();
      const result = await issueJsonRpc({ baseUrl, token, method, params, headers, id, skipToken });
      const durationMs = Number((performance.now() - startMark).toFixed(2));
      const operationRecord = {
        id,
        method,
        status: result.status,
        archive: archive ?? null,
        durationMs,
        startedAt: startedAt.toISOString(),
      };
      operations.push(operationRecord);
      if (result.status !== 200 || (result.body && typeof result.body === "object" && result.body.error)) {
        anomalies.push({
          ...operationRecord,
          responseBody: result.body,
        });
      }
      if (archive) {
        await writeOutputFile(archive, { id, method, status: result.status, body: result.body });
      }
      return result;
    };

    const info = await call("mcp_info", {}, { archive: "calls/mcp_info.json" });
    await writeFile(infoOutputPath, `${JSON.stringify(info.body, null, 2)}\n`, "utf8");

    const tools = await call("tools/list", {}, { archive: "calls/tools_list.json" });
    await writeFile(toolsOutputPath, `${JSON.stringify(tools.body, null, 2)}\n`, "utf8");

    const resources = await call("resources_list", {}, { archive: "calls/resources_list.json" });
    await writeFile(resourcesOutputPath, `${JSON.stringify(resources.body, null, 2)}\n`, "utf8");

    await call("tools/call", { name: "echo", arguments: { text: "record-run" } }, { archive: "tools/echo.json" });

    const txBegin = await call(
      "tx_begin",
      {
        graph_id: graphId,
        owner: "record-run",
        note: "seed baseline",
        graph: baseGraph,
      },
      { archive: "transactions/tx_begin_initial.json" },
    );
    const txId = txBegin.body?.result?.tx_id ?? null;
    await call(
      "graph_diff",
      { graph_id: graphId, from: { graph: baseGraph }, to: { graph: baseGraph } },
      { archive: "transactions/graph_diff_initial.json" },
    );
    if (txId) {
      await call("tx_commit", { tx_id: txId }, { archive: "transactions/tx_commit_initial.json" });
    }
    await call(
      "graph_patch",
      {
        graph_id: graphId,
        base_version: 1,
        owner: "record-run",
        note: "append alpha/beta segment",
        patch: patchOperations,
      },
      { archive: "transactions/graph_patch_apply.json" },
    );
    await call(
      "graph_diff",
      {
        graph_id: graphId,
        from: { version: 1 },
        to: { version: 2 },
      },
      { archive: "transactions/graph_diff_after_patch.json" },
    );

    const txBeginPatch = await call(
      "tx_begin",
      {
        graph_id: graphId,
        owner: "record-run",
        note: "validate patch sequence",
        graph: baseGraph,
      },
      { archive: "transactions/tx_begin_patch.json", headers: { "Idempotency-Key": `record-run-patch-${timestamp}` } },
    );
    const txIdPatch = txBeginPatch.body?.result?.tx_id ?? null;
    const followUpPatch = await call(
      "graph_patch",
      {
        graph_id: graphId,
        base_version: 2,
        owner: "record-run",
        note: "idempotent patch",
        patch: [{ op: "add", path: "/nodes/-", value: { id: "gamma", label: "Gamma" } }],
      },
      { archive: "transactions/graph_patch_followup.json" },
    );
    await call(
      "graph_diff",
      {
        graph_id: graphId,
        from: { version: 2 },
        to: { version: followUpPatch.body?.result?.committed_version ?? 3 },
      },
      { archive: "transactions/graph_diff_followup.json" },
    );
    if (txIdPatch) {
      await call("tx_commit", { tx_id: txIdPatch }, { archive: "transactions/tx_commit_patch.json" });
    }

    const idempotencyKey = `record-run-idempotent-${timestamp}`;
    const firstIdempotent = await call(
      "tx_begin",
      { graph_id: graphId, owner: "record-run", note: "idempotent begin" },
      { archive: "transactions/tx_begin_idempotent_first.json", headers: { "Idempotency-Key": idempotencyKey } },
    );
    await call(
      "tx_begin",
      { graph_id: graphId, owner: "record-run", note: "idempotent begin" },
      { archive: "transactions/tx_begin_idempotent_second.json", headers: { "Idempotency-Key": idempotencyKey } },
    );
    if (firstIdempotent.body?.result?.tx_id) {
      await call(
        "tx_commit",
        { tx_id: firstIdempotent.body.result.tx_id },
        { archive: "transactions/tx_commit_idempotent.json" },
      );
    }

    const txBeginInvalid = await call(
      "tx_begin",
      { graph_id: graphId, owner: "record-run", note: "invalid patch guard" },
      { archive: "transactions/tx_begin_invalid.json" },
    );
    await call(
      "graph_patch",
      {
        graph_id: graphId,
        base_version: 2,
        owner: "record-run",
        note: "invalid patch",
        patch: [{ op: "remove", path: "/nonexistent" }],
      },
      { archive: "transactions/graph_patch_invalid.json" },
    );
    const invalidTxId = txBeginInvalid.body?.result?.tx_id ?? null;
    if (invalidTxId) {
      await call("tx_rollback", { tx_id: invalidTxId }, { archive: "transactions/tx_rollback_invalid.json" });
    }

    const spawnResult = await call(
      "child_spawn_codex",
      {
        prompt: { system: ["Record the latest run"], user: ["Emit a short heartbeat"] },
        metadata: { run_id: runId },
        limits: { wallclock_ms: 5000, tokens: 512 },
      },
      { archive: "children/child_spawn.json" },
    );
    const childId = spawnResult.body?.result?.child_id ?? null;
    if (childId) {
      await call("child_attach", { child_id: childId }, { archive: "children/child_attach.json" });
      await call(
        "child_send",
        {
          child_id: childId,
          payload: { type: "prompt", content: "Provide a status heartbeat" },
          expect: "final",
          timeout_ms: 2_000,
        },
        { archive: "children/child_send.json" },
      );
      await call(
        "child_set_limits",
        {
          child_id: childId,
          limits: { wallclock_ms: 10, tokens: 1, cpu_percent: 1 },
          reason: "record-run synthetic limit",
        },
        { archive: "children/child_set_limits.json" },
      );
      await call("child_kill", { child_id: childId, timeout_ms: 1_000 }, { archive: "children/child_kill.json" });
      await call("child_gc", { child_id: childId }, { archive: "children/child_gc.json" });
      // Verify that the orchestrator no longer exposes the terminated child in its index.
      await call(
        "child_status",
        { child_id: childId },
        { archive: "children/child_status_after_gc.json" },
      );
    }

    await call("events_subscribe", { limit: 25 }, { archive: "events/subscribe.json" });

    await call(
      "graph_state_autosave",
      { action: "start", interval_ms: 200 },
      { archive: "autosave/start.json" },
    );
    await delay(250);
    await delay(250);
    await call("graph_state_autosave", { action: "stop" }, { archive: "autosave/stop.json" });

    await call(
      "graph_forge_analyze",
      { graph_id: graphId, max_nodes: 5 },
      { archive: "forge/analyze.json" },
    );

    await call(
      "graph_diff",
      { graph_id: graphId, from: { version: 1 }, to: { version: 3 } },
      { archive: "transactions/graph_diff_snapshot_comparison.json" },
    );

    await call(
      "tx_begin",
      { graph_id: graphId, owner: "record-run", note: "duplicate idempotency key" },
      { archive: "transactions/tx_begin_idempotent_again.json", headers: { "Idempotency-Key": idempotencyKey } },
    );

    await call("mcp_info", {}, { archive: "errors/unauthorized.json", skipToken: true });

    await call("method_not_found_demo", {}, { archive: "errors/unknown_method.json" });

    const logProbeMetadata = await generateLogProbe();
    const logDiagnostics = await collectLogDiagnostics();
    const eventSummary = await collectEventSummary();
    const directoriesRelative = Object.fromEntries(
      Object.entries(directories).map(([key, value]) => [key, relative(workspaceRoot, value)]),
    );
    const archivedOutputs = operations
      .filter((entry) => Boolean(entry.archive))
      .map((entry) => entry.archive)
      .filter((entry, index, array) => array.indexOf(entry) === index);
    const summary = {
      runId,
      createdAt: new Date().toISOString(),
      baseUrl,
      operations,
      directories: directoriesRelative,
      tokenInjected: Boolean(token),
      archivedOutputs,
      statusCounts: summariseStatuses(operations),
      latency: computeLatencySummary(operations),
    };
    await emitSummaryArtifacts(summary, anomalies, logDiagnostics, logProbeMetadata, eventSummary);
  } finally {
    await stopServer(serverHandle);
  }
}

/** Writes deterministic fixtures without starting the server (test mode). */
async function runTestFixtures() {
  const fakeRequest = { id: "mcp_info-0001", method: "mcp_info", params: {} };
  await appendJsonl(requestLogPath, fakeRequest);
  const fakeResponse = {
    id: fakeRequest.id,
    method: fakeRequest.method,
    status: 200,
    body: { jsonrpc: "2.0", id: fakeRequest.id, result: { ok: true, testMode: true } },
  };
  const baseTime = Date.now();
  await appendJsonl(responseLogPath, fakeResponse);
  await appendJsonl(eventsLogPath, {
    id: fakeRequest.id,
    method: fakeRequest.method,
    event: { kind: "TEST", message: "record-run fixture" },
  });
  await appendJsonl(eventsLogPath, {
    id: "graph_state_autosave-0001",
    method: "graph_state_autosave",
    event: {
      type: "autosave_tick",
      timestamp: new Date(baseTime + 50).toISOString(),
      interval_ms: 200,
    },
  });
  await appendJsonl(eventsLogPath, {
    id: "child_set_limits-0001",
    method: "child_set_limits",
    event: {
      type: "limit_exceeded",
      reason: "wallclock",
      limit: "wallclock_ms",
      timestamp: new Date(baseTime + 75).toISOString(),
    },
  });
  await writeFile(infoOutputPath, `${JSON.stringify(fakeResponse.body, null, 2)}\n`, "utf8");
  await writeFile(
    toolsOutputPath,
    `${JSON.stringify({ jsonrpc: "2.0", result: { tools: [] } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resourcesOutputPath,
    `${JSON.stringify({ jsonrpc: "2.0", result: { resources: [] } }, null, 2)}\n`,
    "utf8",
  );
  await writeOutputFile("calls/mcp_info.json", { status: 200, body: fakeResponse.body });
  await writeOutputFile("calls/tools_list.json", { status: 200, body: { jsonrpc: "2.0", result: { tools: [] } } });
  await writeOutputFile("calls/resources_list.json", { status: 200, body: { jsonrpc: "2.0", result: { resources: [] } } });
  await writeOutputFile("tools/echo.json", fakeResponse.body);
  await writeOutputFile("transactions/tx_begin_initial.json", fakeResponse.body);
  await writeOutputFile("transactions/graph_diff_initial.json", fakeResponse.body);
  await writeOutputFile("children/child_spawn.json", fakeResponse.body);
  await writeOutputFile("children/child_set_limits.json", fakeResponse.body);
  // Fixture verifying that querying the killed child reports a 404-style error.
  await writeOutputFile(
    "children/child_status_after_gc.json",
    {
      status: 404,
      body: {
        jsonrpc: "2.0",
        error: { code: -32004, message: "child_id inconnu", data: { child_id: "child_fixture" } },
      },
    },
  );
  await writeOutputFile("events/subscribe.json", fakeResponse.body);
  await writeOutputFile("errors/unauthorized.json", { status: 401, body: { error: "unauthorized" } });
  const stagedOperations = [
    { id: "mcp_info-0001", method: "mcp_info", status: 200, archive: "calls/mcp_info.json", durationMs: 0.5 },
    { id: "tools/list-0002", method: "tools/list", status: 200, archive: "calls/tools_list.json", durationMs: 0.45 },
    { id: "resources_list-0003", method: "resources_list", status: 200, archive: "calls/resources_list.json", durationMs: 0.42 },
    { id: "tools/call-0004", method: "tools/call", status: 200, archive: "tools/echo.json", durationMs: 0.6 },
    {
      id: "tx_begin-0005",
      method: "tx_begin",
      status: 200,
      archive: "transactions/tx_begin_initial.json",
      durationMs: 0.8,
    },
    {
      id: "graph_diff-0006",
      method: "graph_diff",
      status: 200,
      archive: "transactions/graph_diff_initial.json",
      durationMs: 0.52,
    },
    {
      id: "child_spawn_codex-0007",
      method: "child_spawn_codex",
      status: 200,
      archive: "children/child_spawn.json",
      durationMs: 0.7,
    },
    {
      id: "child_set_limits-0008",
      method: "child_set_limits",
      status: 200,
      archive: "children/child_set_limits.json",
      durationMs: 0.31,
    },
    {
      id: "child_status-0009",
      method: "child_status",
      status: 404,
      archive: "children/child_status_after_gc.json",
      durationMs: 0.33,
    },
    {
      id: "events_subscribe-0010",
      method: "events_subscribe",
      status: 200,
      archive: "events/subscribe.json",
      durationMs: 0.35,
    },
    {
      id: "mcp_info-0011",
      method: "mcp_info",
      status: 401,
      archive: "errors/unauthorized.json",
      durationMs: 0.4,
    },
  ];
  const operations = stagedOperations.map((entry, index) => ({
    ...entry,
    startedAt: new Date(baseTime + index * 100).toISOString(),
  }));
  const childStatusOperation = operations.find((entry) => entry.method === "child_status");
  const unauthorizedOperation = operations.find(
    (entry) => entry.method === "mcp_info" && entry.status === 401,
  );
  const anomalies = [];
  if (childStatusOperation) {
    anomalies.push({
      ...childStatusOperation,
      responseBody: {
        status: 404,
        body: {
          jsonrpc: "2.0",
          error: { code: -32004, message: "child_id inconnu", data: { child_id: "child_fixture" } },
        },
      },
    });
  }
  if (unauthorizedOperation) {
    anomalies.push({
      ...unauthorizedOperation,
      responseBody: { status: 401, body: { error: "unauthorized" } },
    });
  }
  const logProbeMetadata = await generateLogProbe();
  const logDiagnostics = await collectLogDiagnostics();
  const eventSummary = await collectEventSummary();
  const directoriesRelative = Object.fromEntries(
    Object.entries(directories).map(([key, value]) => [key, relative(workspaceRoot, value)]),
  );
  const archivedOutputs = Array.from(
    new Set(operations.map((entry) => entry.archive).filter((value) => Boolean(value))),
  );
  const summary = {
    runId,
    createdAt: new Date().toISOString(),
    baseUrl: "test://offline",
    testMode: true,
    operations,
    directories: directoriesRelative,
    tokenInjected: false,
    archivedOutputs,
    statusCounts: summariseStatuses(operations),
    latency: computeLatencySummary(operations),
  };
  await emitSummaryArtifacts(summary, anomalies, logDiagnostics, logProbeMetadata, eventSummary);
}

async function main() {
  await ensureDirectories();
  if (TEST_MODE) {
    await runTestFixtures();
  } else {
    await runLiveCapture();
  }
  const relativeRoot = relative(workspaceRoot, runRoot);
  console.log(`record-run: artefacts stored under ${relativeRoot}`);
}

main().catch((error) => {
  console.error("record-run failed", error);
  process.exitCode = 1;
});
