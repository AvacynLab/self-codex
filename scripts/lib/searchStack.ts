import { spawn as defaultSpawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as defaultDelay } from "node:timers/promises";

/**
 * Absolute path to the dedicated search docker-compose manifest. The helper
 * lives under `scripts/lib`, so we need to walk two directories up to reach the
 * repository root before jumping into `docker/`.
 */
export const defaultSearchComposeFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docker/docker-compose.search.yml",
);

/**
 * Dependencies required by {@link createSearchStackManager}. Exposed for tests
 * so suites can provide lightweight fakes without shelling out to Docker or
 * waiting on real timers.
 */
export interface SearchStackDependencies {
  readonly spawn?: typeof defaultSpawn;
  readonly delay?: typeof defaultDelay;
  readonly fetchImpl?: typeof fetch;
  readonly composeFile?: string;
}

/**
 * Declarative policy describing whether the orchestration helpers should
 * actively start or stop the dockerised search stack. This allows higher-level
 * scripts to reuse already running containers (for example when a CI job
 * primes the stack once and runs multiple suites against it) without
 * duplicating environment parsing in every entrypoint.
 */
export interface SearchStackLifecyclePolicy {
  readonly shouldBringUp: boolean;
  readonly shouldTearDown: boolean;
}

/**
 * Computes the {@link SearchStackLifecyclePolicy} from process environment
 * variables. The helper recognises `SEARCH_STACK_REUSE` so callers can opt-in
 * to container reuse by setting it to "1", "true", "yes", "hold", "retain" or "cache"
 * (case insensitive). Operators that provide an externally managed stack can pass
 * "external", "skip" or "manual" to disable both the bring-up and tear-down phases.
 *
 * @param env optional bag of environment variables, exposed for unit tests so
 * they can provide deterministic maps without mutating `process.env`.
 */
export function resolveStackLifecyclePolicy(
  env: NodeJS.ProcessEnv = process.env,
): SearchStackLifecyclePolicy {
  const rawReuseFlag = env.SEARCH_STACK_REUSE ?? "";
  const normalizedFlag = rawReuseFlag.trim().toLowerCase();

  /**
   * Allow CI (or advanced operators) to indicate that the stack is provisioned externally.
   * In that scenario the helper neither attempts to start the containers nor to stop them,
   * and instead assumes some other process already manages their lifecycle.
   */
  const externallyManaged = normalizedFlag === "external" || normalizedFlag === "skip" || normalizedFlag === "manual";
  if (externallyManaged) {
    return { shouldBringUp: false, shouldTearDown: false };
  }

  /**
   * Interpret common truthy tokens as a request to retain the stack after the suite finishes.
   * The helper still brings the containers up so the first suite primes them, but it skips the
   * teardown step to keep the services warm for subsequent suites (for example smoke tests).
   */
  const reuseEnabled =
    normalizedFlag === "1" ||
    normalizedFlag === "true" ||
    normalizedFlag === "yes" ||
    normalizedFlag === "hold" ||
    normalizedFlag === "retain" ||
    normalizedFlag === "cache";
  if (reuseEnabled) {
    return { shouldBringUp: true, shouldTearDown: false };
  }

  return { shouldBringUp: true, shouldTearDown: true };
}

/** Options accepted by {@link SearchStackManager.waitForService}. */
export interface WaitForServiceOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly acceptStatus?: (status: number) => boolean;
}

/**
 * Runtime contract implemented by the helper controlling the dockerised search
 * stack. All methods resolve once their underlying command completes and never
 * throw `undefined` values so exact optional property typing remains satisfied.
 */
export interface SearchStackManager {
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options?: RunCommandOptions,
  ) => Promise<number>;
  readonly isDockerAvailable: () => Promise<boolean>;
  readonly waitForService: (url: string, options?: WaitForServiceOptions) => Promise<void>;
  readonly waitForSearxReady: () => Promise<void>;
  readonly waitForUnstructuredReady: () => Promise<void>;
  readonly bringUpStack: () => Promise<void>;
  readonly tearDownStack: (options?: { readonly allowFailure?: boolean }) => Promise<void>;
  readonly composeFile: string;
}

/** Extra options supported by {@link SearchStackManager.runCommand}. */
export interface RunCommandOptions {
  readonly inheritStdio?: boolean;
  readonly allowFailure?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Creates a new {@link SearchStackManager} using the supplied dependencies. The
 * helper keeps the orchestration logic centralised so both automation scripts
 * and tests can reuse it without duplicating spawn logic or retry loops.
 */
export function createSearchStackManager(deps: SearchStackDependencies = {}): SearchStackManager {
  const spawn = deps.spawn ?? defaultSpawn;
  const delay = deps.delay ?? defaultDelay;
  const composeFile = deps.composeFile ?? defaultSearchComposeFile;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function runCommand(
    command: string,
    args: readonly string[],
    options: RunCommandOptions = {},
  ): Promise<number> {
    const { inheritStdio = true, allowFailure = false, env } = options;
    const spawnOptions: SpawnOptions = {
      stdio: inheritStdio ? "inherit" : "pipe",
      env: env ? { ...process.env, ...env } : process.env,
    };
    const child = spawn(command, args.slice(), spawnOptions);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.on("close", (code) => {
        resolve(typeof code === "number" ? code : 0);
      });
    });
    if (exitCode !== 0 && !allowFailure) {
      throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}`);
    }
    return exitCode;
  }

  async function isDockerAvailable(): Promise<boolean> {
    try {
      const child = spawn("docker", ["--version"], { stdio: "ignore" });
      return await new Promise<boolean>((resolve) => {
        child.on("error", () => {
          resolve(false);
        });
        child.on("close", (code) => {
          resolve(code === 0);
        });
      });
    } catch {
      return false;
    }
  }

  async function waitForService(url: string, options: WaitForServiceOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const method = options.method ?? "GET";
    const headers = options.headers ?? {};
    const body = options.body ?? undefined;
    const acceptStatus = options.acceptStatus;
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetchImpl(url, { method, headers, body });
        const rawStatus = (response as { status: unknown }).status;
        const statusCode =
          typeof rawStatus === "number" ? rawStatus : Number.parseInt(String(rawStatus), 10);
        if (response.ok || (acceptStatus && acceptStatus(statusCode))) {
          return;
        }
        const statusLabel = Number.isNaN(statusCode) ? rawStatus : statusCode;
        lastError = new Error(`status ${statusLabel}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await delay(intervalMs);
    }
    const reason = lastError ? lastError.message : `timeout after ${timeoutMs}ms`;
    throw new Error(`Timed out waiting for ${url}: ${reason}`);
  }

  async function waitForSearxReady(): Promise<void> {
    /**
     * Keep the python probe in sync with the container healthcheck so we reuse the same
     * acceptance criteria (status codes below 500) and loopback forwarding headers. By
     * executing the probe inside the container we bypass host-network restrictions that make
     * Undici-based fetches fail in CI despite the service being healthy.
     */
    const readinessProbe = [
      "import sys",
      "from urllib import request, error",
      "",
      "STATUS_OK_MAX = 499",
      "URLS = (",
      "    'http://127.0.0.1:8080/healthz',",
      "    'http://127.0.0.1:8080/',",
      "    'http://localhost:8080/healthz',",
      "    'http://localhost:8080/',",
      "    'http://[::1]:8080/healthz',",
      "    'http://[::1]:8080/',",
      ")",
      "HEADERS = {",
      "    'X-Forwarded-For': '127.0.0.1',",
      "    'X-Real-IP': '127.0.0.1',",
      "}",
      "",
      "def probe(url):",
      "    req = request.Request(url, headers=HEADERS)",
      "    try:",
      "        response = request.urlopen(req, timeout=10)",
      "    except error.HTTPError as http_error:",
      "        return http_error.code <= STATUS_OK_MAX",
      "    except Exception:",
      "        return False",
      "    status = getattr(response, 'status', 500)",
      "    return status <= STATUS_OK_MAX",
      "",
      "if any(probe(url) for url in URLS):",
      "    sys.exit(0)",
      "sys.exit(1)",
    ].join("\n");

    const retryDelayMs = 2_000;
    const maxAttempts = 30;
    const probeArgs = [
      "compose",
      "-f",
      composeFile,
      "exec",
      "-T",
      "searxng",
      "python3",
      "-c",
      readinessProbe,
    ];

    let lastFailure: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const exitCode = await runCommand("docker", probeArgs, {
          allowFailure: true,
          inheritStdio: false,
        });
        if (exitCode === 0) {
          return;
        }
        lastFailure = new Error(`probe exited with code ${exitCode}`);
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error(String(error));
      }
      await delay(retryDelayMs);
    }
    throw lastFailure ?? new Error("Searx readiness probe failed after repeated attempts");
  }

  async function waitForUnstructuredReady(): Promise<void> {
    try {
      await waitForService("http://127.0.0.1:8000/healthcheck", {
        timeoutMs: 90_000,
        intervalMs: 2_000,
      });
      return;
    } catch (healthError) {
      // fall through to the legacy inference endpoint if /healthcheck is missing
      void healthError; // suppress unused variable lint complaints
    }

    await waitForService("http://127.0.0.1:8000/general/v0/general", {
      timeoutMs: 90_000,
      intervalMs: 2_000,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
      acceptStatus: (status) => status === 422,
    });
  }

  async function bringUpStack(): Promise<void> {
    await runCommand("docker", ["compose", "-f", composeFile, "up", "-d", "--wait"]);
  }

  async function tearDownStack(options: { readonly allowFailure?: boolean } = {}): Promise<void> {
    await runCommand("docker", ["compose", "-f", composeFile, "down", "-v"], {
      allowFailure: options.allowFailure ?? true,
    });
  }

  return {
    runCommand,
    isDockerAvailable,
    waitForService,
    waitForSearxReady,
    waitForUnstructuredReady,
    bringUpStack,
    tearDownStack,
    composeFile,
  };
}
