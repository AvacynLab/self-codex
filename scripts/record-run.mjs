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
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TEST_MODE = process.env.CODEX_RECORD_RUN_TEST === "1";
const workspaceRoot = resolve(process.cwd());
const runsRoot = resolve(process.env.RECORD_RUN_ROOT ?? "runs");
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
const baselineGraphPath = resolve(directories.artifacts, "graph-baseline.json");
const graphPatchPath = resolve(directories.artifacts, "graph-patch.json");

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

  const childRunner = resolve(workspaceRoot, "tests/fixtures/mock-runner.js");
  const childArgs = JSON.stringify([childRunner, "--scenario", "record-run"]);
  const childEnv = {
    ...process.env,
    MCP_HTTP_TOKEN: token,
    MCP_LOG_FILE: resolve(directories.logs, "server.jsonl"),
    MCP_LOG_REDACT: process.env.MCP_LOG_REDACT ?? "on",
    MCP_RUNS_ROOT: runRoot,
    MCP_CHILDREN_ROOT: resolve(directories.artifacts, "children"),
    MCP_CHILD_COMMAND: process.execPath,
    MCP_CHILD_ARGS: childArgs,
    MCP_HTTP_STATELESS: "yes",
  };

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
async function issueJsonRpc({ baseUrl, token, method, params, headers = {}, id }) {
  const requestHeaders = {
    "content-type": "application/json",
    accept: "application/json",
    ...headers,
  };
  if (token && !requestHeaders.authorization) {
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

    const call = async (method, params = {}, headers = {}) => {
      counter += 1;
      const id = createRequestId(method, counter);
      const result = await issueJsonRpc({ baseUrl, token, method, params, headers, id });
      operations.push({ id, method, status: result.status });
      return result.body;
    };

    await call("mcp_info", {});
    await call("tools/list", {});
    await call("tools/call", { name: "echo", arguments: { text: "record-run" } });

    const txBegin = await call("tx_begin", {
      graph_id: graphId,
      owner: "record-run",
      note: "seed baseline",
      graph: baseGraph,
    });
    const txId = txBegin?.result?.tx_id ?? null;
    await call("graph_diff", { graph_id: graphId, from: { graph: baseGraph }, to: { graph: baseGraph } });
    if (txId) {
      await call("tx_commit", { tx_id: txId });
    }
    await call("graph_patch", {
      graph_id: graphId,
      base_version: 1,
      owner: "record-run",
      note: "append alpha/beta segment",
      patch: patchOperations,
    });
    await call("graph_diff", {
      graph_id: graphId,
      from: { version: 1 },
      to: { version: 2 },
    });

    const spawnResult = await call("child_spawn_codex", {
      prompt: { system: ["Record the latest run"], user: ["Emit a short heartbeat"] },
      metadata: { run_id: runId },
      limits: { wallclock_ms: 5000, tokens: 512 },
    });
    const childId = spawnResult?.result?.child_id ?? null;
    if (childId) {
      await call("child_attach", { child_id: childId });
      await call("child_send", {
        child_id: childId,
        payload: { type: "prompt", content: "Provide a status heartbeat" },
        expect: "final",
        timeout_ms: 2_000,
      });
      await call("child_kill", { child_id: childId, timeout_ms: 1_000 });
      await call("child_gc", { child_id: childId });
    }

    await call("events_subscribe", { limit: 25 });

    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          runId,
          createdAt: new Date().toISOString(),
          baseUrl,
          operations,
          directories: Object.fromEntries(
            Object.entries(directories).map(([key, value]) => [key, relative(workspaceRoot, value)]),
          ),
          tokenInjected: Boolean(token),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
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
  await appendJsonl(responseLogPath, fakeResponse);
  await appendJsonl(eventsLogPath, {
    id: fakeRequest.id,
    method: fakeRequest.method,
    event: { kind: "TEST", message: "record-run fixture" },
  });
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        runId,
        createdAt: new Date().toISOString(),
        testMode: true,
        directories: Object.fromEntries(
          Object.entries(directories).map(([key, value]) => [key, relative(workspaceRoot, value)]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
