import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { server, eventStore, logger, graphState, childProcessSupervisor, contractNetWatcherTelemetry, orchestratorSupervisor, stigmergy, btStatusRegistry, logJournal, } from "./orchestrator/runtime.js";
import { parseOrchestratorRuntimeOptions } from "./serverOptions.js";
import { startHttpServer } from "./httpServer.js";
import { startDashboardServer } from "./monitor/dashboard.js";
import { prepareHttpRuntime } from "./http/bootstrap.js";
import { applyOrchestratorRuntimeOptions, publishTransportSnapshot } from "./orchestrator/bootstrap.js";
export * from "./orchestrator/runtime.js";
/**
 * Bootstraps the orchestrator when the module is executed directly via the CLI.
 * The function parses runtime options, wires transports and registers shutdown
 * hooks while delegating the heavy lifting to the orchestrator runtime module.
 */
async function main() {
    let options;
    try {
        options = parseOrchestratorRuntimeOptions(process.argv.slice(2));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("cli_options_invalid", { message });
        process.exit(1);
    }
    // Apply CLI overrides to the orchestrator core so subsequent requests inherit
    // the negotiated features, timings, and guardrails.
    applyOrchestratorRuntimeOptions(options);
    let enableStdio = options.enableStdio;
    const httpEnabled = options.http.enabled;
    if (!enableStdio && !httpEnabled) {
        logger.error("no_transport_enabled", {});
        process.exit(1);
    }
    // Registered transport/dash cleanup callbacks executed during SIGINT handling.
    const cleanup = [];
    if (httpEnabled) {
        if (enableStdio) {
            logger.warn("stdio_disabled_due_to_http");
            enableStdio = false;
        }
        try {
            const preparedHttp = await prepareHttpRuntime({ options: options.http, logger, eventStore });
            const handle = await startHttpServer(server, options.http, logger, preparedHttp.extras);
            cleanup.push(handle.close);
        }
        catch (error) {
            logger.error("http_start_failed", { message: error instanceof Error ? error.message : String(error) });
            process.exit(1);
        }
    }
    publishTransportSnapshot(enableStdio, options.http);
    if (options.dashboard.enabled) {
        try {
            const handle = await startDashboardServer({
                host: options.dashboard.host,
                port: options.dashboard.port,
                streamIntervalMs: options.dashboard.streamIntervalMs,
                graphState,
                supervisor: childProcessSupervisor,
                eventStore,
                stigmergy,
                btStatusRegistry,
                supervisorAgent: orchestratorSupervisor,
                logger,
                contractNetWatcherTelemetry,
                logJournal,
            });
            cleanup.push(handle.close);
        }
        catch (error) {
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
            }
            catch (error) {
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
//# sourceMappingURL=server.js.map