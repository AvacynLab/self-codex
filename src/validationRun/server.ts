import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import {
  spawn as defaultSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import {
  ensureValidationRuntime,
  verifyHttpHealth,
  type HttpHealthOptions,
  type HttpProbeResult,
  type ValidationRuntimeContext,
} from "./runtime";

/** Function signature mirroring {@link spawn} for dependency injection. */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** Sleep helper used between readiness probes. */
export type SleepFunction = (ms: number) => Promise<void>;

/**
 * Minimal structure describing the MCP server exit state captured during
 * validation. Exposed so the CLI can render a precise message to operators.
 */
export interface ServerExitState {
  /** Exit code returned by the Node.js process, if available. */
  readonly code: number | null;
  /** Signal that terminated the process, when relevant. */
  readonly signal: NodeJS.Signals | null;
}

/** Options controlling the readiness probing sequence. */
export interface ServerReadinessOptions {
  /** Complete override for the health URL. */
  readonly healthUrl?: string;
  /** Custom endpoint appended to the MCP base path. Defaults to `health`. */
  readonly healthEndpoint?: string;
  /** Maximum number of attempts before giving up. Defaults to 15. */
  readonly maxAttempts?: number;
  /** Delay between attempts in milliseconds. Defaults to 1000ms. */
  readonly retryIntervalMs?: number;
  /** Expected HTTP status code. Defaults to 200. */
  readonly expectStatus?: number;
  /** Timeout per request forwarded to {@link verifyHttpHealth}. */
  readonly timeoutMs?: number;
}

/** Result returned after waiting for the MCP server readiness. */
export interface ServerReadinessResult {
  /** Whether the health endpoint eventually responded successfully. */
  readonly ok: boolean;
  /** Number of attempts executed (at least one). */
  readonly attempts: number;
  /** Most recent probe result captured during the loop. */
  readonly lastResult?: HttpProbeResult;
  /** Exit information when the process terminated before readiness. */
  readonly exitState?: ServerExitState;
}

/** Options accepted by {@link startValidationServer}. */
export interface StartValidationServerOptions {
  /**
   * Validation layout root. Defaults to the repository `validation_run/`
   * directory, consistent with the other helpers.
   */
  readonly root?: string;
  /** Custom working directory for the spawned process. */
  readonly cwd?: string;
  /**
   * Command executed to start the MCP server. Defaults to `npm` so the helper
   * runs `npm run start:http`.
   */
  readonly command?: string;
  /** Arguments forwarded to the command. Defaults to `run start:http`. */
  readonly args?: readonly string[];
  /** Optional log file name under `validation_run/logs/`. */
  readonly logFileName?: string;
  /** Custom host binding for the MCP HTTP server. */
  readonly host?: string;
  /** Custom port for the MCP HTTP server. */
  readonly port?: number;
  /** Base path exposed by the MCP HTTP server (e.g. `/mcp`). */
  readonly path?: string;
  /** Explicit MCP authentication token. */
  readonly token?: string;
  /** Additional environment variables merged into the process. */
  readonly env?: NodeJS.ProcessEnv;
  /** Readiness tuning knobs. */
  readonly readiness?: ServerReadinessOptions;
  /** Whether to create the `children/` workspace directory. */
  readonly createChildrenDir?: boolean;
  /** Optional custom `spawn` implementation (used by tests). */
  readonly spawnImpl?: SpawnFunction;
  /** Optional custom sleep helper (used by tests). */
  readonly sleep?: SleepFunction;
  /** Optional override for the readiness probe implementation. */
  readonly verifyHealth?: typeof verifyHttpHealth;
  /** Deterministic token factory mainly used by unit tests. */
  readonly tokenFactory?: () => string;
}

/**
 * Handle returned once the validation server is spawned. Exposes the process,
 * resolved environment and a cooperative shutdown helper.
 */
export interface ValidationServerHandle {
  /** Command executed for the MCP server. */
  readonly command: string;
  /** Arguments forwarded to the command. */
  readonly args: readonly string[];
  /** Effective environment variables passed to the process. */
  readonly env: NodeJS.ProcessEnv;
  /** Validation runtime context backing the server. */
  readonly runtime: ValidationRuntimeContext;
  /** Absolute path to the aggregated server log. */
  readonly logFile: string;
  /** Underlying child process. */
  readonly process: ChildProcessWithoutNullStreams;
  /** Initiates a graceful shutdown with an optional timeout. */
  stop(signal?: NodeJS.Signals | number, timeoutMs?: number): Promise<void>;
}

/** Result returned after starting the MCP validation server. */
export interface StartValidationServerResult {
  /** Handle exposing the running process. */
  readonly handle: ValidationServerHandle;
  /** Outcome of the readiness probing sequence. */
  readonly readiness: ServerReadinessResult;
  /** Health URL used during the readiness loop. */
  readonly healthUrl: string;
}

/** Default retry count applied to the readiness loop. */
const DEFAULT_MAX_ATTEMPTS = 15;
/** Default delay between readiness probes. */
const DEFAULT_RETRY_INTERVAL_MS = 1000;
/** Default log file name for the validation server. */
const DEFAULT_SERVER_LOG = "validation-server.log";

/**
 * Starts the MCP server with the checklist-mandated environment variables,
 * records stdout/stderr into `validation_run/logs/` and waits until the HTTP
 * health endpoint becomes available.
 */
export async function startValidationServer(
  options: StartValidationServerOptions = {},
): Promise<StartValidationServerResult> {
  const runtime = await ensureValidationRuntime({
    ...(options.root !== undefined ? { root: options.root } : {}),
    createChildrenDir: options.createChildrenDir ?? true,
  });

  const command = options.command ?? "npm";
  const args = [...(options.args ?? ["run", "start:http"])] as readonly string[];
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const verifyHealth = options.verifyHealth ?? verifyHttpHealth;
  const sleep = options.sleep ?? defaultSleep;
  const tokenFactory = options.tokenFactory ?? defaultTokenFactory;

  const env = buildServerEnv(runtime, options, tokenFactory);
  const cwd = options.cwd ?? path.resolve(runtime.layout.root, "..");
  const logFile = path.join(runtime.layout.logsDir, options.logFileName ?? DEFAULT_SERVER_LOG);

  await appendLogHeader(logFile, command, args, env);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnImpl(command, [...args], { cwd, env });
  } catch (error) {
    await appendLogLine(logFile, `[error] Failed to spawn server: ${formatError(error)}`);
    throw error instanceof Error ? error : new Error(String(error));
  }

  wireProcessLogging(child, logFile);

  let exitState: ServerExitState | undefined;
  child.once("exit", (code, signal) => {
    exitState = { code, signal };
  });

  const handle: ValidationServerHandle = {
    command,
    args,
    env,
    runtime,
    logFile,
    process: child,
    stop: (signal, timeoutMs) => stopProcess(child, logFile, signal, timeoutMs),
  };

  const healthUrl = computeHealthUrl(env, options);
  const readiness = await waitForReadiness({
    healthUrl,
    env,
    verifyHealth,
    sleep,
    process: child,
    logFile,
    exitStateRef: () => exitState,
    ...(options.readiness ? { readiness: options.readiness } : {}),
  });

  if (!readiness.ok) {
    await handle.stop("SIGTERM");
  }

  const readinessResult = readiness.ok
    ? readiness
    : { ...readiness, ...(exitState ? { exitState } : {}) };
  return { handle, readiness: readinessResult, healthUrl };
}

/** Builds the MCP server environment by merging defaults and user overrides. */
function buildServerEnv(
  runtime: ValidationRuntimeContext,
  options: StartValidationServerOptions,
  tokenFactory: () => string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...runtime.env };

  if (options.env) {
    Object.assign(env, options.env);
  }

  env.START_HTTP = env.START_HTTP ?? "1";
  env.MCP_HTTP_JSON = env.MCP_HTTP_JSON ?? "on";
  env.MCP_HTTP_STATELESS = env.MCP_HTTP_STATELESS ?? "yes";

  const host = options.host ?? env.MCP_HTTP_HOST ?? "127.0.0.1";
  env.MCP_HTTP_HOST = host;

  const port = options.port ?? (env.MCP_HTTP_PORT ? Number(env.MCP_HTTP_PORT) : undefined) ?? 8765;
  env.MCP_HTTP_PORT = String(port);

  const pathOption = options.path ?? env.MCP_HTTP_PATH ?? "/mcp";
  env.MCP_HTTP_PATH = normaliseBasePath(pathOption);

  if (options.token) {
    env.MCP_HTTP_TOKEN = options.token;
  } else if (!env.MCP_HTTP_TOKEN) {
    env.MCP_HTTP_TOKEN = tokenFactory();
  }

  return env;
}

/**
 * Waits for the HTTP health endpoint to respond successfully, logging every
 * attempt so operators can diagnose slow boots.
 */
async function waitForReadiness(args: {
  readonly healthUrl: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verifyHealth: typeof verifyHttpHealth;
  readonly sleep: SleepFunction;
  readonly process: ChildProcessWithoutNullStreams;
  readonly logFile: string;
  readonly exitStateRef: () => ServerExitState | undefined;
  readonly readiness?: ServerReadinessOptions;
}): Promise<ServerReadinessResult> {
  const maxAttempts = args.readiness?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const interval = args.readiness?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const expectStatus = args.readiness?.expectStatus ?? 200;
  const timeoutMs = args.readiness?.timeoutMs ?? 5000;

  let lastResult: HttpProbeResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (hasProcessExited(args.process)) {
      const exitState = args.exitStateRef();
      await appendLogLine(
        args.logFile,
        `[health] process exited before readiness (code=${exitState?.code ?? "null"}, signal=${exitState?.signal ?? "null"})`,
      );
      const baseResult: ServerReadinessResult = {
        ok: false,
        attempts: attempt - 1,
        ...(lastResult ? { lastResult } : {}),
      };
      return exitState ? { ...baseResult, exitState } : baseResult;
    }

    const token = args.env.MCP_HTTP_TOKEN;
    const probeOptions: HttpHealthOptions = {
      expectStatus,
      timeoutMs,
      ...(token ? { token } : {}),
    };
    const result = await args
      .verifyHealth(args.healthUrl, probeOptions)
      .catch((error) => ({ ok: false, error: formatError(error) } satisfies HttpProbeResult));

    lastResult = result;
    if (result.ok) {
      await appendLogLine(args.logFile, `[health] attempt ${attempt} succeeded (${result.statusCode ?? "unknown status"})`);
      return { ok: true, attempts: attempt, lastResult: result };
    }

    const statusInfo =
      result.error ??
      (("statusCode" in result && result.statusCode !== undefined)
        ? `status ${result.statusCode}`
        : "status unknown");
    await appendLogLine(args.logFile, `[health] attempt ${attempt} failed (${statusInfo})`);

    if (attempt < maxAttempts) {
      await args.sleep(interval);
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    ...(lastResult ? { lastResult } : {}),
  };
}

/** Computes the health URL based on the resolved environment and options. */
function computeHealthUrl(env: NodeJS.ProcessEnv, options: StartValidationServerOptions): string {
  if (options.readiness?.healthUrl) {
    return options.readiness.healthUrl;
  }

  const host = env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = env.MCP_HTTP_PORT ?? "8765";
  const basePath = env.MCP_HTTP_PATH ?? "/mcp";
  const endpoint = options.readiness?.healthEndpoint ?? "health";

  const baseUrl = new URL(addTrailingSlash(basePath), `http://${host}:${port}`);
  return new URL(endpoint, baseUrl).toString();
}

/** Determines whether the child process already exited. */
function hasProcessExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null || child.killed;
}

/**
 * Pipes stdout/stderr to the aggregated log file with explicit channel markers
 * so that operators can differentiate between regular output and errors.
 */
function wireProcessLogging(child: ChildProcessWithoutNullStreams, logFile: string): void {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    void appendLogLine(logFile, `[stdout] ${chunk.trimEnd()}`);
  });

  child.stderr.on("data", (chunk) => {
    void appendLogLine(logFile, `[stderr] ${chunk.trimEnd()}`);
  });

  child.once("error", (error) => {
    void appendLogLine(logFile, `[error] server process error: ${formatError(error)}`);
  });

  child.once("exit", (code, signal) => {
    void appendLogLine(
      logFile,
      `[exit] code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
  });
}

/** Gracefully stops the child process, escalating to SIGKILL after a timeout. */
async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  logFile: string,
  signal: NodeJS.Signals | number = "SIGTERM",
  timeoutMs = 5000,
): Promise<void> {
  if (hasProcessExited(child)) {
    return;
  }

  await appendLogLine(logFile, `[info] stopping server with ${typeof signal === "number" ? signal : signal}`);

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!hasProcessExited(child)) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      resolve();
    };

    child.once("exit", cleanup);
    const killed = child.kill(signal);
    if (!killed) {
      child.removeListener("exit", cleanup);
      cleanup();
    }
  });
}

/** Appends an informational header each time the server is spawned. */
async function appendLogHeader(
  logFile: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const header = [
    `# Validation server start - ${new Date().toISOString()}`,
    `# Command: ${command} ${args.join(" ")}`.trimEnd(),
    `# MCP_HTTP_HOST=${env.MCP_HTTP_HOST ?? ""}`,
    `# MCP_HTTP_PORT=${env.MCP_HTTP_PORT ?? ""}`,
    `# MCP_HTTP_PATH=${env.MCP_HTTP_PATH ?? ""}`,
    env.MCP_HTTP_TOKEN ? "# MCP_HTTP_TOKEN configured" : "# MCP_HTTP_TOKEN missing",
  ].join("\n");
  await appendLogLine(logFile, header);
}

/** Appends a single line to the log file, ensuring a trailing newline. */
async function appendLogLine(logFile: string, line: string): Promise<void> {
  await appendFile(logFile, `${line}\n`);
}

/** Returns a canonical MCP token. */
function defaultTokenFactory(): string {
  return randomBytes(24).toString("hex");
}

/** Default sleep helper relying on `setTimeout`. */
async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ensures the MCP base path always contains a leading slash without trailing separators. */
function normaliseBasePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "/";
  }
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeading === "/") {
    return withLeading;
  }
  return withLeading.replace(/\/+$/, "");
}

/** Ensures a trailing slash for URL composition while avoiding duplicates. */
function addTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/** Normalises an error so it can be logged safely. */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

