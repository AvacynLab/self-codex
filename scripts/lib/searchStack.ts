import { spawn as defaultSpawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as defaultDelay } from "node:timers/promises";

/** Absolute path to the dedicated search docker-compose manifest. */
export const defaultSearchComposeFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../docker/docker-compose.search.yml",
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

/** Options accepted by {@link SearchStackManager.waitForService}. */
export interface WaitForServiceOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
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
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetchImpl(url, { method, headers, body });
        if (response.ok) {
          return;
        }
        lastError = new Error(`status ${response.status}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await delay(intervalMs);
    }
    const reason = lastError ? lastError.message : `timeout after ${timeoutMs}ms`;
    throw new Error(`Timed out waiting for ${url}: ${reason}`);
  }

  async function waitForSearxReady(): Promise<void> {
    try {
      await waitForService("http://127.0.0.1:8080/healthz", { timeoutMs: 90_000, intervalMs: 2_000 });
    } catch {
      await waitForService("http://127.0.0.1:8080", { timeoutMs: 30_000, intervalMs: 2_000 });
    }
  }

  async function waitForUnstructuredReady(): Promise<void> {
    await waitForService("http://127.0.0.1:8000/general/v0/general", {
      timeoutMs: 90_000,
      intervalMs: 2_000,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
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
