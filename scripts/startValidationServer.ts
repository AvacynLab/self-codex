#!/usr/bin/env tsx

import process from "node:process";

import { startValidationServer } from "../src/validationRun/server";

async function main(): Promise<void> {
  const { handle, readiness, healthUrl } = await startValidationServer({
    token: process.env.MCP_HTTP_TOKEN,
  });

  if (!readiness.ok) {
    const reason = readiness.lastResult?.error ?? `status ${readiness.lastResult?.statusCode ?? "unknown"}`;
    console.error(`✖ Validation server failed to become ready (${reason}).`);
    console.error(`  Logs: ${handle.logFile}`);
    process.exitCode = 1;
    return;
  }

  console.log("✔ Validation server running.");
  console.log(`  PID: ${handle.process.pid ?? "unknown"}`);
  console.log(`  Logs: ${handle.logFile}`);
  console.log(`  Health: ${healthUrl}`);
  console.log(`  MCP_RUNS_ROOT=${handle.runtime.layout.root}`);
  if (handle.runtime.childrenDir) {
    console.log(`  children workspace: ${handle.runtime.childrenDir}`);
  }
  if (handle.env.MCP_HTTP_TOKEN) {
    console.log(`  MCP_HTTP_TOKEN=${handle.env.MCP_HTTP_TOKEN}`);
  }
  console.log("Press Ctrl+C to stop the server.");

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    handle.process.once("exit", (code, signal) => {
      console.log(`\nServer process exited (code=${code ?? "null"} signal=${signal ?? "null"}).`);
      resolve({ code, signal });
    });
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`\nReceived ${signal}, stopping validation server...`);
    await handle.stop(signal);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const exitState = await exitPromise;
  process.exit(exitState.code ?? 0);
}

void main().catch((error) => {
  console.error("Unexpected failure while starting validation server:", error);
  process.exitCode = 1;
});
