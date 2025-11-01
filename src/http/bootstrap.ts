import { resolve as resolvePath } from "node:path";
import process from "node:process";

import type { HttpServerExtras } from "../httpServer.js";
import type { StructuredLogger } from "../logger.js";
import type { EventStore } from "../eventStore.js";
import type { HttpRuntimeOptions } from "../serverOptions.js";
import { evaluateHttpReadiness } from "./readiness.js";
import { IDEMPOTENCY_TTL_OVERRIDE } from "../orchestrator/runtime.js";
import { FileIdempotencyStore } from "../infra/idempotencyStore.file.js";
import { loadGraphForge } from "../graph/forgeLoader.js";
import { readOptionalString } from "../config/env.js";

/**
 * Context required to prepare the HTTP transport before the server starts.
 */
export interface PrepareHttpRuntimeContext {
  /** CLI/flag derived configuration for the HTTP surface. */
  readonly options: HttpRuntimeOptions;
  /** Logger used to emit structured diagnostics during bootstrap. */
  readonly logger: StructuredLogger;
  /** Event store exposing utilisation metrics for readiness probes. */
  readonly eventStore: EventStore;
}

/**
 * Dependencies that can be overridden by tests. Keeping the hooks explicit
 * avoids performing heavy filesystem or module loading operations when the
 * helper is exercised in isolation.
 */
export interface PrepareHttpRuntimeDependencies {
  /** Optional lazy Graph Forge loader used by the readiness probe. */
  readonly loadGraphForge?: () => Promise<unknown>;
  /**
   * Factory creating the persistent idempotency store. The helper receives the
   * directory where artefacts should be stored.
   */
  readonly createIdempotencyStore?: (directory: string) => Promise<FileIdempotencyStore>;
  /**
   * Resolver returning the absolute `validation_run/` root used by the orchestrator to
   * persist artefacts. The default implementation honours `MCP_RUNS_ROOT`.
   */
  readonly resolveRunsRoot?: (cwd: string, override: string | undefined) => string;
}

/** Result returned after preparing the HTTP runtime dependencies. */
export interface PreparedHttpRuntime {
  /** Extra wiring forwarded to {@link startHttpServer}. */
  readonly extras: HttpServerExtras;
  /** Idempotency store backing stateless HTTP flows (when enabled). */
  readonly idempotencyStore: FileIdempotencyStore | null;
  /** Absolute path of the runs directory checked by readiness probes. */
  readonly runsRoot: string;
}

/** Default TTL applied when no environment override is provided. */
const DEFAULT_IDEMPOTENCY_TTL_MS = 600_000;

function defaultResolveRunsRoot(cwd: string, override: string | undefined): string {
  if (override && override.trim().length > 0) {
    return resolvePath(cwd, override);
  }
  return resolvePath(cwd, "validation_run");
}

/**
 * Prepares the HTTP runtime dependencies (idempotency store, readiness probe)
 * while keeping side effects encapsulated. The composition root can then focus
 * on wiring transports without duplicating setup logic.
 */
export async function prepareHttpRuntime(
  context: PrepareHttpRuntimeContext,
  deps: PrepareHttpRuntimeDependencies = {},
): Promise<PreparedHttpRuntime> {
  const resolveRunsRoot = deps.resolveRunsRoot ?? defaultResolveRunsRoot;
  const envOverride = readOptionalString("MCP_RUNS_ROOT");
  const runsRoot = resolveRunsRoot(process.cwd(), envOverride);

  const extras: HttpServerExtras = {};
  let idempotencyStore: FileIdempotencyStore | null = null;

  // Surface the orchestrator event store to the HTTP layer so it can emit
  // structured access logs alongside the existing runtime events.
  extras.eventStore = context.eventStore;

  if (context.options.stateless) {
    const directory = resolvePath(runsRoot, "idempotency");
    const createStore =
      deps.createIdempotencyStore ?? ((dir: string) => FileIdempotencyStore.create({ directory: dir }));
    try {
      const store = await createStore(directory);
      idempotencyStore = store;
      const ttlMs = IDEMPOTENCY_TTL_OVERRIDE ?? DEFAULT_IDEMPOTENCY_TTL_MS;
      extras.idempotency = { store, ttlMs };
      context.logger.info("http_idempotency_store_ready", { directory, ttl_ms: ttlMs });
    } catch (error) {
      context.logger.error("http_idempotency_store_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const loadForge = deps.loadGraphForge ?? loadGraphForge;
  extras.readiness = {
    check: () =>
      evaluateHttpReadiness({
        loadGraphForge: () => loadForge(),
        runsRoot,
        eventStore: context.eventStore,
        idempotencyStore,
      }),
  };

  return { extras, idempotencyStore, runsRoot };
}

/** Internal hooks exposed solely for targeted unit tests. */
export const __httpBootstrapInternals = {
  defaultResolveRunsRoot,
};
