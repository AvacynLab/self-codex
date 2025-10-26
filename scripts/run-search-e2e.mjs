#!/usr/bin/env node
/**
 * Orchestrates the end-to-end search test suite by bootstrapping the dedicated
 * docker-compose stack (SearxNG + Unstructured) before executing the mocha
 * suite that drives the pipeline against the real services. Containers are
 * torn down regardless of the test outcome so follow-up runs start from a clean
 * slate.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const composeFile = resolve(dirname(fileURLToPath(import.meta.url)), "../docker/docker-compose.search.yml");

async function runCommand(command, args, options = {}) {
  const { inheritStdio = true, allowFailure = false, env } = options;
  const stdio = inheritStdio ? "inherit" : "pipe";
  const child = spawn(command, args, { stdio, env: env ? { ...process.env, ...env } : process.env });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}`);
  }
  return exitCode;
}

async function isDockerAvailable() {
  return await new Promise((resolve) => {
    const child = spawn("docker", ["--version"], { stdio: "ignore" });
    child.on("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT") {
        resolve(false);
        return;
      }
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

async function waitForService(url, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Service at ${url} responded with status ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(intervalMs);
  }
  const reason = lastError ? lastError.message : `timeout after ${timeoutMs}ms`;
  throw new Error(`Timed out waiting for ${url}: ${reason}`);
}

async function waitForUnstructuredReady() {
  const url = "http://127.0.0.1:8000/general/v0/general";
  const deadline = Date.now() + 90_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ping" }),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(2_000);
  }
  const message = lastError ? lastError.message : "unstructured service did not respond";
  throw new Error(`Timed out waiting for unstructured readiness: ${message}`);
}

async function runMochaSuite() {
  const mochaArgs = [
    "--import",
    "tsx",
    "./node_modules/mocha/bin/mocha.js",
    "--reporter",
    "tap",
    "--file",
    "tests/setup.ts",
    "tests/e2e/search/search_run.e2e.test.ts",
  ];
  const env = { TSX_EXTENSIONS: "ts", SEARCH_E2E_ALLOW_RUN: "1" };
  await runCommand("node", mochaArgs, { env });
}

async function main() {
  const available = await isDockerAvailable();
  if (!available) {
    console.warn("Docker is not available on this host, skipping search e2e suite.");
    return;
  }
  await runCommand("docker", ["compose", "-f", composeFile, "up", "-d", "--wait"]);
  try {
    await waitForService("http://127.0.0.1:8080/healthz", { timeoutMs: 90_000, intervalMs: 2_000 }).catch(() =>
      waitForService("http://127.0.0.1:8080", { timeoutMs: 30_000, intervalMs: 2_000 }),
    );
    await waitForUnstructuredReady();
    await runMochaSuite();
  } finally {
    await runCommand("docker", ["compose", "-f", composeFile, "down", "-v"], { allowFailure: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
