import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import process from "node:process";

import {
  configureRuntimeFeatures,
  configureRuntimeTimings,
  configureChildSafetyLimits,
  configureReflectionEnabled,
  configureQualityGateEnabled,
  configureQualityGateThreshold,
  configureLogFileOverride,
  server,
  eventStore,
  eventBus,
  logger,
  graphState,
  childSupervisor,
  contractNetWatcherTelemetry,
  orchestratorSupervisor,
  stigmergy,
  btStatusRegistry,
  IDEMPOTENCY_TTL_OVERRIDE,
} from "./orchestrator/runtime.js";
import { parseOrchestratorRuntimeOptions } from "./serverOptions.js";
import { startHttpServer, type HttpServerExtras } from "./httpServer.js";
import { evaluateHttpReadiness } from "./http/readiness.js";
import { startDashboardServer } from "./monitor/dashboard.js";
import { loadGraphForge } from "./graph/forgeLoader.js";
import { FileIdempotencyStore } from "./infra/idempotencyStore.file.js";
import { resolveIdempotencyDirectory } from "./infra/idempotencyStore.js";
import { updateMcpRuntimeSnapshot } from "./mcp/info.js";

export * from "./orchestrator/runtime.js";

/**
 * Bootstraps the orchestrator when the module is executed directly via the CLI.
 * The function parses runtime options, wires transports and registers shutdown
 * hooks while delegating the heavy lifting to the orchestrator runtime module.
 */
async function main(): Promise<void> {
  let options;
  try {
    options = parseOrchestratorRuntimeOptions(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("cli_options_invalid", { message });
    process.exit(1);
  }

  // Apply CLI overrides to the orchestrator core so subsequent requests inherit
  // the negotiated features, timings, and guardrails.
  configureRuntimeFeatures(options.features);
  configureRuntimeTimings(options.timings);
  configureChildSafetyLimits(options.safety);
  configureReflectionEnabled(options.enableReflection);
  configureQualityGateEnabled(options.enableQualityGate);
  configureQualityGateThreshold(options.qualityThreshold);
  configureLogFileOverride(options.logFile ?? null);

  eventStore.setMaxHistory(options.maxEventHistory);
  eventBus.setHistoryLimit(options.maxEventHistory);
  updateMcpRuntimeSnapshot({ limits: { maxEventHistory: options.maxEventHistory } });

  let enableStdio = options.enableStdio;
  const httpEnabled = options.http.enabled;

  updateMcpRuntimeSnapshot({
    transports: {
      stdio: { enabled: enableStdio },
      http: {
        enabled: httpEnabled,
        host: httpEnabled ? options.http.host : null,
        port: httpEnabled ? options.http.port : null,
        path: httpEnabled ? options.http.path : null,
        enableJson: options.http.enableJson,
        stateless: options.http.stateless,
      },
    },
  });

  if (!enableStdio && !httpEnabled) {
    logger.error("no_transport_enabled", {});
    process.exit(1);
  }

  // Registered transport/dash cleanup callbacks executed during SIGINT handling.
  const cleanup: Array<() => Promise<void>> = [];

  if (httpEnabled) {
    if (enableStdio) {
      logger.warn("stdio_disabled_due_to_http");
      enableStdio = false;
    }

    let httpExtras: HttpServerExtras = {};
    let httpIdempotencyStore: FileIdempotencyStore | null = null;
    if (options.http.stateless) {
      try {
        const store = await FileIdempotencyStore.create();
        const ttlMs = IDEMPOTENCY_TTL_OVERRIDE ?? 600_000;
        httpIdempotencyStore = store;
        httpExtras = { idempotency: { store, ttlMs } };
        logger.info("http_idempotency_store_ready", {
          directory: resolveIdempotencyDirectory(),
          ttl_ms: ttlMs,
        });
      } catch (error) {
        logger.error("http_idempotency_store_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const runsRoot = process.env.MCP_RUNS_ROOT
      ? resolvePath(process.cwd(), process.env.MCP_RUNS_ROOT)
      : resolvePath(process.cwd(), "runs");

    // Dependencies evaluated by the HTTP readiness probe. Sharing the object
    // keeps the `check` closure free of stateful mutations.
    const readinessDeps = {
      loadGraphForge,
      runsRoot,
      idempotencyStore: httpIdempotencyStore,
      eventStore,
    } as const;

    httpExtras = {
      ...httpExtras,
      readiness: {
        check: () => evaluateHttpReadiness(readinessDeps),
      },
    };

    try {
      const handle = await startHttpServer(server, options.http, logger, httpExtras);
      cleanup.push(handle.close);
    } catch (error) {
      logger.error("http_start_failed", { message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  }

  if (options.dashboard.enabled) {
    try {
      const handle = await startDashboardServer({
        host: options.dashboard.host,
        port: options.dashboard.port,
        streamIntervalMs: options.dashboard.streamIntervalMs,
        graphState,
        supervisor: childSupervisor,
        eventStore,
        stigmergy,
        btStatusRegistry,
        supervisorAgent: orchestratorSupervisor,
        logger,
        contractNetWatcherTelemetry,
      });
      cleanup.push(handle.close);
    } catch (error) {
      logger.error("dashboard_start_failed", { message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  }

  if (enableStdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("stdio_listening");
  }

  logger.info("runtime_started", {
    stdio: enableStdio,
    http: httpEnabled,
    max_event_history: eventStore.getMaxHistory(),
  });

  process.on("SIGINT", async () => {
    logger.warn("shutdown_signal", { signal: "SIGINT" });
    for (const closer of cleanup) {
      try {
        await closer();
      } catch (error) {
        logger.error("transport_close_failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    process.exit(0);
  });
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  void main();
}
