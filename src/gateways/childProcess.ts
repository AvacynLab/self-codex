/**
 * Hardened gateway responsible for spawning sandboxed child processes. The
 * factory enforces argument validation, environment allow-listing and timeout
 * propagation so supervisors interact with a predictable, fail-safe API.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { omitUndefinedEntries } from "../utils/object.js";

// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Options accepted by {@link ChildProcessGateway.spawn} to create a new child process
 * under strict security controls.
 */
export interface SpawnChildProcessOptions {
  /** Executable name or absolute path. Must not be empty. */
  readonly command: string;
  /** Ordered list of arguments forwarded as-is to {@link nodeSpawn}. */
  readonly args?: readonly string[];
  /** Optional working directory of the child process. */
  readonly cwd?: string;
  /**
   * Environment variables allowed to leak into the child process.
   *
   * Only the keys present in this allow-list will be propagated from either the
   * provided {@link inheritEnv} snapshot or the {@link extraEnv} overrides. All
   * other variables are dropped to prevent accidental exposure of credentials.
   */
  readonly allowedEnvKeys: readonly string[];
  /** Optional snapshot of environment variables to inherit (defaults to {@link process.env}). */
  readonly inheritEnv?: NodeJS.ProcessEnv;
  /** Explicit environment overrides (only keys from {@link allowedEnvKeys} are accepted). */
  readonly extraEnv?: Record<string, string | undefined>;
  /** Spawn stdio configuration (defaults to `pipe`). */
  readonly stdio?: SpawnOptions["stdio"];
  /** Optional timeout in milliseconds after which the child is aborted. */
  readonly timeoutMs?: number;
  /** External abort signal propagated to the child process. */
  readonly signal?: AbortSignal;
}

/**
 * Handle returned after spawning a child process.
 */
export interface SpawnedChildProcess {
  /** Underlying Node.js child process instance. */
  readonly child: ChildProcess;
  /** Abort signal controlling the lifecycle of the child process. */
  readonly signal: AbortSignal | undefined;
  /**
   * Clears internal listeners and timeout guards.
   *
   * @remarks The orchestrator only calls {@link dispose} when the spawn attempt
   * fails (for instance when the child crashes before it advertises readiness).
   * Custom gateway implementations must therefore ensure any listeners
   * required to enforce timeouts stay attached until the child exits naturally;
   * they should not rely on {@link dispose} being invoked after a successful
   * spawn.
   */
  dispose(): void;
}

/**
 * Error raised when the requested command name is invalid.
 */
export class InvalidChildProcessCommandError extends Error {
  constructor(command: string) {
    super(`Child process command must be a non-empty string. Received: "${command}".`);
    this.name = "InvalidChildProcessCommandError";
  }
}

/**
 * Error raised when an argument is not a valid string.
 */
export class InvalidChildProcessArgumentError extends TypeError {
  constructor(value: unknown, index: number) {
    super(`Child process arguments must be strings. Argument at index ${index} is ${typeof value}.`);
    this.name = "InvalidChildProcessArgumentError";
  }
}

/**
 * Error raised when an environment override attempts to inject a non-whitelisted key.
 */
export class ChildProcessEnvViolationError extends Error {
  constructor(key: string) {
    super(`Environment variable "${key}" is not allow-listed for the spawned child process.`);
    this.name = "ChildProcessEnvViolationError";
  }
}

/**
 * Error propagated when a child process exceeds its configured timeout.
 */
export class ChildProcessTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Child process exceeded its timeout of ${timeoutMs}ms.`);
    this.name = "ChildProcessTimeoutError";
  }
}

/**
 * Contract exposed by the child process gateway.
 */
export interface ChildProcessGateway {
  /** Spawns a child process enforcing argument sanitisation and environment whitelisting. */
  spawn(options: SpawnChildProcessOptions): SpawnedChildProcess;
}

/** Internal dependencies accepted by {@link createChildProcessGateway}. */
interface ChildProcessGatewayDeps {
  /** Concrete spawn implementation (defaults to Node.js {@link nodeSpawn}). */
  readonly spawnImpl?: typeof nodeSpawn;
}

/**
 * Factory returning the hardened child process gateway. Tests can inject a mock
 * {@link spawnImpl} to observe the wiring without launching real commands.
 */
export function createChildProcessGateway({
  spawnImpl = nodeSpawn,
}: ChildProcessGatewayDeps = {}): ChildProcessGateway {
  return {
    spawn(options: SpawnChildProcessOptions): SpawnedChildProcess {
      const command = options.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new InvalidChildProcessCommandError(command);
      }

      const args = normaliseArgs(options.args);
      const env = buildWhitelistedEnv({
        allowedKeys: options.allowedEnvKeys,
        ...(options.inheritEnv ? { inheritEnv: options.inheritEnv } : {}),
        ...(options.extraEnv ? { extraEnv: options.extraEnv } : {}),
      });

      const abortManagement = prepareAbortHandling(options.timeoutMs, options.signal);

      const spawnOptions: SpawnOptions = {
        ...omitUndefinedEntries({
          cwd: options.cwd,
          env,
          stdio: options.stdio ?? "pipe",
          shell: false,
          windowsVerbatimArguments: false,
          signal: abortManagement.signal,
        }),
      };

      let child: ChildProcess;
      try {
        child = spawnImpl(command, args, spawnOptions);
      } catch (error) {
        abortManagement.dispose();
        throw error;
      }

      abortManagement.arm(child);

      /**
       * Ensures the timeout guard and external abort listener are disposed at
       * most once regardless of which lifecycle event fires first. Node can
       * emit both `error` and `close` for certain failure modes therefore the
       * helper guards against double cleanup to keep the bookkeeping tight.
       */
      let disposed = false;
      const settle = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        abortManagement.dispose();
      };

      child.once("exit", settle);
      child.once("error", settle);
      child.once("close", settle);

      return {
        child,
        signal: abortManagement.signal,
        dispose(): void {
          child.removeListener("exit", settle);
          child.removeListener("error", settle);
          child.removeListener("close", settle);
          settle();
        },
      };
    },
  };
}

/**
 * Ensures the argument list exclusively contains strings while returning a
 * defensive copy to avoid mutation by the consumer after spawning the process.
 */
function normaliseArgs(args: SpawnChildProcessOptions["args"]): readonly string[] {
  if (args === undefined) {
    return [];
  }

  if (!Array.isArray(args)) {
    throw new InvalidChildProcessArgumentError(args, -1);
  }

  return args.map((value, index) => {
    if (typeof value !== "string") {
      throw new InvalidChildProcessArgumentError(value, index);
    }
    if (value.includes("\u0000")) {
      throw new InvalidChildProcessArgumentError(value, index);
    }
    return value;
  });
}

interface BuildEnvOptions {
  readonly allowedKeys: readonly string[];
  readonly inheritEnv?: NodeJS.ProcessEnv;
  readonly extraEnv?: Record<string, string | undefined>;
}

/**
 * Produces a new environment object containing only allow-listed keys.
 */
function buildWhitelistedEnv({
  allowedKeys,
  inheritEnv = process.env,
  extraEnv = {},
}: BuildEnvOptions): NodeJS.ProcessEnv {
  const allowSet = new Set(allowedKeys);
  const env: NodeJS.ProcessEnv = {};

  for (const key of Object.keys(extraEnv)) {
    if (!allowSet.has(key)) {
      throw new ChildProcessEnvViolationError(key);
    }
  }

  for (const key of allowSet) {
    if (Object.prototype.hasOwnProperty.call(extraEnv, key)) {
      const value = extraEnv[key];
      if (value !== undefined) {
        env[key] = value;
      }
      continue;
    }

    const inheritedValue = inheritEnv[key];
    if (inheritedValue !== undefined) {
      env[key] = inheritedValue;
    }
  }

  return env;
}

interface AbortManagement {
  readonly signal: AbortSignal | undefined;
  arm(child: ChildProcess): void;
  dispose(): void;
}

/**
 * Configures timeout and abort signal propagation for a spawned child.
 */
function prepareAbortHandling(
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | undefined,
): AbortManagement {
  if (timeoutMs === undefined && externalSignal === undefined) {
    return {
      signal: undefined,
      arm(): void {
        // No-op: neither timeout nor abort signal configured.
      },
      dispose(): void {
        // No-op: nothing to clean up.
      },
    };
  }

  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | null = null;
  let externalAbortListener: (() => void) | null = null;

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalAbortListener = () => {
        controller.abort(externalSignal.reason);
      };
      externalSignal.addEventListener("abort", externalAbortListener, { once: true });
    }
  }

  return {
    signal: controller.signal,
    arm(child: ChildProcess): void {
      if (timeoutMs === undefined || controller.signal.aborted) {
        return;
      }

      timeoutHandle = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(new ChildProcessTimeoutError(timeoutMs));
        }
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      if (typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    },
    dispose(): void {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (externalAbortListener !== null && externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", externalAbortListener);
        externalAbortListener = null;
      }
    },
  };
}

