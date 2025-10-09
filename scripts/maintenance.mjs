#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  createCommandRunner,
  ensureBranchAllowed,
  selectInstallArguments,
  ensureSourceMapNodeOptions,
  assertNodeVersion,
} from "./lib/env-helpers.mjs";

/**
 * Refreshes an existing Codex deployment while guaranteeing that the
 * repository workspace remains untouched. The same "no-write" policy used for
 * environment setup applies here so operators can safely rebuild in CI. The
 * maintenance flow additionally restarts long-running transports and performs
 * a lightweight HTTP health-check when `curl` is available.
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const scriptPath = fileURLToPath(import.meta.url);
const isTestEnvironment = process.env.CODEX_SCRIPT_TEST === "1";
const isDryRun = process.env.CODEX_SCRIPT_DRY_RUN === "1";
const invokedDirectly = (() => {
  try {
    return process.argv.length > 1 && resolve(process.argv[1]) === scriptPath;
  } catch {
    return false;
  }
})();

/** Collects side effects for dry-run assertions (see tests/scripts.*). */
const maintenanceActions = [];

function recordAction(action) {
  maintenanceActions.push(action);
}

function coerceBoolean(value) {
  if (!value) {
    return false;
  }
  const normalised = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalised);
}

function expandHomePath(rawPath) {
  if (!rawPath || rawPath.trim().length === 0) {
    return rawPath;
  }
  if (!rawPath.startsWith("~")) {
    return rawPath;
  }
  const home = process.env.HOME ?? "";
  const remainder = rawPath.slice(1).replace(/^[/\\]+/, "");
  return home ? join(home, remainder) : remainder;
}

function resolveFsBridgeDirectory(rawValue) {
  const base = expandHomePath(rawValue);
  if (!base || base.trim().length === 0) {
    const home = process.env.HOME ?? "";
    return resolve(home, ".codex", "ipc");
  }
  return resolve(base);
}

function captureEnvironment() {
  const rawHttpEnable = process.env.MCP_HTTP_ENABLE ?? "";
  return {
    rawHttpEnable,
    httpEnable: coerceBoolean(rawHttpEnable),
    httpHost: process.env.MCP_HTTP_HOST || "127.0.0.1",
    httpPort: process.env.MCP_HTTP_PORT || "8765",
    httpPath: process.env.MCP_HTTP_PATH || "/mcp",
    httpJson: process.env.MCP_HTTP_JSON || "on",
    httpStateless: process.env.MCP_HTTP_STATELESS || "yes",
    httpToken: process.env.MCP_HTTP_TOKEN || "",
    fsBridgeDir: resolveFsBridgeDirectory(process.env.MCP_FS_IPC_DIR ?? ""),
  };
}

function killProcessIfPresent(pidPath, label) {
  if (!existsSync(pidPath)) {
    recordAction({ action: "skip-kill", label, reason: "pid-missing", pidPath });
    return false;
  }
  let pid = 0;
  try {
    pid = Number(readFileSync(pidPath, "utf8").trim());
  } catch (error) {
    recordAction({
      action: "kill-error",
      label,
      pidPath,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    recordAction({ action: "kill-error", label, pidPath, message: "invalid pid" });
    if (!isDryRun) {
      try {
        unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  if (isDryRun) {
    recordAction({ action: "kill", label, pid, pidPath });
    return true;
  }
  try {
    process.kill(pid, "SIGTERM");
    recordAction({ action: "kill", label, pid, pidPath });
  } catch (error) {
    recordAction({
      action: "kill-error",
      label,
      pid,
      pidPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
  return true;
}

function spawnDetached(label, scriptName, logFilename, pidFilename) {
  const command = "npm";
  const args = ["run", scriptName];
  const logPath = join(projectRoot, logFilename);
  const pidPath = join(projectRoot, pidFilename);
  const envWithSourceMaps = ensureSourceMapNodeOptions(process.env);
  recordAction({
    action: "spawn-attempt",
    label,
    command,
    args,
    logPath,
    pidPath,
    dryRun: isDryRun,
    nodeOptions: envWithSourceMaps.NODE_OPTIONS,
  });
  if (isDryRun) {
    return { ok: true, command, args, logPath, pidPath };
  }

  let outFd;
  let errFd;
  try {
    outFd = openSync(logPath, "a");
    errFd = openSync(logPath, "a");
    const child = spawn(command, args, {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: envWithSourceMaps,
    });
    writeFileSync(pidPath, `${child.pid}\n`, "utf8");
    child.unref();
    recordAction({ action: "spawned", label, pid: child.pid, command, args, logPath, pidPath });
    return { ok: true, pid: child.pid };
  } catch (error) {
    recordAction({
      action: "spawn-error",
      label,
      command,
      args,
      logPath,
      pidPath,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return { ok: false };
  } finally {
    if (outFd !== undefined) {
      try {
        closeSync(outFd);
      } catch {
        /* ignore */
      }
    }
    if (errFd !== undefined) {
      try {
        closeSync(errFd);
      } catch {
        /* ignore */
      }
    }
  }
}

function ensureFsBridgeDirectories(baseDir) {
  const targets = [
    baseDir,
    join(baseDir, "requests"),
    join(baseDir, "responses"),
    join(baseDir, "errors"),
  ];
  for (const directory of targets) {
    recordAction({ action: "ensure-dir", path: directory, dryRun: isDryRun });
    if (isDryRun) {
      continue;
    }
    mkdirSync(directory, { recursive: true });
  }
}

async function performHttpHealth(runCommand, env) {
  try {
    await runCommand("which", ["curl"]);
  } catch {
    recordAction({ action: "health-skip", reason: "curl-missing" });
    return { ok: false, skipped: true };
  }

  const url = `http://${env.httpHost}:${env.httpPort}${env.httpPath}`;
  const payload = JSON.stringify({ jsonrpc: "2.0", id: "health", method: "mcp_info" });
  const args = [
    "-sS",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-d",
    payload,
  ];
  if (env.httpToken) {
    args.push("-H", `Authorization: Bearer ${env.httpToken}`);
  }
  args.push(url);

  try {
    const result = await runCommand("curl", args, { captureOutput: true });
    const body = result.stdout?.trim() ?? "";
    let ok = false;
    try {
      const json = JSON.parse(body);
      ok = Boolean(json?.result?.server);
    } catch {
      ok = body.includes('"server"');
    }
    recordAction({ action: "health", url, ok });
    if (ok) {
      console.log("[maintenance] HTTP healthcheck OK");
      return { ok: true };
    }
    console.error("[maintenance] HTTP healthcheck FAIL");
    return { ok: false };
  } catch (error) {
    recordAction({
      action: "health-error",
      message: error instanceof Error ? error.message : String(error),
    });
    console.error("[maintenance] HTTP healthcheck FAIL");
    return { ok: false };
  }
}

async function main() {
  maintenanceActions.length = 0;
  assertNodeVersion();
  const { runCommand, recordedCommands } = createCommandRunner({
    projectRoot,
    dryRun: isDryRun,
  });

  await ensureBranchAllowed(async () => {
    const result = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      captureOutput: true,
    });
    return result.stdout;
  });

  const hasLockFile =
    existsSync(join(projectRoot, "package-lock.json")) ||
    existsSync(join(projectRoot, "npm-shrinkwrap.json"));
  const installArgs = selectInstallArguments(hasLockFile);

  console.log(`[maintenance] npm ${installArgs.join(" ")}`);
  await runCommand("npm", installArgs);
  console.log("[maintenance] npm install @types/node@latest --no-save --no-package-lock");
  await runCommand("npm", [
    "install",
    "@types/node@latest",
    "--no-save",
    "--no-package-lock",
  ]);
  console.log("[maintenance] npm run build");
  await runCommand("npm", ["run", "build"]);

  const envSnapshot = captureEnvironment();
  const httpPidPath = join(projectRoot, ".mcp_http.pid");
  const fsPidPath = join(projectRoot, ".mcp_fsbridge.pid");

  let httpStatus = "not-started";
  if (existsSync(httpPidPath)) {
    killProcessIfPresent(httpPidPath, "http");
    const restart = spawnDetached("http", "start:http", ".mcp_http.out", ".mcp_http.pid");
    httpStatus = restart.ok ? "HTTP OK" : "HTTP restart failed";
  } else {
    recordAction({ action: "http-skip", reason: "pid-missing" });
  }

  killProcessIfPresent(fsPidPath, "fsbridge");
  ensureFsBridgeDirectories(envSnapshot.fsBridgeDir);
  spawnDetached("fsbridge", "start:fsbridge", ".mcp_fsbridge.out", ".mcp_fsbridge.pid");

  if (httpStatus === "HTTP OK") {
    await performHttpHealth(runCommand, envSnapshot);
  } else if (httpStatus === "HTTP restart failed") {
    console.error("[maintenance] HTTP restart failed");
  } else {
    console.log("[maintenance] HTTP transport not restarted (pid missing)");
  }

  if (isDryRun) {
    globalThis.CODEX_MAINTENANCE_COMMANDS = recordedCommands;
    globalThis.CODEX_MAINTENANCE_ENV = envSnapshot;
    globalThis.CODEX_MAINTENANCE_ACTIONS = maintenanceActions.slice();
    globalThis.CODEX_MAINTENANCE_STATUS = httpStatus;
  }
}

if (!isTestEnvironment && invokedDirectly) {
  await main();
}

export { main as runMaintenance };
