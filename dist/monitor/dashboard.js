import { createServer } from "node:http";
import { clearInterval, setInterval } from "node:timers";
import { URL } from "node:url";
import { z } from "zod";
import { StructuredLogger } from "../logger.js";
import { serialiseForSse } from "../events/sse.js";
import { buildStigmergySummary, formatPheromoneBoundsTooltip, normalisePheromoneBoundsForTelemetry, } from "../coord/stigmergy.js";
/** Zod schema validating the pause endpoint payload. */
const PauseRequestSchema = z.object({
    childId: z.string().min(1, "childId is required"),
});
/** Zod schema validating the cancel endpoint payload. */
const CancelRequestSchema = PauseRequestSchema;
/** Zod schema validating the priority endpoint payload. */
const PrioritiseRequestSchema = z.object({
    childId: z.string().min(1, "childId is required"),
    priority: z.number().int().min(0).default(1),
});
/**
 * Builds the dashboard router responsible for serving JSON endpoints, SSE
 * streams and control commands. The router keeps track of connected clients so
 * broadcasts can be triggered either automatically (interval) or manually by
 * callers.
 */
export function createDashboardRouter(options) {
    const logger = options.logger ?? new StructuredLogger();
    const graphState = options.graphState;
    const eventStore = options.eventStore;
    const supervisor = options.supervisor;
    const stigmergy = options.stigmergy;
    const btStatusRegistry = options.btStatusRegistry;
    const supervisorAgent = options.supervisorAgent;
    const contractNetWatcherTelemetry = options.contractNetWatcherTelemetry;
    const streamIntervalMs = Math.max(250, options.streamIntervalMs ?? 2_000);
    const clients = new Set();
    const autoBroadcast = options.autoBroadcast ?? true;
    let interval = null;
    if (autoBroadcast) {
        interval = setInterval(() => {
            if (clients.size === 0) {
                return;
            }
            broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger);
        }, streamIntervalMs);
    }
    const handler = async (req, res) => {
        if (!req.url) {
            writeJson(res, 400, { error: "BAD_REQUEST", message: "missing URL" });
            return;
        }
        const requestUrl = new URL(req.url, "http://dashboard.local");
        const pathname = requestUrl.pathname;
        try {
            if (req.method === "GET" && pathname === "/") {
                const snapshot = buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry);
                writeHtml(res, 200, renderDashboardHtml(snapshot));
                return;
            }
            if (req.method === "GET" && pathname === "/health") {
                writeJson(res, 200, { status: "ok" });
                return;
            }
            if (req.method === "GET" && pathname === "/metrics") {
                writeJson(res, 200, buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry));
                return;
            }
            if (req.method === "GET" && pathname === "/stream") {
                handleStreamRequest(res, clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger, streamIntervalMs);
                return;
            }
            if (req.method === "POST" && pathname === "/controls/pause") {
                await handlePauseRequest(req, res, graphState, logger);
                broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger);
                return;
            }
            if (req.method === "POST" && pathname === "/controls/cancel") {
                await handleCancelRequest(req, res, graphState, supervisor, logger);
                broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger);
                return;
            }
            if (req.method === "POST" && pathname === "/controls/prioritise") {
                await handlePrioritiseRequest(req, res, graphState, logger);
                broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger);
                return;
            }
            writeJson(res, 404, { error: "NOT_FOUND" });
        }
        catch (error) {
            logger.error("dashboard_request_failure", {
                path: pathname,
                message: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
                writeJson(res, 500, { error: "INTERNAL_ERROR" });
            }
            else {
                res.end();
            }
        }
    };
    return {
        streamIntervalMs,
        handleRequest: handler,
        broadcast: () => broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger),
        async close() {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
            for (const client of clients) {
                try {
                    client.end();
                }
                catch (error) {
                    logger.warn("dashboard_client_close_error", {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            clients.clear();
        },
    };
}
/**
 * Starts a lightweight HTTP server exposing orchestrator monitoring endpoints.
 * The returned handle reuses {@link createDashboardRouter} so callers benefit
 * from the same request handling logic as the tests.
 */
export async function startDashboardServer(options) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    const logger = options.logger ?? new StructuredLogger();
    const router = createDashboardRouter({
        graphState: options.graphState,
        eventStore: options.eventStore,
        supervisor: options.supervisor,
        logger,
        streamIntervalMs: options.streamIntervalMs,
        autoBroadcast: true,
        stigmergy: options.stigmergy,
        btStatusRegistry: options.btStatusRegistry,
        supervisorAgent: options.supervisorAgent,
        contractNetWatcherTelemetry: options.contractNetWatcherTelemetry,
    });
    const server = createServer((req, res) => {
        void router.handleRequest(req, res);
    });
    await new Promise((resolve) => {
        server.listen(port, host, resolve);
    });
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    logger.info("dashboard_started", { host, port: resolvedPort, streamIntervalMs: router.streamIntervalMs });
    return {
        host,
        port: resolvedPort,
        broadcast() {
            router.broadcast();
        },
        async close() {
            await router.close();
            await new Promise((resolve, reject) => {
                server.close((closeError) => {
                    if (closeError) {
                        reject(closeError);
                    }
                    else {
                        resolve();
                    }
                });
            });
        },
    };
}
/** Serialises a response as JSON with the appropriate headers. */
function writeJson(res, status, payload) {
    const json = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
        "Cache-Control": "no-store",
    });
    res.end(json);
}
/** Serialises a response as HTML with UTF-8 encoding. */
function writeHtml(res, status, payload) {
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
    });
    res.end(payload);
}
/** Reads the full request body and parses it as JSON. */
async function parseJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length === 0) {
        return {};
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) {
        return {};
    }
    return JSON.parse(raw);
}
/** Handles `POST /controls/pause`. */
async function handlePauseRequest(req, res, graphState, logger) {
    const payload = await parseJsonBody(req);
    const parsed = PauseRequestSchema.safeParse(payload);
    if (!parsed.success) {
        writeJson(res, 400, { error: "INVALID_INPUT", issues: parsed.error.flatten() });
        return;
    }
    const child = graphState.getChild(parsed.data.childId);
    if (!child) {
        writeJson(res, 404, { error: "UNKNOWN_CHILD" });
        return;
    }
    graphState.patchChild(parsed.data.childId, {
        state: "paused",
        waitingFor: "dashboard_pause",
    });
    logger.info("dashboard_child_paused", { childId: parsed.data.childId });
    writeJson(res, 200, { status: "paused" });
}
/** Handles `POST /controls/cancel`. */
async function handleCancelRequest(req, res, graphState, supervisor, logger) {
    const payload = await parseJsonBody(req);
    const parsed = CancelRequestSchema.safeParse(payload);
    if (!parsed.success) {
        writeJson(res, 400, { error: "INVALID_INPUT", issues: parsed.error.flatten() });
        return;
    }
    const child = graphState.getChild(parsed.data.childId);
    if (!child) {
        writeJson(res, 404, { error: "UNKNOWN_CHILD" });
        return;
    }
    await supervisor.cancel(parsed.data.childId, { timeoutMs: 5_000 });
    graphState.patchChild(parsed.data.childId, { state: "cancelled", waitingFor: null });
    logger.warn("dashboard_child_cancelled", { childId: parsed.data.childId });
    writeJson(res, 200, { status: "cancelled" });
}
/** Handles `POST /controls/prioritise`. */
async function handlePrioritiseRequest(req, res, graphState, logger) {
    const payload = await parseJsonBody(req);
    const parsed = PrioritiseRequestSchema.safeParse(payload);
    if (!parsed.success) {
        writeJson(res, 400, { error: "INVALID_INPUT", issues: parsed.error.flatten() });
        return;
    }
    const child = graphState.getChild(parsed.data.childId);
    if (!child) {
        writeJson(res, 404, { error: "UNKNOWN_CHILD" });
        return;
    }
    graphState.patchChild(parsed.data.childId, { priority: parsed.data.priority, state: child.state });
    logger.info("dashboard_child_prioritised", {
        childId: parsed.data.childId,
        priority: parsed.data.priority,
    });
    writeJson(res, 200, { status: "prioritised", priority: parsed.data.priority });
}
/** Configures the HTTP response to behave as an SSE stream and pushes a snapshot. */
function handleStreamRequest(res, clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger, streamIntervalMs) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
    });
    res.write(`retry: ${streamIntervalMs}\n\n`);
    clients.add(res);
    res.on("close", () => {
        clients.delete(res);
    });
    const snapshot = buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry);
    const payload = serialiseForSse(snapshot);
    res.write(`data: ${payload}\n\n`);
    logger.debug("dashboard_stream_connected", { clients: clients.size });
}
/** Pushes a fresh snapshot to every connected SSE client. */
function broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry, logger) {
    if (clients.size === 0) {
        return;
    }
    const snapshot = buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry);
    const payload = `data: ${serialiseForSse(snapshot)}\n\n`;
    for (const client of clients) {
        client.write(payload);
    }
    logger.debug("dashboard_stream_broadcast", { clients: clients.size });
}
/** Builds a snapshot mixing metrics, children summaries and heatmap data. */
function buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, contractNetWatcherTelemetry) {
    const metrics = graphState.collectMetrics();
    const heatmap = computeDashboardHeatmap(graphState, eventStore, stigmergy);
    const stigmergySummary = buildStigmergySummary(heatmap.bounds);
    const scheduler = buildSchedulerSnapshot(supervisorAgent);
    const behaviorTrees = normaliseBehaviorTreeSnapshots(btStatusRegistry.snapshot());
    const contractNetWatcherState = contractNetWatcherTelemetry?.snapshot() ?? null;
    const children = graphState.listChildSnapshots().map((child) => {
        const lastActivityAt = child.lastTs ?? child.lastHeartbeatAt ?? child.createdAt;
        return {
            id: child.id,
            state: child.state,
            runtime: child.runtime,
            priority: child.priority,
            lastHeartbeatAt: child.lastHeartbeatAt,
            lastActivityAt,
            waitingFor: child.waitingFor,
            role: child.role,
            attachedAt: child.attachedAt,
            limits: child.limits,
        };
    });
    return {
        timestamp: Date.now(),
        metrics,
        heatmap,
        pheromoneBounds: heatmap.bounds,
        stigmergy: stigmergySummary,
        scheduler,
        behaviorTrees,
        contractNetWatcherTelemetry: contractNetWatcherState,
        children,
    };
}
/** Extracts a positive numeric token estimate from an event payload if present. */
function extractTokenUsage(event) {
    const payload = event.payload;
    if (!payload) {
        return 0;
    }
    const tokens = payload.tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
        return Math.max(0, tokens);
    }
    if (typeof tokens === "object" && tokens !== null) {
        const values = Object.values(tokens).map((value) => (typeof value === "number" ? value : 0));
        return values.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0);
    }
    return 0;
}
/** Computes heatmap-friendly aggregates combining idle durations, errors, tokens and pheromones. */
export function computeDashboardHeatmap(graphState, eventStore, stigmergy) {
    const now = Date.now();
    const children = graphState.listChildSnapshots();
    const idle = children
        .map((child) => {
        const lastActivity = child.lastTs ?? child.lastHeartbeatAt ?? child.createdAt;
        const idleMs = Math.max(0, now - lastActivity);
        return {
            childId: child.id,
            label: `${child.name ?? child.id} (${child.state})`,
            value: idleMs,
        };
    })
        .sort((a, b) => b.value - a.value);
    const errorCounts = new Map();
    const tokenUsage = new Map();
    for (const event of eventStore.getSnapshot()) {
        if (event.childId) {
            if (event.level === "error" || event.kind === "ERROR") {
                errorCounts.set(event.childId, (errorCounts.get(event.childId) ?? 0) + 1);
            }
            const tokens = extractTokenUsage(event);
            if (tokens > 0) {
                tokenUsage.set(event.childId, (tokenUsage.get(event.childId) ?? 0) + tokens);
            }
        }
    }
    const errors = [];
    for (const child of children) {
        const count = errorCounts.get(child.id) ?? 0;
        if (count > 0) {
            errors.push({ childId: child.id, label: `${child.name ?? child.id}`, value: count });
        }
    }
    errors.sort((a, b) => b.value - a.value);
    const tokens = [];
    for (const child of children) {
        const sum = tokenUsage.get(child.id) ?? 0;
        if (sum > 0) {
            tokens.push({ childId: child.id, label: `${child.name ?? child.id}`, value: sum });
        }
    }
    tokens.sort((a, b) => b.value - a.value);
    // Compute the current bounds before normalising cells so we reuse the same
    // reference across every consumer (heatmap cells, dashboards, telemetry).
    const bounds = normalisePheromoneBoundsForTelemetry(stigmergy.getIntensityBounds());
    const boundsTooltip = formatPheromoneBoundsTooltip(bounds);
    const fieldHeatmap = stigmergy.heatmapSnapshot();
    const pheromones = fieldHeatmap.cells
        .map((cell) => ({
        childId: cell.nodeId,
        label: cell.nodeId,
        value: cell.totalIntensity,
        normalised: cell.normalised,
    }))
        .sort((a, b) => b.value - a.value);
    return { idle, errors, tokens, pheromones, bounds, boundsTooltip };
}
/** Builds a scheduler snapshot suitable for dashboard consumption. */
function buildSchedulerSnapshot(supervisorAgent) {
    if (!supervisorAgent) {
        return { tick: 0, backlog: 0, completed: 0, failed: 0, updatedAt: null };
    }
    const snapshot = supervisorAgent.getLastSchedulerSnapshot();
    if (!snapshot) {
        return { tick: 0, backlog: 0, completed: 0, failed: 0, updatedAt: null };
    }
    return {
        tick: snapshot.schedulerTick,
        backlog: snapshot.backlog,
        completed: snapshot.completed,
        failed: snapshot.failed,
        updatedAt: snapshot.updatedAt,
    };
}
/** Normalises registry snapshots into dashboard-friendly Behaviour Tree payloads. */
function normaliseBehaviorTreeSnapshots(snapshots) {
    return snapshots
        .filter((snapshot) => snapshot.nodes.length > 0)
        .map((snapshot) => ({
        treeId: snapshot.treeId,
        updatedAt: snapshot.updatedAt,
        nodes: snapshot.nodes.map((node) => ({
            nodeId: node.nodeId,
            status: node.status,
            updatedAt: node.updatedAt,
        })),
    }));
}
/**
 * Renders a lightweight HTML dashboard exposing key metrics alongside the
 * Contract-Net watcher counters. The page is intentionally static so operators
 * can obtain a quick overview without depending on external tooling.
 */
function renderDashboardHtml(snapshot) {
    const watcher = snapshot.contractNetWatcherTelemetry;
    const watcherSummary = renderMetricsTableHtml(watcher
        ? [
            ["Emissions", formatNumber(watcher.emissions)],
            ["Dernier événement", formatTimestamp(watcher.lastEmittedAtMs)],
        ]
        : [], "Aucune télémétrie Contract-Net disponible.");
    const watcherDetails = renderMetricsTableHtml(watcher?.lastSnapshot
        ? [
            ["Raison", watcher.lastSnapshot.reason],
            ["Notifications reçues", formatNumber(watcher.lastSnapshot.receivedUpdates)],
            ["Notifications coalescées", formatNumber(watcher.lastSnapshot.coalescedUpdates)],
            ["Rafraîchissements ignorés", formatNumber(watcher.lastSnapshot.skippedRefreshes)],
            ["Rafraîchissements appliqués", formatNumber(watcher.lastSnapshot.appliedRefreshes)],
            ["Flushs", formatNumber(watcher.lastSnapshot.flushes)],
        ]
        : [], watcher
        ? "Le watcher n'a pas encore publié de compteur."
        : "Aucune télémétrie Contract-Net disponible.");
    const bounds = renderMetricsTableHtml(watcher?.lastSnapshot?.lastBounds
        ? [
            ["Min intensity", formatNumber(watcher.lastSnapshot.lastBounds.min_intensity)],
            [
                "Max intensity",
                formatNullableNumber(watcher.lastSnapshot.lastBounds.max_intensity),
            ],
            [
                "Normalisation ceiling",
                formatNumber(watcher.lastSnapshot.lastBounds.normalisation_ceiling),
            ],
        ]
        : [], watcher?.lastSnapshot
        ? "Aucune borne normalisée n'a été enregistrée."
        : "Aucune télémétrie Contract-Net disponible.");
    const stigSummaryRows = snapshot.stigmergy.rows
        .map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
        .join("\n");
    const tooltip = snapshot.heatmap.boundsTooltip ?? "";
    const initialSnapshotScriptPayload = serialiseSnapshotForInlineScript(snapshot);
    return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Orchestrateur – Dashboard</title>
    <style>
      body { font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
      h1, h2, h3 { margin: 0 0 12px; }
      section { margin-bottom: 32px; padding: 16px 20px; background: #1e293b; border-radius: 12px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.35); }
      .metrics-table { border-collapse: collapse; width: 100%; }
      .metrics-table th { text-align: left; padding: 8px 12px; font-weight: 600; color: #cbd5f5; width: 55%; }
      .metrics-table td { padding: 8px 12px; color: #e0f2fe; }
      .metrics-table tr:nth-child(even) { background: rgba(148, 163, 184, 0.1); }
      .empty-state { margin: 0; padding: 12px 16px; background: rgba(148, 163, 184, 0.15); border-radius: 8px; color: #f8fafc; }
      .two-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
      .status { margin: 8px 0 0; font-size: 0.95rem; font-weight: 500; }
      .status--pending { color: #facc15; }
      .status--connected { color: #4ade80; }
      .status--error { color: #f87171; }
      .dashboard-card { min-height: 40px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Orchestrateur – Tableau de bord</h1>
      <p>Instantané généré le <strong id="dashboard-timestamp">${formatTimestamp(snapshot.timestamp)}</strong>.</p>
      <p id="connection-status" class="status status--pending" role="status">SSE : initialisation…</p>
    </header>

    <section aria-labelledby="contract-net-watcher">
      <h2 id="contract-net-watcher">Contract-Net Watcher</h2>
      <div class="two-columns">
        <article>
          <h3>Résumé</h3>
          <div id="contract-net-summary" class="dashboard-card" aria-live="polite">
            ${watcherSummary}
          </div>
        </article>
        <article>
          <h3>Derniers compteurs</h3>
          <div id="contract-net-details" class="dashboard-card" aria-live="polite">
            ${watcherDetails}
          </div>
        </article>
      </div>
      <article>
        <h3>Dernières bornes normalisées</h3>
        <div id="contract-net-bounds" class="dashboard-card" aria-live="polite">
          ${bounds}
        </div>
      </article>
    </section>

    <section aria-labelledby="stigmergy-summary">
      <h2 id="stigmergy-summary">Stigmergie</h2>
      <table class="metrics-table">
        <tbody id="stigmergy-summary-rows">
          ${stigSummaryRows}
        </tbody>
      </table>
      <p id="stigmergy-tooltip">${escapeHtml(tooltip)}</p>
    </section>

    <section aria-labelledby="scheduler-summary">
      <h2 id="scheduler-summary">Scheduler</h2>
      <table class="metrics-table">
        <tbody>
          <tr><th scope="row">Tick</th><td><span id="scheduler-tick">${snapshot.scheduler.tick}</span></td></tr>
          <tr><th scope="row">Backlog</th><td><span id="scheduler-backlog">${snapshot.scheduler.backlog}</span></td></tr>
          <tr><th scope="row">Tâches complétées</th><td><span id="scheduler-completed">${snapshot.scheduler.completed}</span></td></tr>
          <tr><th scope="row">Tâches en échec</th><td><span id="scheduler-failed">${snapshot.scheduler.failed}</span></td></tr>
          <tr><th scope="row">Mise à jour</th><td><span id="scheduler-updated-at">${formatTimestamp(snapshot.scheduler.updatedAt)}</span></td></tr>
        </tbody>
      </table>
    </section>
    <script>
${buildDashboardBootstrapScript(initialSnapshotScriptPayload)}
    </script>
  </body>
</html>`;
}
/** Formats timestamps (epoch milliseconds) into ISO strings or `n/a`. */
function formatTimestamp(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "n/a";
    }
    try {
        return new Date(value).toISOString();
    }
    catch {
        return String(value);
    }
}
/** Formats finite numbers with a compact representation for HTML tables. */
function formatNumber(value) {
    if (!Number.isFinite(value)) {
        return "n/a";
    }
    if (Math.abs(value) >= 1_000 || Number.isInteger(value)) {
        return value.toString();
    }
    return value.toFixed(3);
}
/** Formats nullable numbers, returning `n/a` when no value is available. */
function formatNullableNumber(value) {
    return value === null ? "n/a" : formatNumber(value);
}
/** Escapes HTML special characters to avoid injection in static strings. */
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/**
 * Renders a small table (or fallback paragraph) summarising metrics. The
 * helper is used for the Contract-Net watcher sections so both the server-side
 * HTML and the client bootstrap share the same layout.
 */
function renderMetricsTableHtml(rows, emptyMessage) {
    if (rows.length === 0) {
        return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    }
    const renderedRows = rows
        .map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
        .join("\n");
    return `<table class="metrics-table"><tbody>${renderedRows}</tbody></table>`;
}
/**
 * Builds the inline dashboard bootstrap script as a pre-indented block. The helper
 * mostly uses plain string literals and relies on a single template interpolation
 * to inject the sanitised snapshot so TypeScript treats the browser code as an
 * opaque string while still embedding data safely.
*/
function buildDashboardBootstrapScript(serialisedSnapshot) {
    const lines = [
        "(() => {",
        "  // Inline bootstrap executed in the dashboard context. The script keeps the",
        "  // HTML view synchronised with the `/stream` SSE endpoint so operators can",
        "  // observe metrics without refreshing the page. Values are updated using",
        "  // DOM APIs (textContent/appendChild) to avoid HTML injection concerns.",
        `  const initialSnapshot = ${serialisedSnapshot};`,
        "",
        "  // Updates the textual status banner displayed below the title.",
        "  const statusElement = document.getElementById(\"connection-status\");",
        "  function updateStatus(message, variant) {",
        "    if (!statusElement) {",
        "      return;",
        "    }",
        "    statusElement.textContent = message;",
        "    statusElement.classList.remove(\"status--pending\", \"status--connected\", \"status--error\");",
        "    statusElement.classList.add(\"status--\" + variant);",
        "  }",
        "",
        "  // Formats timestamps (epoch milliseconds) into ISO strings or `n/a`.",
        "  function formatTimestampForClient(value) {",
        "    if (typeof value !== \"number\" || !Number.isFinite(value)) {",
        "      return \"n/a\";",
        "    }",
        "    try {",
        "      return new Date(value).toISOString();",
        "    } catch (error) {",
        "      console.warn(\"dashboard_timestamp_parse_failure\", error);",
        "      return String(value);",
        "    }",
        "  }",
        "",
        "  // Mirrors the server-side formatting logic for compact numbers.",
        "  function formatNumberForClient(value) {",
        "    if (!Number.isFinite(value)) {",
        "      return \"n/a\";",
        "    }",
        "    if (Math.abs(value) >= 1000 || Number.isInteger(value)) {",
        "      return String(value);",
        "    }",
        "    return value.toFixed(3);",
        "  }",
        "",
        "  // Formats nullable numbers, returning `n/a` when empty.",
        "  function formatNullableNumberForClient(value) {",
        "    return value === null ? \"n/a\" : formatNumberForClient(value);",
        "  }",
        "",
        "  // Renders a metrics table inside the provided container. When no rows are",
        "  // available the function falls back to an informative empty state.",
        "  function renderMetricsTable(containerId, rows, emptyMessage) {",
        "    const container = document.getElementById(containerId);",
        "    if (!container) {",
        "      return;",
        "    }",
        "    container.textContent = \"\";",
        "    if (!rows.length) {",
        "      const empty = document.createElement(\"p\");",
        "      empty.className = \"empty-state\";",
        "      empty.textContent = emptyMessage;",
        "      container.appendChild(empty);",
        "      return;",
        "    }",
        "    const table = document.createElement(\"table\");",
        "    table.className = \"metrics-table\";",
        "    const body = document.createElement(\"tbody\");",
        "    for (const [label, value] of rows) {",
        "      const tr = document.createElement(\"tr\");",
        "      const th = document.createElement(\"th\");",
        "      th.scope = \"row\";",
        "      th.textContent = label;",
        "      const td = document.createElement(\"td\");",
        "      td.textContent = value;",
        "      tr.appendChild(th);",
        "      tr.appendChild(td);",
        "      body.appendChild(tr);",
        "    }",
        "    table.appendChild(body);",
        "    container.appendChild(table);",
        "  }",
        "",
        "  // Updates the Stigmergy summary table and tooltip.",
        "  function updateStigmergy(snapshot) {",
        "    const tbody = document.getElementById(\"stigmergy-summary-rows\");",
        "    if (tbody) {",
        "      tbody.textContent = \"\";",
        "      for (const row of snapshot.stigmergy.rows) {",
        "        const tr = document.createElement(\"tr\");",
        "        const th = document.createElement(\"th\");",
        "        th.scope = \"row\";",
        "        th.textContent = row.label;",
        "        const td = document.createElement(\"td\");",
        "        td.textContent = row.value;",
        "        tr.appendChild(th);",
        "        tr.appendChild(td);",
        "        tbody.appendChild(tr);",
        "      }",
        "    }",
        "    const tooltip = document.getElementById(\"stigmergy-tooltip\");",
        "    if (tooltip) {",
        "      tooltip.textContent = snapshot.heatmap.boundsTooltip ?? \"\";",
        "    }",
        "  }",
        "",
        "  // Updates Contract-Net watcher counters and bounds.",
        "  function updateContractNet(snapshot) {",
        "    const watcher = snapshot.contractNetWatcherTelemetry;",
        "    if (!watcher) {",
        "      renderMetricsTable(\"contract-net-summary\", [], \"Aucune télémétrie Contract-Net disponible.\");",
        "      renderMetricsTable(\"contract-net-details\", [], \"Aucune télémétrie Contract-Net disponible.\");",
        "      renderMetricsTable(\"contract-net-bounds\", [], \"Aucune télémétrie Contract-Net disponible.\");",
        "      return;",
        "    }",
        "    renderMetricsTable(",
        "      \"contract-net-summary\",",
        "      [",
        "        [\"Emissions\", formatNumberForClient(watcher.emissions)],",
        "        [\"Dernier événement\", formatTimestampForClient(watcher.lastEmittedAtMs)],",
        "      ],",
        "      \"Aucune télémétrie Contract-Net disponible.\",",
        "    );",
        "",
        "    const snapshotDetails = watcher.lastSnapshot;",
        "    renderMetricsTable(",
        "      \"contract-net-details\",",
        "      snapshotDetails",
        "        ? [",
        "            [\"Raison\", snapshotDetails.reason],",
        "            [\"Notifications reçues\", formatNumberForClient(snapshotDetails.receivedUpdates)],",
        "            [\"Notifications coalescées\", formatNumberForClient(snapshotDetails.coalescedUpdates)],",
        "            [\"Rafraîchissements ignorés\", formatNumberForClient(snapshotDetails.skippedRefreshes)],",
        "            [\"Rafraîchissements appliqués\", formatNumberForClient(snapshotDetails.appliedRefreshes)],",
        "            [\"Flushs\", formatNumberForClient(snapshotDetails.flushes)],",
        "          ]",
        "        : [],",
        "      snapshotDetails",
        "        ? \"Le watcher n'a pas encore publié de compteur.\",",
        "        : \"Aucune télémétrie Contract-Net disponible.\",",
        "    );",
        "",
        "    const bounds = snapshotDetails?.lastBounds;",
        "    renderMetricsTable(",
        "      \"contract-net-bounds\",",
        "      bounds",
        "        ? [",
        "            [\"Min intensity\", formatNumberForClient(bounds.min_intensity)],",
        "            [\"Max intensity\", formatNullableNumberForClient(bounds.max_intensity)],",
        "            [\"Normalisation ceiling\", formatNumberForClient(bounds.normalisation_ceiling)],",
        "          ]",
        "        : [],",
        "      bounds",
        "        ? \"Aucune borne normalisée n'a été enregistrée.\",",
        "        : \"Aucune télémétrie Contract-Net disponible.\",",
        "    );",
        "  }",
        "",
        "  // Updates scheduler counters embedded in the HTML table.",
        "  function updateScheduler(snapshot) {",
        "    const tick = document.getElementById(\"scheduler-tick\");",
        "    if (tick) {",
        "      tick.textContent = String(snapshot.scheduler.tick);",
        "    }",
        "    const backlog = document.getElementById(\"scheduler-backlog\");",
        "    if (backlog) {",
        "      backlog.textContent = String(snapshot.scheduler.backlog);",
        "    }",
        "    const completed = document.getElementById(\"scheduler-completed\");",
        "    if (completed) {",
        "      completed.textContent = String(snapshot.scheduler.completed);",
        "    }",
        "    const failed = document.getElementById(\"scheduler-failed\");",
        "    if (failed) {",
        "      failed.textContent = String(snapshot.scheduler.failed);",
        "    }",
        "    const updatedAt = document.getElementById(\"scheduler-updated-at\");",
        "    if (updatedAt) {",
        "      updatedAt.textContent = formatTimestampForClient(snapshot.scheduler.updatedAt);",
        "    }",
        "  }",
        "",
        "  // Synchronises the title timestamp with the latest snapshot.",
        "  function updateHeader(snapshot) {",
        "    const timestamp = document.getElementById(\"dashboard-timestamp\");",
        "    if (timestamp) {",
        "      timestamp.textContent = formatTimestampForClient(snapshot.timestamp);",
        "    }",
        "  }",
        "",
        "  // Applies the provided snapshot to every dashboard section.",
        "  function applySnapshot(snapshot) {",
        "    updateHeader(snapshot);",
        "    updateContractNet(snapshot);",
        "    updateStigmergy(snapshot);",
        "    updateScheduler(snapshot);",
        "  }",
        "",
        "  // Render the initial server-provided snapshot immediately.",
        "  applySnapshot(initialSnapshot);",
        "",
        "  if (typeof window === \"undefined\" || !(\"EventSource\" in window)) {",
        "    updateStatus(\"Flux SSE non supporté par ce navigateur.\", \"error\");",
        "    return;",
        "  }",
        "",
        "  updateStatus(\"Connexion SSE en cours…\", \"pending\");",
        "  const source = new EventSource(\"stream\");",
        "  source.onopen = () => {",
        "    updateStatus(\"Flux SSE connecté\", \"connected\");",
        "  };",
        "  source.onmessage = (event) => {",
        "    try {",
        "      const parsed = JSON.parse(event.data);",
        "      applySnapshot(parsed);",
        "    } catch (error) {",
        "      console.error(\"dashboard_stream_parse_failure\", error);",
        "      updateStatus(\"Flux SSE : parsing JSON invalide.\", \"error\");",
        "    }",
        "  };",
        "  source.onerror = () => {",
        "    updateStatus(\"Flux SSE déconnecté – reconnexion automatique…\", \"error\");",
        "  };",
        "})();",
    ];
    return lines
        .map((line) => (line.length > 0 ? `      ${line}` : ""))
        .join("\n");
}
/**
 * Serialises a snapshot for inclusion in the inline dashboard bootstrap. The
 * payload escapes characters that could prematurely terminate the script tag
 * (such as `</script>` or U+2028 line separators).
 */
function serialiseSnapshotForInlineScript(snapshot) {
    return JSON.stringify(snapshot)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}
//# sourceMappingURL=dashboard.js.map