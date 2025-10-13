#!/usr/bin/env node
/**
 * Validate the MCP environment bootstrap workflow.
 *
 * The helper replays the `scripts/setup-agent-env.sh` script with the HTTP
 * transport enabled, exercises the exposed endpoint with authenticated and
 * unauthenticated probes, inspects the STDIO configuration file, and persists
 * a machine-readable as well as human-friendly report under
 * `validation_runs/setup_<timestamp>/`.
 *
 * A deterministic fixture mode is available via `CODEX_VALIDATE_SETUP_TEST=1`
 * so unit tests can assert the filesystem layout without actually performing the
 * expensive setup steps (npm ci, TypeScript build, HTTP server launch).
 */
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const TEST_MODE = process.env.CODEX_VALIDATE_SETUP_TEST === "1";
const workspaceRoot = resolve(process.cwd());
const runsRoot = resolve(process.env.VALIDATE_SETUP_ROOT ?? "validation_runs");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `setup_${timestamp}`;
const runRoot = resolve(runsRoot, runId);
const directories = {
  logs: resolve(runRoot, "logs"),
  report: resolve(runRoot, "report"),
  artifacts: resolve(runRoot, "artifacts"),
};
const setupLogPath = resolve(directories.logs, "setup.log");
const summaryJsonPath = resolve(directories.report, "summary.json");
const summaryMarkdownPath = resolve(directories.report, "summary.md");
const httpProbeAuthorizedPath = resolve(directories.artifacts, "http/probe-authorized.json");
const httpProbeUnauthorizedPath = resolve(directories.artifacts, "http/probe-unauthorized.json");
const stdioConfigSnapshotPath = resolve(directories.artifacts, "stdio-config.toml");

/** Ensure the validation directories exist before writing artefacts. */
async function ensureDirectories() {
  await Promise.all(Object.values(directories).map((dir) => mkdir(dir, { recursive: true })));
}

/** Serialise JSON data with a trailing newline for readability. */
async function writeJson(targetPath, payload) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Wait until the HTTP endpoint becomes reachable by issuing `mcp_info` probes.
 * The helper retries for ~5 seconds before yielding an error so operators
 * receive actionable diagnostics instead of hanging indefinitely.
 */
async function waitForReady(baseUrl, token) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: "validate-setup", method: "mcp_info", params: {} });
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl, { method: "POST", headers, body: payload });
      if (response.status === 200 || response.status === 401) {
        return true;
      }
    } catch {
      // Ignore transient socket errors while the server starts up.
    }
    await delay(100);
  }
  throw new Error(`validate-setup: HTTP endpoint did not become ready (${baseUrl})`);
}

/**
 * Spawn the bootstrap script with HTTP enabled and capture its console output.
 * The setup performs heavy operations (npm ci + build), hence measuring the
 * elapsed time offers additional visibility when investigating CI regressions.
 */
async function runSetupScript({ host, port, path, token }) {
  const scriptPath = resolve(workspaceRoot, "scripts/setup-agent-env.sh");
  const childEnv = {
    ...process.env,
    START_HTTP: "1",
    MCP_HTTP_HOST: host,
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_PATH: path,
    MCP_HTTP_TOKEN: token,
  };
  const child = spawn("bash", [scriptPath], {
    cwd: workspaceRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = createWriteStream(setupLogPath, { flags: "a" });
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
    });
  }
  const startedAt = performance.now();
  const [exitCode] = await once(child, "exit");
  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  logStream.end();
  return { exitCode: exitCode ?? 0, durationMs };
}

/** Execute a JSON-RPC POST request and capture its latency + decoded payload. */
async function probeEndpoint(baseUrl, token, { skipAuth = false } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token && !skipAuth) {
    headers.authorization = `Bearer ${token}`;
  }
  const payload = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "mcp_info", params: {} });
  const startedAt = performance.now();
  const response = await fetch(baseUrl, { method: "POST", headers, body: payload });
  const durationMs = Number((performance.now() - startedAt).toFixed(2));
  let body;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }
  return { status: response.status, durationMs, body };
}

/**
 * Inspect the STDIO configuration file written by the setup script to confirm
 * it references the compiled server entry point.
 */
async function inspectStdioConfig() {
  const configPath = resolve(homedir(), ".codex/config.toml");
  try {
    const contents = await readFile(configPath, "utf8");
    await writeFile(stdioConfigSnapshotPath, contents, "utf8");
    const expectedFragment = `args = [\"${resolve(workspaceRoot, "dist/server.js").replace(/\\/g, "\\\\")}\"]`;
    const matches = contents.includes(expectedFragment);
    return { path: configPath, exists: true, matches };
  } catch (error) {
    return { path: configPath, exists: false, matches: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Attempt to terminate the HTTP server started by the setup script. */
async function cleanupServerProcess() {
  try {
    const pidRaw = await readFile("/tmp/mcp_http.pid", "utf8");
    const pid = Number(pidRaw.trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  } catch {
    // PID file absent — nothing to clean up.
  }
}

/**
 * Produce a concise markdown report mirroring the JSON summary for quick review.
 */
function buildSummaryMarkdown(summary) {
  const lines = [
    "# Setup validation report",
    "",
    `- **Run ID**: ${summary.runId}`,
    `- **Created at**: ${summary.createdAt}`,
    `- **Setup exit code**: ${summary.setup.exitCode}`,
    `- **Setup duration**: ${summary.setup.durationMs} ms`,
    "",
    "## HTTP endpoint",
    `- Authenticated status: ${summary.http.authorized.status}`,
    `- Authenticated latency: ${summary.http.authorized.durationMs} ms`,
    `- Unauthorized status: ${summary.http.unauthorized.status}`,
    `- Unauthorized latency: ${summary.http.unauthorized.durationMs} ms`,
    "",
    "## STDIO configuration",
    summary.stdio.exists
      ? `- Config located at ${summary.stdio.path}`
      : "- Config introuvable (consulter summary.json pour les détails)",
    `- Path matches build output: ${summary.stdio.matches ? "oui" : "non"}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Run the live validation workflow end-to-end and emit artefacts mirroring the
 * checklist requirements for section A.
 */
async function runLiveValidation() {
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.MCP_HTTP_PORT ?? "8765");
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const token = process.env.MCP_HTTP_TOKEN && process.env.MCP_HTTP_TOKEN.trim().length > 0
    ? process.env.MCP_HTTP_TOKEN
    : randomUUID();
  const baseUrl = new URL(path, `http://${host}:${port}`).href;

  const setup = await runSetupScript({ host, port, path, token });
  let authorizedProbe = { status: 0, durationMs: 0, body: null };
  let unauthorizedProbe = { status: 0, durationMs: 0, body: null };
  let stdio = { path: "", exists: false, matches: false };
  try {
    await waitForReady(baseUrl, token);
    authorizedProbe = await probeEndpoint(baseUrl, token);
    unauthorizedProbe = await probeEndpoint(baseUrl, token, { skipAuth: true });
    await writeJson(httpProbeAuthorizedPath, authorizedProbe);
    await writeJson(httpProbeUnauthorizedPath, unauthorizedProbe);
    stdio = await inspectStdioConfig();
  } finally {
    await cleanupServerProcess();
  }

  const summary = {
    runId,
    createdAt: new Date().toISOString(),
    directories: Object.fromEntries(
      Object.entries(directories).map(([key, value]) => [key, relative(workspaceRoot, value)]),
    ),
    setup,
    http: { authorized: authorizedProbe, unauthorized: unauthorizedProbe, baseUrl },
    stdio,
  };
  await writeJson(summaryJsonPath, summary);
  const markdown = buildSummaryMarkdown(summary);
  await writeFile(summaryMarkdownPath, markdown, "utf8");
}

/**
 * Deterministic fixture writer used in unit tests.  The artefacts mimic the
 * structure of a real validation run without triggering expensive operations.
 */
async function runTestFixtures() {
  const authorizedProbe = { status: 200, durationMs: 12.34, body: { ok: true } };
  const unauthorizedProbe = { status: 401, durationMs: 10.01, body: { error: "unauthorized" } };
  const stdio = { path: resolve(homedir(), ".codex/config.toml"), exists: true, matches: true };
  await appendFile(setupLogPath, "fixture setup log\n", { encoding: "utf8" });
  await writeJson(httpProbeAuthorizedPath, authorizedProbe);
  await writeJson(httpProbeUnauthorizedPath, unauthorizedProbe);
  await writeFile(stdioConfigSnapshotPath, "[mock]\n", "utf8");
  const summary = {
    runId,
    createdAt: new Date().toISOString(),
    directories: Object.fromEntries(
      Object.entries(directories).map(([key, value]) => [key, relative(workspaceRoot, value)]),
    ),
    setup: { exitCode: 0, durationMs: 1.23 },
    http: { authorized: authorizedProbe, unauthorized: unauthorizedProbe, baseUrl: "test://offline" },
    stdio,
    testMode: true,
  };
  await writeJson(summaryJsonPath, summary);
  const markdown = buildSummaryMarkdown(summary);
  await writeFile(summaryMarkdownPath, markdown, "utf8");
}

async function main() {
  await ensureDirectories();
  if (TEST_MODE) {
    await runTestFixtures();
  } else {
    await runLiveValidation();
  }
  const relativeRoot = relative(workspaceRoot, runRoot);
  console.log(`validate-setup: artefacts stored under ${relativeRoot}`);
}

main().catch((error) => {
  console.error("validate-setup failed", error);
  process.exitCode = 1;
});
