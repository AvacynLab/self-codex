#!/usr/bin/env node
/**
 * Helper script that launches the orchestrator with the monitoring dashboard
 * enabled. The script wires reasonable defaults for local development while
 * still allowing overrides through environment variables.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST_SERVER = resolve(ROOT, "dist", "server.js");

/**
 * Ensures the compiled entrypoint exists before attempting to launch the
 * orchestrator. Operators are reminded to run the build step if the bundle is
 * missing so the script fails fast with an actionable hint.
 */
async function ensureBuildIsPresent() {
  try {
    await access(DIST_SERVER, fsConstants.F_OK);
  } catch (error) {
    const hint =
      error && typeof error === "object" && "code" in error && error.code === "ENOENT"
        ? "Run `npm run build` so the dashboard can load the compiled server."
        : "Unable to access dist/server.js.";
    console.error(`[start-dashboard] ${hint}`);
    process.exitCode = 1;
    process.exit();
  }
}

await ensureBuildIsPresent();

const httpHost = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const httpPort = process.env.MCP_HTTP_PORT ?? "4000";
const dashboardHost = process.env.MCP_DASHBOARD_HOST ?? "127.0.0.1";
const dashboardPort = process.env.MCP_DASHBOARD_PORT ?? "4100";
const dashboardInterval = process.env.MCP_DASHBOARD_INTERVAL_MS;

const launchArgs = [
  DIST_SERVER,
  "--no-stdio",
  "--http",
  "--http-host",
  httpHost,
  "--http-port",
  httpPort,
  "--http-json",
  "--dashboard",
  "--dashboard-host",
  dashboardHost,
  "--dashboard-port",
  dashboardPort,
];

if (dashboardInterval) {
  launchArgs.push("--dashboard-interval-ms", dashboardInterval);
}

const child = spawn(process.execPath, launchArgs, {
  stdio: "inherit",
  env: process.env,
});

function forwardSignal(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(0);
    return;
  }
  process.exit(code ?? 0);
});
