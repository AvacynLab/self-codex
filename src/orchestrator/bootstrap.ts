import type { HttpRuntimeOptions, OrchestratorRuntimeOptions } from "../serverOptions.js";

import {
  configureRuntimeFeatures,
  configureRuntimeTimings,
  configureChildSafetyLimits,
  configureReflectionEnabled,
  configureQualityGateEnabled,
  configureQualityGateThreshold,
  configureLogFileOverride,
  eventStore,
  eventBus,
} from "./runtime.js";
import { updateMcpRuntimeSnapshot } from "../mcp/info.js";

/**
 * Applies the CLI/runtime options to the orchestrator core before transports start.
 *
 * Keeping this helper separate from the composition root makes the boot process
 * easier to exercise in isolation and guarantees `server.ts` stays focused on
 * wiring transports instead of mutating global orchestrator state directly.
 */
export function applyOrchestratorRuntimeOptions(options: OrchestratorRuntimeOptions): void {
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
}

/**
 * Publishes the current transport configuration so observability tooling and
 * downstream agents can introspect which surfaces are active.
 */
export function publishTransportSnapshot(enableStdio: boolean, http: HttpRuntimeOptions): void {
  updateMcpRuntimeSnapshot({
    transports: {
      stdio: { enabled: enableStdio },
      http: {
        enabled: http.enabled,
        host: http.enabled ? http.host : null,
        port: http.enabled ? http.port : null,
        path: http.enabled ? http.path : null,
        enableJson: http.enableJson,
        stateless: http.stateless,
      },
    },
  });
}
