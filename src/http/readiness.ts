/**
 * Helpers powering the HTTP readiness probe. The functions provided here remain
 * agnostic of the surrounding server wiring so they can be exercised directly
 * by unit tests while the composition root assembles the concrete dependencies.
 */
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve as resolvePath } from "node:path";

/** Status object shared by most readiness components. */
export interface HttpComponentStatus {
  /** Whether the dependency is currently healthy. */
  ok: boolean;
  /** Optional human friendly message surfaced to operators. */
  message?: string;
}

/**
 * Readiness details for the runs/ directory check. Operators receive the path
 * that was verified so they can correlate configuration issues quickly.
 */
export interface HttpRunsDirectoryStatus extends HttpComponentStatus {
  /** Absolute path of the directory that was probed. */
  path: string;
}

/** Readiness report emitted by the HTTP probe. */
export interface HttpReadinessReport {
  ok: boolean;
  components: {
    graphForge: HttpComponentStatus;
    runsDirectory: HttpRunsDirectoryStatus;
    idempotency: HttpComponentStatus;
    eventQueue: HttpComponentStatus & { usage: number; capacity: number };
  };
}

/**
 * Dependencies injected by the HTTP composition root. Keeping the contract
 * lightweight ensures tests can stub the collaborators without standing up the
 * entire server.
 */
export interface HttpReadinessCheckDependencies {
  /** Lazy loader that resolves once the Graph Forge façade is ready. */
  loadGraphForge: () => Promise<unknown>;
  /** Directory expected to host orchestration artefacts under `runs/`. */
  runsRoot: string;
  /** Event store exposing utilisation metrics for the SSE/event bridge. */
  eventStore: { getEventCount(): number; getMaxHistory(): number };
  /** Optional persistent idempotency store backing stateless HTTP flows. */
  idempotencyStore?: { checkHealth?: () => Promise<void> } | null;
}

/**
 * Evaluates the readiness of the HTTP surface by probing each dependency in
 * sequence. The helper keeps the error handling explicit so operators receive
 * actionable diagnostics when the probe returns `503`.
 */
export async function evaluateHttpReadiness(
  deps: HttpReadinessCheckDependencies,
): Promise<HttpReadinessReport> {
  const components: HttpReadinessReport["components"] = {
    graphForge: { ok: true, message: "module loaded" },
    runsDirectory: { ok: true, path: resolvePath(deps.runsRoot), message: "read/write verified" },
    idempotency: deps.idempotencyStore
      ? { ok: true, message: "store available" }
      : { ok: true, message: "idempotency disabled" },
    eventQueue: {
      ok: true,
      usage: Math.max(0, deps.eventStore.getEventCount()),
      capacity: Math.max(1, deps.eventStore.getMaxHistory()),
      message: "queue within capacity",
    },
  };

  let ok = true;

  try {
    await deps.loadGraphForge();
  } catch (error) {
    ok = false;
    components.graphForge = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const runsStatus = await verifyRunsDirectory(deps.runsRoot);
  components.runsDirectory = runsStatus;
  if (!runsStatus.ok) {
    ok = false;
  }

  if (deps.idempotencyStore?.checkHealth) {
    try {
      await deps.idempotencyStore.checkHealth();
    } catch (error) {
      ok = false;
      components.idempotency = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const capacity = Math.max(1, deps.eventStore.getMaxHistory());
  const usage = Math.max(0, deps.eventStore.getEventCount());
  const threshold = Math.ceil(capacity * 0.9);
  const queueHealthy = usage < threshold;
  components.eventQueue = {
    ok: queueHealthy,
    usage,
    capacity,
    message: queueHealthy ? "queue within capacity" : "event history near capacity",
  };
  if (!queueHealthy) {
    ok = false;
  }

  return { ok, components };
}

/**
 * Ensures the orchestrator can read and write to the configured `runs/` root.
 * A sentinel file is written and removed to catch both permission issues and
 * read-only mounts.
 */
async function verifyRunsDirectory(root: string): Promise<HttpRunsDirectoryStatus> {
  const resolvedRoot = resolvePath(root);
  try {
    await mkdir(resolvedRoot, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      path: resolvedRoot,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const sentinelPath = resolvePath(resolvedRoot, ".readyz.sentinel");
  try {
    await writeFile(sentinelPath, "ready\n", { flag: "w" });
    await access(sentinelPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    await rm(sentinelPath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path: resolvedRoot,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  await rm(sentinelPath, { force: true }).catch(() => undefined);
  return { ok: true, path: resolvedRoot, message: "read/write verified" };
}
