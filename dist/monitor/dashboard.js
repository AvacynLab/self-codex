import { createServer } from "node:http";
import { clearInterval, setInterval } from "node:timers";
import { URL } from "node:url";
import { z } from "zod";
import { StructuredLogger } from "../logger.js";
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
    const streamIntervalMs = Math.max(250, options.streamIntervalMs ?? 2_000);
    const clients = new Set();
    const autoBroadcast = options.autoBroadcast ?? true;
    let interval = null;
    if (autoBroadcast) {
        interval = setInterval(() => {
            if (clients.size === 0) {
                return;
            }
            broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger);
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
            if (req.method === "GET" && pathname === "/health") {
                writeJson(res, 200, { status: "ok" });
                return;
            }
            if (req.method === "GET" && pathname === "/metrics") {
                writeJson(res, 200, buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent));
                return;
            }
            if (req.method === "GET" && pathname === "/stream") {
                handleStreamRequest(res, clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger, streamIntervalMs);
                return;
            }
            if (req.method === "POST" && pathname === "/controls/pause") {
                await handlePauseRequest(req, res, graphState, logger);
                broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger);
                return;
            }
            if (req.method === "POST" && pathname === "/controls/cancel") {
                await handleCancelRequest(req, res, graphState, supervisor, logger);
                broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger);
                return;
            }
            if (req.method === "POST" && pathname === "/controls/prioritise") {
                await handlePrioritiseRequest(req, res, graphState, logger);
                broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger);
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
        broadcast: () => broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger),
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
function handleStreamRequest(res, clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger, streamIntervalMs) {
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
    const snapshot = buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent);
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    logger.debug("dashboard_stream_connected", { clients: clients.size });
}
/** Pushes a fresh snapshot to every connected SSE client. */
function broadcast(clients, graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent, logger) {
    if (clients.size === 0) {
        return;
    }
    const snapshot = buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent);
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
        client.write(payload);
    }
    logger.debug("dashboard_stream_broadcast", { clients: clients.size });
}
/** Builds a snapshot mixing metrics, children summaries and heatmap data. */
function buildSnapshot(graphState, eventStore, stigmergy, btStatusRegistry, supervisorAgent) {
    const metrics = graphState.collectMetrics();
    const heatmap = computeDashboardHeatmap(graphState, eventStore, stigmergy);
    const scheduler = buildSchedulerSnapshot(supervisorAgent);
    const behaviorTrees = normaliseBehaviorTreeSnapshots(btStatusRegistry.snapshot());
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
        };
    });
    return {
        timestamp: Date.now(),
        metrics,
        heatmap,
        scheduler,
        behaviorTrees,
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
    const fieldSnapshot = stigmergy.fieldSnapshot();
    const pheromones = fieldSnapshot.totals
        .filter((total) => total.intensity > 0)
        .map((total) => ({
        childId: total.nodeId,
        label: total.nodeId,
        value: total.intensity,
    }))
        .sort((a, b) => b.value - a.value);
    return { idle, errors, tokens, pheromones };
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
