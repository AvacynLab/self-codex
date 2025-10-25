/**
 * Shared timeout resolution helpers for child runtimes.
 *
 * The orchestrator exposes several knobs to tune the lifecycle of sandboxed
 * subprocesses (spawn readiness, graceful shutdown, forced termination). The
 * helpers below read the associated environment variables once per call and
 * provide guardrails (bounds, defaults, ability to disable a timeout) so the
 * rest of the codebase can consistently derive effective deadlines without
 * sprinkling ad-hoc parsing logic.
 */
import { readOptionalInt } from "../config/env.js";

/** Maximum timeout (in milliseconds) accepted from environment overrides. */
const MAX_TIMEOUT_MS = 600_000; // 10 minutes keeps runaway values in check.

/** Default time (in milliseconds) granted to children to advertise readiness. */
const DEFAULT_READY_TIMEOUT_MS = 2_000;

/** Default time (in milliseconds) granted to graceful shutdown attempts. */
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Internal helper that normalises timeout values (integers, finite, within
 * bounds). Returning the provided fallback keeps the calling code easy to read
 * while avoiding duplicated validation logic.
 */
function sanitiseTimeout(
  value: number | undefined,
  fallback: number | undefined,
  {
    allowZero = false,
    min,
    max,
    treatZeroAsUndefined = false,
  }: { allowZero?: boolean; min?: number; max?: number; treatZeroAsUndefined?: boolean } = {},
): number | undefined {
  if (value === undefined || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }

  const integer = Math.trunc(value);
  const effectiveMin = allowZero ? 0 : min ?? 1;
  if (integer < effectiveMin) {
    return fallback;
  }

  const bounded = max !== undefined ? Math.min(integer, max) : integer;
  if (treatZeroAsUndefined && bounded === 0) {
    return undefined;
  }

  return bounded;
}

function chooseTimeout(
  explicit: number | undefined,
  envOverride: number | undefined,
  fallback: number | undefined,
  options?: {
    allowZero?: boolean;
    min?: number;
    max?: number;
    treatZeroAsUndefined?: boolean;
  },
): number | undefined {
  if (explicit !== undefined) {
    return sanitiseTimeout(explicit, fallback, options);
  }
  if (envOverride !== undefined) {
    return sanitiseTimeout(envOverride, fallback, options);
  }
  return fallback;
}

function readSpawnTimeoutOverride(): number | undefined {
  return readOptionalInt("MCP_CHILD_SPAWN_TIMEOUT_MS", { min: 0, max: MAX_TIMEOUT_MS });
}

function readReadyTimeoutOverride(): number | undefined {
  return readOptionalInt("MCP_CHILD_READY_TIMEOUT_MS", { min: 1, max: MAX_TIMEOUT_MS });
}

function readGracefulShutdownOverride(): number | undefined {
  return readOptionalInt("MCP_CHILD_SHUTDOWN_GRACE_MS", { min: 1, max: MAX_TIMEOUT_MS });
}

function readForceShutdownOverride(): number | undefined {
  return readOptionalInt("MCP_CHILD_SHUTDOWN_FORCE_MS", { min: 0, max: MAX_TIMEOUT_MS });
}

/**
 * Resolves the timeout (in milliseconds) granted to child processes to emit
 * their readiness message. The explicit parameter takes precedence, followed by
 * `MCP_CHILD_READY_TIMEOUT_MS`, finally falling back to the historical default
 * (2 seconds).
 */
export function resolveChildReadyTimeout(explicit?: number): number {
  const resolved = chooseTimeout(explicit, readReadyTimeoutOverride(), DEFAULT_READY_TIMEOUT_MS, {
    min: 1,
    max: MAX_TIMEOUT_MS,
  });
  return resolved ?? DEFAULT_READY_TIMEOUT_MS;
}

/**
 * Resolves the timeout (in milliseconds) used when waiting for children to
 * acknowledge a graceful shutdown request. Environment overrides use
 * `MCP_CHILD_SHUTDOWN_GRACE_MS`; callers can still override the value per
 * invocation by passing the `timeoutMs` option explicitly.
 */
export function resolveChildGracefulShutdownTimeout(explicit?: number): number {
  const resolved = chooseTimeout(explicit, readGracefulShutdownOverride(), DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS, {
    min: 1,
    max: MAX_TIMEOUT_MS,
  });
  return resolved ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Resolves the timeout (in milliseconds) used after forcefully terminating a
 * child (SIGKILL) before giving up. Returning `undefined` preserves the legacy
 * behaviour where the orchestrator waits indefinitely unless
 * `MCP_CHILD_SHUTDOWN_FORCE_MS` or an explicit override is supplied. Supplying
 * `0` disables the forced timeout (matching "wait forever").
 */
export function resolveChildForceShutdownTimeout(explicit?: number): number | undefined {
  return chooseTimeout(explicit, readForceShutdownOverride(), undefined, {
    allowZero: true,
    min: 0,
    max: MAX_TIMEOUT_MS,
    treatZeroAsUndefined: true,
  });
}

/**
 * Resolves the timeout (in milliseconds) applied to child spawn attempts. When
 * unset, the orchestrator does not impose a hard deadline (matching the
 * historical behaviour). Setting `MCP_CHILD_SPAWN_TIMEOUT_MS` or passing an
 * explicit override enables the guard; using `0` disables it.
 */
export function resolveChildSpawnTimeout(explicit?: number): number | undefined {
  return chooseTimeout(explicit, readSpawnTimeoutOverride(), undefined, {
    allowZero: true,
    min: 0,
    max: MAX_TIMEOUT_MS,
    treatZeroAsUndefined: true,
  });
}
