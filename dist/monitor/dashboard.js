import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { runtimeTimers } from "../runtime/timers.js";
import { URL } from "node:url";
import { z } from "zod";
import { StructuredLogger } from "../logger.js";
import { serialiseForSse } from "../events/sse.js";
import { reportOpenSseStreams } from "../infra/tracing.js";
import { buildStigmergySummary, formatPheromoneBoundsTooltip, normalisePheromoneBoundsForTelemetry, } from "../coord/stigmergy.js";
import { buildReplayPage } from "./replay.js";
/** Zod schema validating client log payloads forwarded by the dashboard UI. */
const ClientLogRequestSchema = z.object({
    level: z.enum(["info", "warn", "error"]),
    event: z.string().min(1, "event is required").max(128),
    context: z.unknown().optional(),
});
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
    const logJournal = options.logJournal ?? null;
    let interval = null;
    if (autoBroadcast) {
        interval = runtimeTimers.setInterval(() => {
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
            if (req.method === "GET" && pathname === "/logs") {
                if (!logJournal) {
                    writeJson(res, 503, { error: "LOGS_UNAVAILABLE", message: "log journal not configured" });
                    return;
                }
                handleLogsRequest(res, requestUrl.searchParams, logJournal, logger);
                return;
            }
            if (req.method === "GET" && pathname === "/replay") {
                const jobId = requestUrl.searchParams.get("jobId");
                if (!jobId || jobId.trim().length === 0) {
                    writeJson(res, 400, { error: "INVALID_INPUT", message: "jobId query parameter is required" });
                    return;
                }
                const limitParam = requestUrl.searchParams.get("limit");
                const cursorParam = requestUrl.searchParams.get("cursor");
                const parsedLimit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
                if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
                    writeJson(res, 400, { error: "INVALID_INPUT", message: "limit must be a positive integer" });
                    return;
                }
                const parsedCursor = cursorParam === null ? undefined : Number.parseInt(cursorParam, 10);
                if (parsedCursor !== undefined && (!Number.isFinite(parsedCursor) || parsedCursor < 0)) {
                    writeJson(res, 400, { error: "INVALID_INPUT", message: "cursor must be a non-negative integer" });
                    return;
                }
                const page = buildReplayPage(eventStore, jobId, {
                    limit: parsedLimit,
                    cursor: parsedCursor,
                });
                writeJson(res, 200, page);
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
            if (req.method === "POST" && pathname === "/logs") {
                await handleClientLogRequest(req, res, logger);
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
                runtimeTimers.clearInterval(interval);
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
        logJournal: options.logJournal,
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
        chunks.push(Buffer.from(chunk));
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
/** Handles `POST /logs` emitted by the dashboard client when telemetry issues occur. */
async function handleClientLogRequest(req, res, logger) {
    const payload = await parseJsonBody(req);
    const parsed = ClientLogRequestSchema.safeParse(payload);
    if (!parsed.success) {
        writeJson(res, 400, { error: "INVALID_INPUT", issues: parsed.error.flatten() });
        return;
    }
    const { level, event, context } = parsed.data;
    const logPayload = {
        event,
        context: context ?? null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
        remoteAddress: req.socket?.remoteAddress ?? null,
    };
    switch (level) {
        case "info":
            logger.info("dashboard_client_log", logPayload);
            break;
        case "warn":
            logger.warn("dashboard_client_log", logPayload);
            break;
        default:
            logger.error("dashboard_client_log", logPayload);
            break;
    }
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
}
/**
 * Handles `GET /logs` by tailing the correlated {@link LogJournal}. The endpoint supports
 * severity filters, pagination cursors, and correlated identifiers (run/job/child) so
 * operators can quickly investigate anomalies surfaced by the dashboard.
 */
function handleLogsRequest(res, params, logJournal, logger) {
    const parsed = parseLogTailQuery(params);
    if (!parsed.ok) {
        logger.warn("dashboard_logs_invalid_query", { issues: parsed.issues });
        writeJson(res, 400, { error: "INVALID_INPUT", message: parsed.message, issues: parsed.issues });
        return;
    }
    const { stream, bucketId, fromSeq, limit, levels, filters, } = parsed.query;
    const tail = logJournal.tail({
        stream,
        bucketId: bucketId ?? undefined,
        fromSeq: fromSeq ?? undefined,
        limit: limit ?? undefined,
        levels: levels ?? undefined,
        filters: filters ?? undefined,
    });
    const responsePayload = {
        stream,
        bucketId: bucketId ?? "orchestrator",
        fromSeq: fromSeq ?? null,
        limit: limit ?? null,
        levels: levels ?? null,
        filters: serialiseFiltersForResponse(filters),
        entries: tail.entries.map((entry) => ({
            seq: entry.seq,
            ts: entry.ts,
            level: entry.level,
            message: entry.message,
            data: entry.data ?? null,
            runId: entry.runId ?? null,
            jobId: entry.jobId ?? null,
            opId: entry.opId ?? null,
            graphId: entry.graphId ?? null,
            nodeId: entry.nodeId ?? null,
            childId: entry.childId ?? null,
            component: entry.component,
            stage: entry.stage,
            elapsedMs: entry.elapsedMs ?? null,
            bucketId: entry.bucketId,
        })),
        nextSeq: tail.nextSeq,
    };
    writeJson(res, 200, responsePayload);
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
    reportOpenSseStreams(clients.size);
    let released = false;
    const release = () => {
        if (released) {
            return;
        }
        released = true;
        clients.delete(res);
        reportOpenSseStreams(clients.size);
    };
    res.on("close", release);
    res.on("error", release);
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
    const runtimeCosts = summariseRuntimeCosts(graphState, eventStore);
    const stigmergySummary = buildStigmergySummary(heatmap.bounds);
    const scheduler = buildSchedulerSnapshot(supervisorAgent);
    const behaviorTrees = normaliseBehaviorTreeSnapshots(btStatusRegistry.snapshot());
    const contractNetWatcherState = contractNetWatcherTelemetry?.snapshot() ?? null;
    const timeline = buildDashboardTimeline(eventStore);
    const consensus = summariseConsensusDecisions(eventStore);
    const thoughtGraph = buildThoughtGraphHeatmap(graphState);
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
        runtimeCosts,
        pheromoneBounds: heatmap.bounds,
        stigmergy: stigmergySummary,
        scheduler,
        behaviorTrees,
        contractNetWatcherTelemetry: contractNetWatcherState,
        timeline,
        consensus,
        thoughtGraph,
        children,
    };
}
/**
 * Builds the causal timeline exposed by the dashboard. The helper keeps the
 * payload bounded by summarising events server-side which avoids reprocessing
 * large JSON blobs inside the browser.
 */
function buildDashboardTimeline(eventStore, limit = 40) {
    const recent = eventStore.list({ limit, reverse: true }).reverse();
    const events = recent.map((event) => ({
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        level: event.level,
        source: event.source,
        jobId: event.jobId ?? null,
        childId: event.childId ?? null,
        summary: summariseEventForTimeline(event),
    }));
    const filters = buildTimelineFilters(events);
    return { events, filters };
}
/** Aggregates distinct filter values for the timeline dropdowns. */
function buildTimelineFilters(events) {
    const kinds = new Set();
    const levels = new Set();
    const sources = new Set();
    const jobs = new Set();
    const children = new Set();
    for (const event of events) {
        kinds.add(event.kind);
        levels.add(event.level);
        sources.add(event.source);
        if (event.jobId) {
            jobs.add(event.jobId);
        }
        if (event.childId) {
            children.add(event.childId);
        }
    }
    return {
        kinds: [...kinds].sort(),
        levels: [...levels].sort(),
        sources: [...sources].sort(),
        jobs: [...jobs].sort(),
        children: [...children].sort(),
    };
}
/** Builds a concise textual summary for the timeline entry. */
function summariseEventForTimeline(event) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") {
        const tokens = extractTokenUsage(event);
        const latency = extractLatencyMs(event);
        if (tokens > 0 || (latency ?? 0) > 0) {
            const fragments = [];
            if (tokens > 0)
                fragments.push(`tokens=${tokens}`);
            if (latency !== null && latency > 0)
                fragments.push(`latency=${latency}ms`);
            return fragments.join(" · ") || "—";
        }
        return "—";
    }
    const fragments = [];
    const operation = coerceString(payload.operation ?? payload.stage ?? payload.phase ?? payload.action);
    if (operation) {
        fragments.push(operation);
    }
    const status = coerceString(payload.state ?? payload.status);
    if (status && status !== operation) {
        fragments.push(`state=${status}`);
    }
    const policy = coerceString(payload.policy);
    if (policy) {
        fragments.push(`policy=${policy}`);
    }
    if ("consensus" in payload && typeof payload.consensus === "object" && payload.consensus !== null) {
        const consensus = payload.consensus;
        const outcome = coerceString(consensus.outcome);
        const satisfied = toOptionalBoolean(consensus.satisfied);
        const tie = toOptionalBoolean(consensus.tie);
        const parts = [];
        if (outcome)
            parts.push(outcome);
        if (satisfied !== null)
            parts.push(satisfied ? "ok" : "ko");
        if (tie)
            parts.push("tie");
        if (parts.length > 0) {
            fragments.push(`consensus=${parts.join("/")}`);
        }
    }
    const reducer = coerceString(payload.reducer);
    if (reducer) {
        fragments.push(`reducer=${reducer}`);
    }
    const reason = coerceString(payload.reason ?? payload.message ?? payload.summary ?? payload.text);
    if (reason) {
        fragments.push(truncate(reason, 80));
    }
    const tokens = extractTokenUsage(event);
    if (tokens > 0) {
        fragments.push(`tokens=${tokens}`);
    }
    const latency = extractLatencyMs(event);
    if (latency !== null && latency > 0) {
        fragments.push(`latency=${latency}ms`);
    }
    if (fragments.length === 0) {
        const fallback = truncateJson(payload, 120);
        return fallback.length > 0 ? fallback : "—";
    }
    return fragments.slice(0, 4).join(" · ");
}
/**
 * Extracts consensus decisions from recent STATUS events. Results are ordered
 * from newest to oldest so UIs can surface the latest outcome at the top of the
 * panel.
 */
function summariseConsensusDecisions(eventStore, limit = 10) {
    const decisions = [];
    const window = eventStore.list({ kinds: ["STATUS"], limit: limit * 4, reverse: true });
    for (const event of window) {
        const payload = event.payload;
        if (!payload || typeof payload !== "object") {
            continue;
        }
        const consensus = extractConsensusPayload(payload);
        if (!consensus) {
            continue;
        }
        decisions.push({
            seq: event.seq,
            ts: event.ts,
            jobId: event.jobId ?? null,
            childId: event.childId ?? null,
            mode: coerceString(consensus.mode),
            outcome: coerceString(consensus.outcome),
            satisfied: toOptionalBoolean(consensus.satisfied),
            tie: toOptionalBoolean(consensus.tie),
            threshold: toOptionalNumber(consensus.threshold),
            totalWeight: toOptionalNumber(consensus.total_weight ?? consensus.totalWeight),
            votes: toOptionalNumber(consensus.votes),
            tally: normaliseConsensusTally(consensus.tally),
            metadata: collectConsensusMetadata(payload, consensus),
        });
    }
    const recent = decisions.slice(0, limit);
    const stats = {
        total: decisions.length,
        satisfied: decisions.filter((decision) => decision.satisfied === true).length,
        unsatisfied: decisions.filter((decision) => decision.satisfied === false).length,
        ties: decisions.filter((decision) => decision.tie === true).length,
    };
    return {
        latest: recent[0] ?? null,
        recent,
        stats,
    };
}
/** Builds a heatmap-friendly ThoughtGraph projection for every active job. */
function buildThoughtGraphHeatmap(graphState) {
    const jobs = graphState.listJobs();
    const projections = [];
    for (const job of jobs) {
        const snapshot = graphState.getThoughtGraph(job.id);
        if (!snapshot || snapshot.nodes.length === 0) {
            continue;
        }
        const scores = snapshot.nodes
            .map((node) => (typeof node.score === "number" && Number.isFinite(node.score) ? node.score : null))
            .filter((value) => value !== null);
        const minScore = scores.length > 0 ? Math.min(...scores) : null;
        const maxScore = scores.length > 0 ? Math.max(...scores) : null;
        const nodes = snapshot.nodes.map((node) => {
            const labelParts = [];
            const tool = coerceString(node.tool);
            if (tool) {
                labelParts.push(tool);
            }
            const result = coerceString(node.result);
            if (result) {
                labelParts.push(truncate(result, 64));
            }
            if (labelParts.length === 0) {
                labelParts.push(`Depth ${node.depth}`);
            }
            return {
                id: node.id,
                depth: node.depth,
                status: node.status,
                score: typeof node.score === "number" && Number.isFinite(node.score) ? node.score : null,
                normalisedScore: normaliseThoughtScore(node.score, minScore, maxScore),
                tool: node.tool,
                label: labelParts.join(" • "),
                startedAt: node.startedAt,
                completedAt: node.completedAt,
                provenanceCount: node.provenance.length,
            };
        });
        nodes.sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }
            const scoreA = a.score ?? Number.NEGATIVE_INFINITY;
            const scoreB = b.score ?? Number.NEGATIVE_INFINITY;
            if (scoreA !== scoreB) {
                return scoreB - scoreA;
            }
            return a.id.localeCompare(b.id);
        });
        projections.push({
            jobId: job.id,
            goal: job.goal ?? null,
            updatedAt: snapshot.updatedAt,
            nodes,
        });
    }
    projections.sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) {
            return b.updatedAt - a.updatedAt;
        }
        return a.jobId.localeCompare(b.jobId);
    });
    return projections;
}
/** Extracts the consensus payload block when present. */
function extractConsensusPayload(value) {
    const raw = value.consensus;
    if (!raw || typeof raw !== "object") {
        return null;
    }
    return raw;
}
/** Collects metadata exposed by plan joins to enrich the consensus panel. */
function collectConsensusMetadata(payload, consensus) {
    const metadata = {};
    if (typeof payload.policy === "string") {
        metadata.policy = payload.policy;
    }
    if (typeof payload.winning_child_id === "string") {
        metadata.winning_child_id = payload.winning_child_id;
    }
    if (typeof payload.quorum_threshold === "number" && Number.isFinite(payload.quorum_threshold)) {
        metadata.quorum_threshold = payload.quorum_threshold;
    }
    if (typeof consensus.metadata === "object" && consensus.metadata !== null) {
        for (const [key, value] of Object.entries(consensus.metadata)) {
            if (!(key in metadata)) {
                metadata[key] = value;
            }
        }
    }
    return Object.keys(metadata).length > 0 ? metadata : null;
}
/** Normalises tally objects into deterministic sorted records. */
function normaliseConsensusTally(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const entries = [];
    for (const [key, raw] of Object.entries(value)) {
        const numeric = toOptionalNumber(raw);
        if (numeric !== null) {
            entries.push([key, numeric]);
        }
    }
    if (entries.length === 0) {
        return null;
    }
    entries.sort((a, b) => {
        if (b[1] !== a[1]) {
            return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
    });
    const tally = {};
    for (const [key, value] of entries) {
        tally[key] = value;
    }
    return tally;
}
/** Normalises scores to a 0-1 range while keeping missing values as null. */
function normaliseThoughtScore(score, minScore, maxScore) {
    if (typeof score !== "number" || !Number.isFinite(score) || minScore === null || maxScore === null) {
        return null;
    }
    if (maxScore === minScore) {
        return 0.5;
    }
    const ratio = (score - minScore) / (maxScore - minScore);
    const clamped = Math.min(1, Math.max(0, ratio));
    return Number(clamped.toFixed(6));
}
/** Normalises arbitrary values into trimmed strings. */
function coerceString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalised = value.replace(/\s+/g, " ").trim();
    return normalised.length > 0 ? normalised : null;
}
/** Converts optional booleans while preserving `null` for absent values. */
function toOptionalBoolean(value) {
    return typeof value === "boolean" ? value : null;
}
/** Converts optional numeric values (number-like strings accepted). */
function toOptionalNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}
/** Truncates strings with an ellipsis when exceeding the provided length. */
function truncate(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    const slice = value.slice(0, Math.max(0, maxLength - 1)).trimEnd();
    return `${slice}…`;
}
/** Serialises JSON payloads into a bounded preview string. */
function truncateJson(record, maxLength) {
    try {
        const serialised = JSON.stringify(record);
        if (!serialised) {
            return "";
        }
        return serialised.length <= maxLength ? serialised : `${serialised.slice(0, maxLength - 1)}…`;
    }
    catch (error) {
        return "[payload]";
    }
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
/** Extracts a latency sample (milliseconds) from the event payload when present. */
function extractLatencyMs(event) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const normalised = extractLatencyCandidate(payload) ??
        (typeof payload.metrics === "object" && payload.metrics !== null
            ? extractLatencyCandidate(payload.metrics)
            : null);
    return normalised;
}
/** Normalises latency-like properties (elapsed_ms, durationMs, etc.) into integers. */
function extractLatencyCandidate(record) {
    const keys = [
        "elapsed_ms",
        "elapsedMs",
        "duration_ms",
        "durationMs",
        "latency_ms",
        "latencyMs",
        "latency",
        "duration",
        "cpu_ms",
        "cpuMs",
    ];
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
            continue;
        }
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return Math.max(0, Math.round(value));
        }
        if (typeof value === "string") {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return Math.max(0, Math.round(parsed));
            }
        }
    }
    return null;
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
    const latencyUsage = new Map();
    for (const event of eventStore.getSnapshot()) {
        if (event.childId) {
            if (event.level === "error" || event.kind === "ERROR") {
                errorCounts.set(event.childId, (errorCounts.get(event.childId) ?? 0) + 1);
            }
            const tokens = extractTokenUsage(event);
            if (tokens > 0) {
                tokenUsage.set(event.childId, (tokenUsage.get(event.childId) ?? 0) + tokens);
            }
            const latency = extractLatencyMs(event);
            if (latency !== null && latency > 0) {
                latencyUsage.set(event.childId, (latencyUsage.get(event.childId) ?? 0) + latency);
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
    const latency = [];
    for (const child of children) {
        const total = latencyUsage.get(child.id) ?? 0;
        if (total > 0) {
            latency.push({ childId: child.id, label: `${child.name ?? child.id}`, value: total });
        }
    }
    latency.sort((a, b) => b.value - a.value);
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
    return { idle, errors, tokens, latency, pheromones, bounds, boundsTooltip };
}
/**
 * Aggregates token and latency usage per child to feed the runtime cost
 * dashboard. The helper scans the EventStore snapshot to avoid mutating
 * internal state while providing deterministic ordering for the UI.
 */
export function summariseRuntimeCosts(graphState, eventStore) {
    const labels = new Map();
    for (const child of graphState.listChildSnapshots()) {
        labels.set(child.id, child.name ?? child.id);
    }
    const perChild = new Map();
    let totalTokens = 0;
    let totalLatencyMs = 0;
    let sampleCount = 0;
    let maxEventLatency = null;
    for (const event of eventStore.getSnapshot()) {
        const childId = event.childId;
        if (!childId) {
            continue;
        }
        let bucket = perChild.get(childId);
        if (!bucket) {
            bucket = { tokens: 0, latencyMs: 0, maxLatencyMs: 0 };
            perChild.set(childId, bucket);
        }
        const tokens = extractTokenUsage(event);
        if (tokens > 0) {
            bucket.tokens += tokens;
            totalTokens += tokens;
        }
        const latency = extractLatencyMs(event);
        if (latency !== null) {
            bucket.latencyMs += latency;
            if (latency > bucket.maxLatencyMs) {
                bucket.maxLatencyMs = latency;
            }
            totalLatencyMs += latency;
            sampleCount += 1;
            if (maxEventLatency === null || latency > maxEventLatency) {
                maxEventLatency = latency;
            }
        }
    }
    const perChildEntries = [];
    let topToken = null;
    let topLatency = null;
    for (const [childId, stats] of perChild.entries()) {
        if (stats.tokens <= 0 && stats.latencyMs <= 0) {
            continue;
        }
        const entry = {
            childId,
            label: labels.get(childId) ?? childId,
            tokens: stats.tokens,
            latencyMs: stats.latencyMs,
            maxLatencyMs: stats.maxLatencyMs,
        };
        perChildEntries.push(entry);
        if (entry.tokens > 0) {
            if (!topToken || entry.tokens > topToken.tokens || (entry.tokens === topToken.tokens && entry.childId < topToken.childId)) {
                topToken = entry;
            }
        }
        if (entry.latencyMs > 0) {
            if (!topLatency ||
                entry.latencyMs > topLatency.latencyMs ||
                (entry.latencyMs === topLatency.latencyMs && entry.childId < topLatency.childId)) {
                topLatency = entry;
            }
        }
    }
    perChildEntries.sort((a, b) => {
        if (b.tokens !== a.tokens) {
            return b.tokens - a.tokens;
        }
        if (b.latencyMs !== a.latencyMs) {
            return b.latencyMs - a.latencyMs;
        }
        return a.childId.localeCompare(b.childId);
    });
    const avgLatency = sampleCount > 0 ? totalLatencyMs / sampleCount : null;
    return {
        totalTokens,
        totalLatencyMs,
        sampleCount,
        avgLatencyMs: avgLatency,
        maxLatencyMs: maxEventLatency,
        topTokenConsumer: topToken,
        topLatencyConsumer: topLatency,
        perChild: perChildEntries,
    };
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
/** Renders heatmap cells into HTML using deterministic normalisation. */
function renderHeatmapCellsHtml(cells, emptyMessage) {
    if (cells.length === 0) {
        return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    }
    const normalised = normaliseHeatmapCellsForHtml(cells);
    const rendered = normalised
        .map(({ cell, normalised }) => {
        const valueLabel = formatNumber(cell.value);
        const alpha = normalised.toFixed(3);
        return `<span class="heatmap-cell" style="--cell-alpha:${alpha}" title="${escapeHtml(`${cell.label} – ${valueLabel}`)}"><strong>${escapeHtml(cell.label)}</strong><small>${escapeHtml(valueLabel)}</small></span>`;
    })
        .join("\n");
    return `<div class="heatmap-cells">${rendered}</div>`;
}
/** Normalises heatmap values, falling back to raw magnitudes when needed. */
function normaliseHeatmapCellsForHtml(cells) {
    let fallbackMax = 0;
    for (const cell of cells) {
        if (typeof cell.normalised !== "number" || !Number.isFinite(cell.normalised)) {
            fallbackMax = Math.max(fallbackMax, cell.value);
        }
    }
    return cells.map((cell) => {
        let normalised;
        if (typeof cell.normalised === "number" && Number.isFinite(cell.normalised)) {
            normalised = Math.max(0, Math.min(1, cell.normalised));
        }
        else if (fallbackMax > 0) {
            normalised = Math.max(0, Math.min(1, cell.value / fallbackMax));
        }
        else {
            normalised = 0;
        }
        return { cell, normalised };
    });
}
/** Serialises timeline filter options into `<option>` elements. */
function renderTimelineFilterOptions(values) {
    const options = ['<option value="">Tous</option>'];
    for (const value of values) {
        options.push(`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
    }
    return options.join("\n");
}
/** Renders the ordered timeline entries into list items. */
function renderTimelineEventsHtml(events) {
    if (events.length === 0) {
        return '<li class="timeline-empty">Aucun événement n\'a encore été enregistré.</li>';
    }
    return events
        .map((event) => {
        const iso = Number.isFinite(event.ts) ? formatIsoTimestamp(event.ts) : null;
        const meta = [];
        if (event.jobId) {
            meta.push(`job ${event.jobId}`);
        }
        if (event.childId) {
            meta.push(`child ${event.childId}`);
        }
        const metaLabel = meta.length > 0 ? meta.join(" • ") : "—";
        const datetimeAttr = iso ? ` datetime=\"${escapeHtml(iso)}\"` : "";
        return `<li><time${datetimeAttr}>${escapeHtml(formatTimestamp(event.ts))}</time><span class="timeline-kind">${escapeHtml(event.kind)}</span><span class="timeline-summary">${escapeHtml(event.summary)}</span><span class="timeline-meta">${escapeHtml(metaLabel)}</span></li>`;
    })
        .join("\n");
}
/** Formats consensus statistics into a metrics table. */
function renderConsensusStatsHtml(stats) {
    const rows = [
        ["Décisions", formatNumber(stats.total)],
        ["Satisfaites", formatNumber(stats.satisfied)],
        ["Non satisfaites", formatNumber(stats.unsatisfied)],
        ["Égalités", formatNumber(stats.ties)],
    ];
    return renderMetricsTableHtml(rows, "Aucune décision de consensus enregistrée.");
}
/** Renders the latest consensus decision. */
function renderConsensusLatestHtml(latest) {
    if (!latest) {
        return '<p class="empty-state">Aucune décision récente.</p>';
    }
    const rows = [
        ["Horodatage", formatTimestamp(latest.ts)],
        ["Mode", latest.mode ?? "n/a"],
        ["Résultat", latest.outcome ?? "n/a"],
        ["Satisfait", formatConsensusBoolean(latest.satisfied)],
        ["Égalité", formatConsensusBoolean(latest.tie)],
        ["Votes", latest.votes === null ? "n/a" : formatNumber(latest.votes)],
        ["Poids total", latest.totalWeight === null ? "n/a" : formatNumber(latest.totalWeight)],
        ["Seuil", latest.threshold === null ? "n/a" : formatNumber(latest.threshold)],
    ];
    if (latest.metadata) {
        const details = [];
        if (typeof latest.metadata.policy === "string") {
            details.push(`Politique : ${latest.metadata.policy}`);
        }
        if (typeof latest.metadata.winning_child_id === "string") {
            details.push(`Gagnant : ${latest.metadata.winning_child_id}`);
        }
        if (typeof latest.metadata.quorum_threshold === "number") {
            details.push(`Quorum : ${formatNumber(latest.metadata.quorum_threshold)}`);
        }
        if (details.length > 0) {
            rows.push(["Détails", details.join(" • ")]);
        }
    }
    if (latest.tally) {
        rows.push(["Tally", formatConsensusTally(latest.tally)]);
    }
    return renderMetricsTableHtml(rows, "Aucune décision récente.");
}
/** Formats a boolean consensus flag into a French label. */
function formatConsensusBoolean(value) {
    if (value === null) {
        return "n/a";
    }
    return value ? "oui" : "non";
}
/** Formats the consensus tally record. */
function formatConsensusTally(tally) {
    return Object.entries(tally)
        .map(([key, value]) => `${key}: ${formatNumber(value)}`)
        .join(" · ");
}
/** Renders the consensus history table. */
function renderConsensusHistoryHtml(decisions) {
    if (decisions.length === 0) {
        return '<p class="empty-state">Aucune décision historique disponible.</p>';
    }
    const rows = decisions
        .map((decision) => {
        const iso = Number.isFinite(decision.ts) ? formatIsoTimestamp(decision.ts) : null;
        const datetimeAttr = iso ? ` datetime=\"${escapeHtml(iso)}\"` : "";
        return `<tr><td><time${datetimeAttr}>${escapeHtml(formatTimestamp(decision.ts))}</time></td><td>${escapeHtml(decision.mode ?? "n/a")}</td><td>${escapeHtml(decision.outcome ?? "n/a")}</td><td>${escapeHtml(decision.votes === null ? "n/a" : formatNumber(decision.votes))}</td><td>${escapeHtml(formatConsensusBoolean(decision.tie))}</td></tr>`;
    })
        .join("\n");
    return `<table class="metrics-table consensus-table"><thead><tr><th scope="col">Horodatage</th><th scope="col">Mode</th><th scope="col">Résultat</th><th scope="col">Votes</th><th scope="col">Égalité</th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** Formats a human readable goal label for the ThoughtGraph section. */
function formatThoughtGoal(goal) {
    if (!goal) {
        return "Objectif : n/a";
    }
    return `Objectif : ${goal}`;
}
/** Renders the ThoughtGraph projections into responsive cards. */
function renderThoughtGraphHeatmapHtml(projections) {
    if (projections.length === 0) {
        return '<p class="empty-state">Aucun graphe de pensée disponible.</p>';
    }
    return projections
        .map((projection) => {
        const nodes = projection.nodes
            .map((node) => {
            const alpha = (node.normalisedScore ?? 0).toFixed(3);
            const scoreLabel = node.score === null ? "n/a" : formatNumber(node.score);
            const details = `Score : ${scoreLabel} • Profondeur : ${node.depth} • Statut : ${node.status}${node.provenanceCount > 0 ? ` • Provenance : ${node.provenanceCount}` : ""}`;
            return `<span class="thought-heatmap-node thought-heatmap-node--${escapeHtml(node.status)}" style="--node-alpha:${alpha}" title="${escapeHtml(details)}"><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(details)}</small></span>`;
        })
            .join("\n");
        return `<article class="thought-heatmap-card"><header><h3>${escapeHtml(projection.jobId)}</h3><p>${escapeHtml(formatThoughtGoal(projection.goal))}</p><p class="thought-heatmap-meta">Mise à jour : ${escapeHtml(formatTimestamp(projection.updatedAt))}</p></header><div class="thought-heatmap-nodes">${nodes}</div></article>`;
    })
        .join("\n");
}
/** Converts a timestamp to ISO format while guarding against invalid values. */
function formatIsoTimestamp(value) {
    if (!Number.isFinite(value)) {
        return null;
    }
    try {
        return new Date(value).toISOString();
    }
    catch {
        return null;
    }
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
            ["Max intensity", formatNullableNumber(watcher.lastSnapshot.lastBounds.max_intensity)],
            ["Normalisation ceiling", formatNumber(watcher.lastSnapshot.lastBounds.normalisation_ceiling)],
        ]
        : [], watcher?.lastSnapshot
        ? "Aucune borne normalisée n'a été enregistrée."
        : "Aucune télémétrie Contract-Net disponible.");
    const stigSummaryRows = snapshot.stigmergy.rows
        .map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`)
        .join("\n");
    const tooltip = snapshot.heatmap.boundsTooltip ?? "";
    const runtimeSummaryRows = [
        ["Tokens totaux", formatNumber(snapshot.runtimeCosts.totalTokens)],
        ["Temps CPU total (ms)", formatNumber(snapshot.runtimeCosts.totalLatencyMs)],
        ["Latence moyenne (ms)", formatNullableNumber(snapshot.runtimeCosts.avgLatencyMs)],
        ["Latence maximale (ms)", formatNullableNumber(snapshot.runtimeCosts.maxLatencyMs)],
        ["Échantillons de latence", formatNumber(snapshot.runtimeCosts.sampleCount)],
        [
            "Top tokens",
            snapshot.runtimeCosts.topTokenConsumer
                ? `${snapshot.runtimeCosts.topTokenConsumer.label} – ${formatNumber(snapshot.runtimeCosts.topTokenConsumer.tokens)} tokens`
                : "n/a",
        ],
        [
            "Top latence",
            snapshot.runtimeCosts.topLatencyConsumer
                ? `${snapshot.runtimeCosts.topLatencyConsumer.label} – ${formatNumber(snapshot.runtimeCosts.topLatencyConsumer.latencyMs)} ms`
                : "n/a",
        ],
    ];
    const runtimeSummary = renderMetricsTableHtml(runtimeSummaryRows, "Aucune métrique runtime disponible pour le moment.");
    const runtimeLeaderboardRows = snapshot.runtimeCosts.perChild.slice(0, 5).map((entry) => [
        `${entry.label} (${entry.childId})`,
        `Tokens : ${formatNumber(entry.tokens)} · CPU : ${formatNumber(entry.latencyMs)} ms`,
    ]);
    const runtimeLeaderboard = renderMetricsTableHtml(runtimeLeaderboardRows, "Aucun enfant actif n'a encore publié de métriques.");
    const heatmapIdle = renderHeatmapCellsHtml(snapshot.heatmap.idle, "Aucun enfant ne semble inactif pour le moment.");
    const heatmapErrors = renderHeatmapCellsHtml(snapshot.heatmap.errors, "Aucune erreur n'a été recensée récemment.");
    const heatmapTokens = renderHeatmapCellsHtml(snapshot.heatmap.tokens, "Aucune consommation de tokens n'a été enregistrée.");
    const heatmapLatency = renderHeatmapCellsHtml(snapshot.heatmap.latency, "Aucune mesure de latence n'est disponible.");
    const heatmapPheromones = renderHeatmapCellsHtml(snapshot.heatmap.pheromones, "Aucune phéromone n'a encore été déposée dans le champ.");
    const timelineFilters = snapshot.timeline.filters;
    const timelineKindOptions = renderTimelineFilterOptions(timelineFilters.kinds);
    const timelineLevelOptions = renderTimelineFilterOptions(timelineFilters.levels);
    const timelineSourceOptions = renderTimelineFilterOptions(timelineFilters.sources);
    const timelineJobOptions = renderTimelineFilterOptions(timelineFilters.jobs);
    const timelineChildOptions = renderTimelineFilterOptions(timelineFilters.children);
    const timelineEventsHtml = renderTimelineEventsHtml(snapshot.timeline.events);
    const consensusStatsHtml = renderConsensusStatsHtml(snapshot.consensus.stats);
    const consensusLatestHtml = renderConsensusLatestHtml(snapshot.consensus.latest);
    const consensusHistoryHtml = renderConsensusHistoryHtml(snapshot.consensus.recent);
    const thoughtHeatmapHtml = renderThoughtGraphHeatmapHtml(snapshot.thoughtGraph);
    const initialSnapshotScriptPayload = serialiseSnapshotForInlineScript(snapshot);
    return `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Orchestrateur – Dashboard</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
      h1, h2, h3 { margin: 0 0 12px; }
      section { margin-bottom: 32px; padding: 16px 20px; background: #1e293b; border-radius: 12px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.35); }
      .metrics-table { border-collapse: collapse; width: 100%; }
      .metrics-table th { text-align: left; padding: 8px 12px; font-weight: 600; color: #cbd5f5; width: 55%; }
      .metrics-table td { padding: 8px 12px; color: #e0f2fe; }
      .metrics-table tr:nth-child(even) { background: rgba(148, 163, 184, 0.1); }
      .consensus-table thead { background: rgba(148, 163, 184, 0.15); }
      .empty-state { margin: 0; padding: 12px 16px; background: rgba(148, 163, 184, 0.15); border-radius: 8px; color: #f8fafc; }
      .two-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
      .status { margin: 8px 0 0; font-size: 0.95rem; font-weight: 500; }
      .status--pending { color: #facc15; }
      .status--connected { color: #4ade80; }
      .status--error { color: #f87171; }
      .dashboard-card { min-height: 40px; }
      .heatmap-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
      .heatmap-card { --heatmap-color: 59, 130, 246; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.2); background: rgba(148, 163, 184, 0.08); min-height: 120px; }
      .heatmap-card[data-variant="errors"] { --heatmap-color: 248, 113, 113; }
      .heatmap-card[data-variant="tokens"] { --heatmap-color: 34, 197, 94; }
      .heatmap-card[data-variant="latency"] { --heatmap-color: 129, 140, 248; }
      .heatmap-card[data-variant="pheromones"] { --heatmap-color: 250, 204, 21; }
      .heatmap-cells { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
      .heatmap-cell { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 10px; border: 1px solid rgba(var(--heatmap-color), 0.35); background: rgba(var(--heatmap-color), calc(0.18 + var(--cell-alpha, 0.2))); color: #f8fafc; transition: background 0.2s ease, border-color 0.2s ease; }
      .heatmap-cell strong { font-size: 0.95rem; }
      .heatmap-cell small { font-size: 0.8rem; color: rgba(241, 245, 249, 0.85); }
      .timeline-controls { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
      .timeline-controls label { display: flex; flex-direction: column; font-size: 0.85rem; color: #cbd5f5; }
      .timeline-controls select { margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: #0f172a; color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.4); }
      .timeline-events { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
      .timeline-events li { padding: 12px; border-radius: 10px; background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.2); display: grid; gap: 6px; }
      .timeline-events time { font-size: 0.8rem; color: #cbd5f5; }
      .timeline-kind { font-weight: 600; color: #93c5fd; }
      .timeline-summary { color: #e0f2fe; }
      .timeline-meta { color: #cbd5f5; font-size: 0.8rem; }
      .timeline-empty { padding: 12px; border-radius: 8px; background: rgba(148, 163, 184, 0.15); color: #f8fafc; }
      .thought-heatmap { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
      .thought-heatmap-card { padding: 16px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.25); background: rgba(30, 58, 138, 0.35); display: flex; flex-direction: column; gap: 12px; }
      .thought-heatmap-card header h3 { margin-bottom: 4px; }
      .thought-heatmap-meta { margin: 0; font-size: 0.8rem; color: #cbd5f5; }
      .thought-heatmap-nodes { display: grid; gap: 8px; }
      .thought-heatmap-node { padding: 10px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.25); background: rgba(56, 189, 248, calc(0.15 + var(--node-alpha, 0.2))); display: grid; gap: 4px; }
      .thought-heatmap-node strong { color: #f0f9ff; }
      .thought-heatmap-node small { color: #cbd5f5; font-size: 0.78rem; }
      .thought-heatmap-node--completed { --node-alpha: calc(var(--node-alpha, 0.25) + 0.1); background: rgba(34, 197, 94, calc(0.18 + var(--node-alpha, 0.25))); }
      .thought-heatmap-node--errored { background: rgba(248, 113, 113, calc(0.2 + var(--node-alpha, 0.2))); }
      .thought-heatmap-node--running { background: rgba(129, 140, 248, calc(0.2 + var(--node-alpha, 0.2))); }
      .thought-heatmap-node--pruned { background: rgba(148, 163, 184, calc(0.15 + var(--node-alpha, 0.15))); }
      .consensus-layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
      .consensus-history { margin-top: 16px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Orchestrateur – Tableau de bord</h1>
      <p>Instantané généré le <strong id="dashboard-timestamp">${formatTimestamp(snapshot.timestamp)}</strong>.</p>
      <p id="connection-status" class="status status--pending" role="status">SSE : initialisation…</p>
    </header>

    <section aria-labelledby="runtime-metrics">
      <h2 id="runtime-metrics">Coûts &amp; latence</h2>
      <div class="two-columns">
        <article>
          <h3>Résumé agrégé</h3>
          <div id="runtime-summary" class="dashboard-card" aria-live="polite">
            ${runtimeSummary}
          </div>
        </article>
        <article>
          <h3>Consommateurs principaux</h3>
          <div id="runtime-leaderboard" class="dashboard-card" aria-live="polite">
            ${runtimeLeaderboard}
          </div>
        </article>
      </div>
    </section>

    <section aria-labelledby="heatmap-section">
      <h2 id="heatmap-section">Heatmap des enfants &amp; stigmergie</h2>
      <div class="heatmap-panels">
        <article>
          <h3>Inactivité</h3>
          <div id="heatmap-idle" class="dashboard-card heatmap-card" aria-live="polite">
            ${heatmapIdle}
          </div>
        </article>
        <article>
          <h3>Erreurs</h3>
          <div id="heatmap-errors" class="dashboard-card heatmap-card" data-variant="errors" aria-live="polite">
            ${heatmapErrors}
          </div>
        </article>
        <article>
          <h3>Tokens</h3>
          <div id="heatmap-tokens" class="dashboard-card heatmap-card" data-variant="tokens" aria-live="polite">
            ${heatmapTokens}
          </div>
        </article>
        <article>
          <h3>Latence</h3>
          <div id="heatmap-latency" class="dashboard-card heatmap-card" data-variant="latency" aria-live="polite">
            ${heatmapLatency}
          </div>
        </article>
        <article>
          <h3>Pheromones</h3>
          <div id="heatmap-pheromones" class="dashboard-card heatmap-card" data-variant="pheromones" aria-live="polite">
            ${heatmapPheromones}
          </div>
        </article>
      </div>
    </section>

    <section aria-labelledby="consensus-section">
      <h2 id="consensus-section">Votes de consensus</h2>
      <div class="consensus-layout">
        <article>
          <h3>Statistiques</h3>
          <div id="consensus-stats" class="dashboard-card" aria-live="polite">
            ${consensusStatsHtml}
          </div>
        </article>
        <article>
          <h3>Dernière décision</h3>
          <div id="consensus-latest" class="dashboard-card" aria-live="polite">
            ${consensusLatestHtml}
          </div>
        </article>
      </div>
      <article class="consensus-history">
        <h3>Historique récent</h3>
        <div id="consensus-history" class="dashboard-card" aria-live="polite">
          ${consensusHistoryHtml}
        </div>
      </article>
    </section>

    <section aria-labelledby="timeline-section">
      <h2 id="timeline-section">Timeline causale</h2>
      <div class="timeline-controls">
        <label for="timeline-filter-kind">Type
          <select id="timeline-filter-kind">
            ${timelineKindOptions}
          </select>
        </label>
        <label for="timeline-filter-level">Niveau
          <select id="timeline-filter-level">
            ${timelineLevelOptions}
          </select>
        </label>
        <label for="timeline-filter-source">Source
          <select id="timeline-filter-source">
            ${timelineSourceOptions}
          </select>
        </label>
        <label for="timeline-filter-job">Job
          <select id="timeline-filter-job">
            ${timelineJobOptions}
          </select>
        </label>
        <label for="timeline-filter-child">Enfant
          <select id="timeline-filter-child">
            ${timelineChildOptions}
          </select>
        </label>
      </div>
      <ol id="timeline-events" class="timeline-events" aria-live="polite">
        ${timelineEventsHtml}
      </ol>
    </section>

    <section aria-labelledby="thought-heatmap-section">
      <h2 id="thought-heatmap-section">Heatmap des branches (ThoughtGraph)</h2>
      <div id="thought-heatmap" class="thought-heatmap" aria-live="polite">
        ${thoughtHeatmapHtml}
      </div>
    </section>

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
 * Builds the inline dashboard bootstrap script. The generated JavaScript mirrors the
 * server-side helpers so SSE updates keep the heatmap, timeline, consensus, and
 * ThoughtGraph sections in sync with the HTML rendered on the initial request.
 */
function buildDashboardBootstrapScript(serialisedSnapshot) {
    const script = `(() => {
  // Inline bootstrap executed directly in the dashboard page. The logic keeps the
  // rendered sections aligned with the latest SSE snapshot while mirroring the
  // server-side helpers (heatmap, timeline, consensus, ThoughtGraph). All DOM
  // writes rely on textContent/appendChild to avoid HTML injection risks.
  const initialSnapshot = ${serialisedSnapshot};
  let latestSnapshot = initialSnapshot;
  let timelineEvents = initialSnapshot.timeline.events.slice();

  const statusElement = document.getElementById("connection-status");
  const LOG_ENDPOINT = "logs";
  const MAX_LOG_STRING_LENGTH = 512;
  const MAX_LOG_ARRAY_LENGTH = 10;
  const MAX_LOG_OBJECT_KEYS = 20;
  const MAX_LOG_DEPTH = 3;

  // Emits structured telemetry back to the server without relying on console.* APIs.
  function emitClientLog(level, event, context) {
    try {
      const seen = typeof WeakSet === "function" ? new WeakSet() : undefined;

      function sanitise(value, depth) {
        if (value === null || value === undefined) {
          return null;
        }
        if (typeof value === "string") {
          if (value.length > MAX_LOG_STRING_LENGTH) {
            return value.slice(0, MAX_LOG_STRING_LENGTH - 1) + "…";
          }
          return value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return value;
        }
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: typeof value.stack === "string" ? value.stack : null,
          };
        }
        if (depth >= MAX_LOG_DEPTH) {
          return "[Truncated]";
        }
        if (value && typeof value === "object") {
          if (seen) {
            if (seen.has(value)) {
              return "[Circular]";
            }
            seen.add(value);
          }
          if (Array.isArray(value)) {
            const trimmed = value.slice(0, MAX_LOG_ARRAY_LENGTH);
            return trimmed.map((item) => sanitise(item, depth + 1));
          }
          const entries = {};
          let index = 0;
          for (const [key, entry] of Object.entries(value)) {
            if (index >= MAX_LOG_OBJECT_KEYS) {
              entries.__truncated__ = true;
              break;
            }
            entries[key] = sanitise(entry, depth + 1);
            index += 1;
          }
          return entries;
        }
        return String(value);
      }

      const payload = JSON.stringify({
        level,
        event,
        context: context === undefined ? null : sanitise(context, 0),
      });

      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon(LOG_ENDPOINT, blob)) {
          return;
        }
      }

      if (typeof fetch === "function") {
        void fetch(LOG_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        });
      }
    } catch {
      // Intentionally swallow logging transport errors to avoid cascading failures.
    }
  }

  // Updates the textual status banner displayed below the title.
  function updateStatus(message, variant) {
    if (!statusElement) {
      return;
    }
    statusElement.textContent = message;
    statusElement.classList.remove("status--pending", "status--connected", "status--error");
    statusElement.classList.add("status--" + variant);
  }

  // Formats timestamps (epoch milliseconds) into ISO strings or 'n/a'.
  function formatTimestampForClient(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "n/a";
    }
    try {
      return new Date(value).toISOString();
    } catch (error) {
      emitClientLog("warn", "dashboard_timestamp_parse_failure", { value, error });
      return String(value);
    }
  }

  // Converts timestamps into ISO strings usable by <time datetime="…">.
  function formatIsoTimestampForClient(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    try {
      return new Date(value).toISOString();
    } catch (error) {
      emitClientLog("warn", "dashboard_iso_timestamp_failure", { value, error });
      return null;
    }
  }

  // Mirrors the server-side formatting logic for compact numbers.
  function formatNumberForClient(value) {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
      return String(value);
    }
    return value.toFixed(3);
  }

  // Formats nullable numbers, returning 'n/a' when empty.
  function formatNullableNumberForClient(value) {
    return value === null ? "n/a" : formatNumberForClient(value);
  }

  // Renders a short empty-state paragraph inside the provided container.
  function renderEmptyState(container, message) {
    if (!container) {
      return;
    }
    container.textContent = "";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = message;
    container.appendChild(empty);
  }

  // Renders a metrics table inside the provided container. When no rows are
  // available the function falls back to an informative empty state.
  function renderMetricsTable(containerId, rows, emptyMessage) {
    const container = document.getElementById(containerId);
    if (!container) {
      return;
    }
    container.textContent = "";
    if (!rows.length) {
      renderEmptyState(container, emptyMessage);
      return;
    }
    const table = document.createElement("table");
    table.className = "metrics-table";
    const body = document.createElement("tbody");
    for (const [label, value] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(th);
      tr.appendChild(td);
      body.appendChild(tr);
    }
    table.appendChild(body);
    container.appendChild(table);
  }

  // Normalises heatmap values, falling back to raw magnitudes when needed.
  function normaliseHeatmapCellsForClient(cells) {
    let fallbackMax = 0;
    for (const cell of cells) {
      if (typeof cell.normalised !== "number" || !Number.isFinite(cell.normalised)) {
        fallbackMax = Math.max(fallbackMax, cell.value);
      }
    }
    return cells.map((cell) => {
      let normalised;
      if (typeof cell.normalised === "number" && Number.isFinite(cell.normalised)) {
        normalised = Math.max(0, Math.min(1, cell.normalised));
      } else if (fallbackMax > 0) {
        normalised = Math.max(0, Math.min(1, cell.value / fallbackMax));
      } else {
        normalised = 0;
      }
      return { cell, normalised };
    });
  }

  // Renders the heatmap cards for a given set of cells.
  function renderHeatmap(containerId, cells, emptyMessage) {
    const container = document.getElementById(containerId);
    if (!container) {
      return;
    }
    container.textContent = "";
    if (!cells.length) {
      renderEmptyState(container, emptyMessage);
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "heatmap-cells";
    const normalised = normaliseHeatmapCellsForClient(cells);
    for (const { cell, normalised: value } of normalised) {
      const item = document.createElement("span");
      item.className = "heatmap-cell";
      item.style.setProperty("--cell-alpha", value.toFixed(3));
      const valueLabel = formatNumberForClient(cell.value);
      item.title = cell.label + " – " + valueLabel;
      const title = document.createElement("strong");
      title.textContent = cell.label;
      const subtitle = document.createElement("small");
      subtitle.textContent = valueLabel;
      item.appendChild(title);
      item.appendChild(subtitle);
      wrapper.appendChild(item);
    }
    container.appendChild(wrapper);
  }

  const heatmapEmptyMessages = {
    idle: "Aucun enfant ne semble inactif pour le moment.",
    errors: "Aucune erreur n'a été recensée récemment.",
    tokens: "Aucune consommation de tokens n'a été enregistrée.",
    latency: "Aucune mesure de latence n'est disponible.",
    pheromones: "Aucune phéromone n'a encore été déposée dans le champ.",
  };

  // Updates the five heatmap panels (idle/errors/tokens/latency/pheromones).
  function updateHeatmap(snapshot) {
    renderHeatmap("heatmap-idle", snapshot.heatmap.idle, heatmapEmptyMessages.idle);
    renderHeatmap("heatmap-errors", snapshot.heatmap.errors, heatmapEmptyMessages.errors);
    renderHeatmap("heatmap-tokens", snapshot.heatmap.tokens, heatmapEmptyMessages.tokens);
    renderHeatmap("heatmap-latency", snapshot.heatmap.latency, heatmapEmptyMessages.latency);
    renderHeatmap("heatmap-pheromones", snapshot.heatmap.pheromones, heatmapEmptyMessages.pheromones);
  }

  // Updates the Stigmergy summary table and tooltip.
  function updateStigmergy(snapshot) {
    const tbody = document.getElementById("stigmergy-summary-rows");
    if (tbody) {
      tbody.textContent = "";
      for (const row of snapshot.stigmergy.rows) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = row.label;
        const td = document.createElement("td");
        td.textContent = row.value;
        tr.appendChild(th);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      if (!snapshot.stigmergy.rows.length) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = "Aucune donnée";
        const td = document.createElement("td");
        td.textContent = "n/a";
        tr.appendChild(th);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }
    const tooltip = document.getElementById("stigmergy-tooltip");
    if (tooltip) {
      tooltip.textContent = snapshot.heatmap.boundsTooltip ?? "";
    }
  }

  // Updates Contract-Net watcher counters and bounds.
  function updateContractNet(snapshot) {
    const watcher = snapshot.contractNetWatcherTelemetry;
    if (!watcher) {
      renderMetricsTable("contract-net-summary", [], "Aucune télémétrie Contract-Net disponible.");
      renderMetricsTable("contract-net-details", [], "Aucune télémétrie Contract-Net disponible.");
      renderMetricsTable("contract-net-bounds", [], "Aucune télémétrie Contract-Net disponible.");
      return;
    }
    renderMetricsTable(
      "contract-net-summary",
      [
        ["Emissions", formatNumberForClient(watcher.emissions)],
        ["Dernier événement", formatTimestampForClient(watcher.lastEmittedAtMs)],
      ],
      "Aucune télémétrie Contract-Net disponible.",
    );

    const lastSnapshot = watcher.lastSnapshot;
    renderMetricsTable(
      "contract-net-details",
      lastSnapshot
        ? [
            ["Raison", lastSnapshot.reason],
            ["Notifications reçues", formatNumberForClient(lastSnapshot.receivedUpdates)],
            ["Notifications coalescées", formatNumberForClient(lastSnapshot.coalescedUpdates)],
            ["Rafraîchissements ignorés", formatNumberForClient(lastSnapshot.skippedRefreshes)],
            ["Rafraîchissements appliqués", formatNumberForClient(lastSnapshot.appliedRefreshes)],
            ["Flushs", formatNumberForClient(lastSnapshot.flushes)],
          ]
        : [],
      lastSnapshot
        ? "Le watcher n'a pas encore publié de compteur."
        : "Aucune télémétrie Contract-Net disponible.",
    );

    const lastBounds = lastSnapshot && lastSnapshot.lastBounds ? lastSnapshot.lastBounds : null;
    renderMetricsTable(
      "contract-net-bounds",
      lastBounds
        ? [
            ["Min intensity", formatNumberForClient(lastBounds.min_intensity)],
            [
              "Max intensity",
              lastBounds.max_intensity === null ? "n/a" : formatNumberForClient(lastBounds.max_intensity),
            ],
            ["Normalisation ceiling", formatNumberForClient(lastBounds.normalisation_ceiling)],
          ]
        : [],
      lastSnapshot
        ? "Aucune borne normalisée n'a été enregistrée."
        : "Aucune télémétrie Contract-Net disponible.",
    );
  }

  // Updates scheduler counters embedded in the HTML table.
  function updateScheduler(snapshot) {
    const tick = document.getElementById("scheduler-tick");
    if (tick) {
      tick.textContent = String(snapshot.scheduler.tick);
    }
    const backlog = document.getElementById("scheduler-backlog");
    if (backlog) {
      backlog.textContent = String(snapshot.scheduler.backlog);
    }
    const completed = document.getElementById("scheduler-completed");
    if (completed) {
      completed.textContent = String(snapshot.scheduler.completed);
    }
    const failed = document.getElementById("scheduler-failed");
    if (failed) {
      failed.textContent = String(snapshot.scheduler.failed);
    }
    const updatedAt = document.getElementById("scheduler-updated-at");
    if (updatedAt) {
      updatedAt.textContent = formatTimestampForClient(snapshot.scheduler.updatedAt);
    }
  }

  // Updates the runtime metrics summary and leaderboard tables.
  function updateRuntime(snapshot) {
    const topTokenLabel = snapshot.runtimeCosts.topTokenConsumer
      ? snapshot.runtimeCosts.topTokenConsumer.label +
        " – " +
        formatNumberForClient(snapshot.runtimeCosts.topTokenConsumer.tokens) +
        " tokens"
      : "n/a";
    const topLatencyLabel = snapshot.runtimeCosts.topLatencyConsumer
      ? snapshot.runtimeCosts.topLatencyConsumer.label +
        " – " +
        formatNumberForClient(snapshot.runtimeCosts.topLatencyConsumer.latencyMs) +
        " ms"
      : "n/a";
    const summaryRows = [
      ["Tokens totaux", formatNumberForClient(snapshot.runtimeCosts.totalTokens)],
      ["Temps CPU total (ms)", formatNumberForClient(snapshot.runtimeCosts.totalLatencyMs)],
      ["Latence moyenne (ms)", formatNullableNumberForClient(snapshot.runtimeCosts.avgLatencyMs)],
      ["Latence maximale (ms)", formatNullableNumberForClient(snapshot.runtimeCosts.maxLatencyMs)],
      ["Échantillons de latence", formatNumberForClient(snapshot.runtimeCosts.sampleCount)],
      ["Top tokens", topTokenLabel],
      ["Top latence", topLatencyLabel],
    ];
    renderMetricsTable(
      "runtime-summary",
      summaryRows,
      "Aucune métrique runtime disponible pour le moment.",
    );

    const leaderboardRows = snapshot.runtimeCosts.perChild.slice(0, 5).map((entry) => [
      entry.label + " (" + entry.childId + ")",
      "Tokens : " +
        formatNumberForClient(entry.tokens) +
        " · CPU : " +
        formatNumberForClient(entry.latencyMs) +
        " ms",
    ]);

    renderMetricsTable(
      "runtime-leaderboard",
      leaderboardRows,
      "Aucun enfant actif n'a encore publié de métriques.",
    );
  }

  // Formats the boolean consensus flags into French labels.
  function formatConsensusBoolean(value) {
    if (value === null) {
      return "n/a";
    }
    return value ? "oui" : "non";
  }

  // Formats the consensus tally record for inline display.
  function formatConsensusTally(tally) {
    const parts = [];
    for (const key of Object.keys(tally)) {
      parts.push(key + ": " + formatNumberForClient(tally[key]));
    }
    return parts.join(" · ");
  }

  // Updates the consensus statistics, latest decision and history table.
  function updateConsensus(snapshot) {
    const statsRows = [
      ["Décisions", formatNumberForClient(snapshot.consensus.stats.total)],
      ["Satisfaites", formatNumberForClient(snapshot.consensus.stats.satisfied)],
      ["Non satisfaites", formatNumberForClient(snapshot.consensus.stats.unsatisfied)],
      ["Égalités", formatNumberForClient(snapshot.consensus.stats.ties)],
    ];
    renderMetricsTable("consensus-stats", statsRows, "Aucune décision de consensus enregistrée.");

    const latest = snapshot.consensus.latest;
    if (!latest) {
      renderMetricsTable("consensus-latest", [], "Aucune décision récente.");
    } else {
      const rows = [
        ["Horodatage", formatTimestampForClient(latest.ts)],
        ["Mode", latest.mode ?? "n/a"],
        ["Résultat", latest.outcome ?? "n/a"],
        ["Satisfait", formatConsensusBoolean(latest.satisfied)],
        ["Égalité", formatConsensusBoolean(latest.tie)],
        ["Votes", latest.votes === null ? "n/a" : formatNumberForClient(latest.votes)],
        ["Poids total", latest.totalWeight === null ? "n/a" : formatNumberForClient(latest.totalWeight)],
        ["Seuil", latest.threshold === null ? "n/a" : formatNumberForClient(latest.threshold)],
      ];
      if (latest.metadata) {
        const details = [];
        if (typeof latest.metadata.policy === "string") {
          details.push("Politique : " + latest.metadata.policy);
        }
        if (typeof latest.metadata.winning_child_id === "string") {
          details.push("Gagnant : " + latest.metadata.winning_child_id);
        }
        if (typeof latest.metadata.quorum_threshold === "number") {
          details.push("Quorum : " + formatNumberForClient(latest.metadata.quorum_threshold));
        }
        if (details.length) {
          rows.push(["Détails", details.join(" • ")]);
        }
      }
      if (latest.tally) {
        rows.push(["Tally", formatConsensusTally(latest.tally)]);
      }
      renderMetricsTable("consensus-latest", rows, "Aucune décision récente.");
    }

    const historyContainer = document.getElementById("consensus-history");
    if (!historyContainer) {
      return;
    }
    historyContainer.textContent = "";
    if (!snapshot.consensus.recent.length) {
      renderEmptyState(historyContainer, "Aucune décision historique disponible.");
      return;
    }
    const table = document.createElement("table");
    table.className = "metrics-table consensus-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = ["Horodatage", "Mode", "Résultat", "Votes", "Égalité"];
    for (const label of headers) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    for (const decision of snapshot.consensus.recent) {
      const tr = document.createElement("tr");
      const timeCell = document.createElement("td");
      const time = document.createElement("time");
      const iso = formatIsoTimestampForClient(decision.ts);
      if (iso) {
        time.setAttribute("datetime", iso);
      }
      time.textContent = formatTimestampForClient(decision.ts);
      timeCell.appendChild(time);
      tr.appendChild(timeCell);

      const modeCell = document.createElement("td");
      modeCell.textContent = decision.mode ?? "n/a";
      tr.appendChild(modeCell);

      const outcomeCell = document.createElement("td");
      outcomeCell.textContent = decision.outcome ?? "n/a";
      tr.appendChild(outcomeCell);

      const votesCell = document.createElement("td");
      votesCell.textContent = decision.votes === null ? "n/a" : formatNumberForClient(decision.votes);
      tr.appendChild(votesCell);

      const tieCell = document.createElement("td");
      tieCell.textContent = formatConsensusBoolean(decision.tie);
      tr.appendChild(tieCell);

      body.appendChild(tr);
    }
    table.appendChild(body);
    historyContainer.appendChild(table);
  }

  // Updates the <select> options without overriding the current selection.
  function updateTimelineFilterOptions(selectId, values) {
    const element = document.getElementById(selectId);
    if (!element || !(element instanceof HTMLSelectElement)) {
      return;
    }
    const previous = element.value;
    element.textContent = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "Tous";
    element.appendChild(allOption);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      element.appendChild(option);
    }
    if (previous && values.includes(previous)) {
      element.value = previous;
    } else {
      element.value = "";
    }
  }

  // Renders the ordered timeline entries into list items.
  function renderTimelineEventsList(events) {
    const list = document.getElementById("timeline-events");
    if (!list) {
      return;
    }
    list.textContent = "";
    if (!events.length) {
      const empty = document.createElement("li");
      empty.className = "timeline-empty";
      empty.textContent = "Aucun événement n'a encore été enregistré.";
      list.appendChild(empty);
      return;
    }
    for (const event of events) {
      const item = document.createElement("li");
      const time = document.createElement("time");
      const iso = formatIsoTimestampForClient(event.ts);
      if (iso) {
        time.setAttribute("datetime", iso);
      }
      time.textContent = formatTimestampForClient(event.ts);
      item.appendChild(time);

      const kind = document.createElement("span");
      kind.className = "timeline-kind";
      kind.textContent = event.kind;
      item.appendChild(kind);

      const summary = document.createElement("span");
      summary.className = "timeline-summary";
      summary.textContent = event.summary;
      item.appendChild(summary);

      const meta = document.createElement("span");
      meta.className = "timeline-meta";
      const parts = [];
      if (event.jobId) {
        parts.push("job " + event.jobId);
      }
      if (event.childId) {
        parts.push("child " + event.childId);
      }
      meta.textContent = parts.length ? parts.join(" • ") : "—";
      item.appendChild(meta);

      list.appendChild(item);
    }
  }

  // Applies the currently selected filters and re-renders the timeline.
  function applyTimelineFilters() {
    const kindSelect = document.getElementById("timeline-filter-kind");
    const levelSelect = document.getElementById("timeline-filter-level");
    const sourceSelect = document.getElementById("timeline-filter-source");
    const jobSelect = document.getElementById("timeline-filter-job");
    const childSelect = document.getElementById("timeline-filter-child");

    const kind = kindSelect && kindSelect instanceof HTMLSelectElement ? kindSelect.value : "";
    const level = levelSelect && levelSelect instanceof HTMLSelectElement ? levelSelect.value : "";
    const source = sourceSelect && sourceSelect instanceof HTMLSelectElement ? sourceSelect.value : "";
    const job = jobSelect && jobSelect instanceof HTMLSelectElement ? jobSelect.value : "";
    const child = childSelect && childSelect instanceof HTMLSelectElement ? childSelect.value : "";

    const filtered = timelineEvents.filter((event) => {
      if (kind && event.kind !== kind) {
        return false;
      }
      if (level && event.level !== level) {
        return false;
      }
      if (source && event.source !== source) {
        return false;
      }
      if (job && event.jobId !== job) {
        return false;
      }
      if (child && event.childId !== child) {
        return false;
      }
      return true;
    });

    renderTimelineEventsList(filtered);
  }

  // Updates the timeline filters and entries based on the snapshot payload.
  function updateTimeline(snapshot) {
    updateTimelineFilterOptions("timeline-filter-kind", snapshot.timeline.filters.kinds);
    updateTimelineFilterOptions("timeline-filter-level", snapshot.timeline.filters.levels);
    updateTimelineFilterOptions("timeline-filter-source", snapshot.timeline.filters.sources);
    updateTimelineFilterOptions("timeline-filter-job", snapshot.timeline.filters.jobs);
    updateTimelineFilterOptions("timeline-filter-child", snapshot.timeline.filters.children);
    timelineEvents = snapshot.timeline.events.slice();
    applyTimelineFilters();
  }

  // Formats a human readable goal label for the ThoughtGraph section.
  function formatThoughtGoalForClient(goal) {
    return goal ? "Objectif : " + goal : "Objectif : n/a";
  }

  // Updates the ThoughtGraph heatmap cards.
  function updateThoughtGraph(snapshot) {
    const container = document.getElementById("thought-heatmap");
    if (!container) {
      return;
    }
    container.textContent = "";
    if (!snapshot.thoughtGraph.length) {
      renderEmptyState(container, "Aucun graphe de pensée disponible.");
      return;
    }
    for (const projection of snapshot.thoughtGraph) {
      const card = document.createElement("article");
      card.className = "thought-heatmap-card";
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = projection.jobId;
      header.appendChild(title);
      const goal = document.createElement("p");
      goal.textContent = formatThoughtGoalForClient(projection.goal);
      header.appendChild(goal);
      const meta = document.createElement("p");
      meta.className = "thought-heatmap-meta";
      meta.textContent = "Mise à jour : " + formatTimestampForClient(projection.updatedAt);
      header.appendChild(meta);
      card.appendChild(header);

      const nodesContainer = document.createElement("div");
      nodesContainer.className = "thought-heatmap-nodes";
      for (const node of projection.nodes) {
        const nodeElement = document.createElement("span");
        nodeElement.className = "thought-heatmap-node thought-heatmap-node--" + node.status;
        const alpha = typeof node.normalisedScore === "number" && Number.isFinite(node.normalisedScore)
          ? Math.max(0, Math.min(1, node.normalisedScore))
          : 0;
        nodeElement.style.setProperty("--node-alpha", alpha.toFixed(3));
        const scoreLabel = node.score === null ? "n/a" : formatNumberForClient(node.score);
        let details = "Score : " + scoreLabel + " • Profondeur : " + node.depth + " • Statut : " + node.status;
        if (node.provenanceCount > 0) {
          details += " • Provenance : " + node.provenanceCount;
        }
        nodeElement.title = details;
        const name = document.createElement("strong");
        name.textContent = node.label;
        const info = document.createElement("small");
        info.textContent = details;
        nodeElement.appendChild(name);
        nodeElement.appendChild(info);
        nodesContainer.appendChild(nodeElement);
      }
      card.appendChild(nodesContainer);
      container.appendChild(card);
    }
  }

  // Synchronises the title timestamp with the latest snapshot.
  function updateHeader(snapshot) {
    const timestamp = document.getElementById("dashboard-timestamp");
    if (timestamp) {
      timestamp.textContent = formatTimestampForClient(snapshot.timestamp);
    }
  }

  // Applies the provided snapshot to every dashboard section.
  function applySnapshot(snapshot) {
    latestSnapshot = snapshot;
    updateHeader(snapshot);
    updateRuntime(snapshot);
    updateContractNet(snapshot);
    updateStigmergy(snapshot);
    updateScheduler(snapshot);
    updateHeatmap(snapshot);
    updateConsensus(snapshot);
    updateThoughtGraph(snapshot);
    updateTimeline(snapshot);
  }

  // Register change listeners for the timeline filters once the DOM is ready.
  const timelineFilterIds = [
    "timeline-filter-kind",
    "timeline-filter-level",
    "timeline-filter-source",
    "timeline-filter-job",
    "timeline-filter-child",
  ];
  for (const id of timelineFilterIds) {
    const element = document.getElementById(id);
    if (element && element instanceof HTMLSelectElement) {
      element.addEventListener("change", applyTimelineFilters);
    }
  }

  // Render the initial server-provided snapshot immediately.
  applySnapshot(initialSnapshot);

  if (typeof window === "undefined" || !("EventSource" in window)) {
    updateStatus("Flux SSE non supporté par ce navigateur.", "error");
    return;
  }

  updateStatus("Connexion SSE en cours…", "pending");
  const source = new EventSource("stream");
  source.onopen = () => {
    updateStatus("Flux SSE connecté", "connected");
  };
  source.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      applySnapshot(parsed);
    } catch (error) {
      emitClientLog("error", "dashboard_stream_parse_failure", { payload: event.data, error });
      updateStatus("Flux SSE : parsing JSON invalide.", "error");
    }
  };
  source.onerror = () => {
    updateStatus("Flux SSE déconnecté – reconnexion automatique…", "error");
  };
})();`;
    return script
        .split("\n")
        .map((line) => (line.length > 0 ? `      ${line}` : ""))
        .join("\n");
}
/** Normalises query parameters supplied to `GET /logs`. */
function parseLogTailQuery(params) {
    const streamValue = firstParam(params, "stream");
    if (!streamValue) {
        return { ok: false, message: "stream query parameter is required", issues: ["stream"] };
    }
    const stream = normaliseLogStream(streamValue);
    if (!stream) {
        return {
            ok: false,
            message: "stream must be one of server, run or child",
            issues: ["stream"],
        };
    }
    const bucketIdRaw = firstParam(params, "bucketId", "bucket_id", "id");
    const bucketId = bucketIdRaw && bucketIdRaw.trim().length > 0 ? bucketIdRaw.trim() : null;
    const fromSeqResult = parseOptionalInt(params, 0, "fromSeq", "from_seq");
    if (fromSeqResult.error) {
        return { ok: false, message: fromSeqResult.error, issues: ["fromSeq"] };
    }
    const limitResult = parseOptionalInt(params, 1, "limit");
    if (limitResult.error) {
        return { ok: false, message: limitResult.error, issues: ["limit"] };
    }
    const levelsResult = normaliseLevelFilters(collectQueryStrings(params, "levels", "level"));
    if (levelsResult.error) {
        return { ok: false, message: levelsResult.error, issues: ["levels"] };
    }
    const filtersResult = buildTailFilters(params);
    if (filtersResult.error) {
        return { ok: false, message: filtersResult.error, issues: filtersResult.issues ?? [] };
    }
    return {
        ok: true,
        query: {
            stream,
            bucketId,
            fromSeq: fromSeqResult.value,
            limit: limitResult.value,
            levels: levelsResult.value ?? null,
            filters: filtersResult.filters,
        },
    };
}
/** Serialises {@link LogTailFilters} for JSON responses. */
function serialiseFiltersForResponse(filters) {
    if (!filters) {
        return null;
    }
    const payload = {};
    if (filters.runIds && filters.runIds.length > 0) {
        payload.runIds = [...filters.runIds];
    }
    if (filters.jobIds && filters.jobIds.length > 0) {
        payload.jobIds = [...filters.jobIds];
    }
    if (filters.opIds && filters.opIds.length > 0) {
        payload.opIds = [...filters.opIds];
    }
    if (filters.graphIds && filters.graphIds.length > 0) {
        payload.graphIds = [...filters.graphIds];
    }
    if (filters.nodeIds && filters.nodeIds.length > 0) {
        payload.nodeIds = [...filters.nodeIds];
    }
    if (filters.childIds && filters.childIds.length > 0) {
        payload.childIds = [...filters.childIds];
    }
    if (filters.components && filters.components.length > 0) {
        payload.components = [...filters.components];
    }
    if (filters.stages && filters.stages.length > 0) {
        payload.stages = [...filters.stages];
    }
    if (filters.messageIncludes && filters.messageIncludes.length > 0) {
        payload.messageIncludes = [...filters.messageIncludes];
    }
    if (filters.minElapsedMs !== undefined) {
        payload.minElapsedMs = filters.minElapsedMs;
    }
    if (filters.maxElapsedMs !== undefined) {
        payload.maxElapsedMs = filters.maxElapsedMs;
    }
    if (filters.sinceTs !== undefined) {
        payload.sinceTs = filters.sinceTs;
    }
    if (filters.untilTs !== undefined) {
        payload.untilTs = filters.untilTs;
    }
    return Object.keys(payload).length > 0 ? payload : null;
}
/** Collects multiple query parameter aliases while trimming whitespace. */
function collectQueryStrings(params, ...keys) {
    const collected = [];
    for (const key of keys) {
        for (const raw of params.getAll(key)) {
            for (const segment of raw.split(",")) {
                const trimmed = segment.trim();
                if (trimmed.length > 0) {
                    collected.push(trimmed);
                }
            }
        }
    }
    return collected;
}
/** Returns the first non-empty query parameter among the provided aliases. */
function firstParam(params, ...keys) {
    for (const key of keys) {
        const value = params.get(key);
        if (value && value.trim().length > 0) {
            return value;
        }
    }
    return null;
}
/** Normalises log stream identifiers into the canonical union type. */
function normaliseLogStream(value) {
    switch (value.trim().toLowerCase()) {
        case "server":
            return "server";
        case "run":
            return "run";
        case "child":
            return "child";
        default:
            return null;
    }
}
/** Parses optional integer query parameters enforcing a minimum value. */
function parseOptionalInt(params, minimum, ...keys) {
    const raw = firstParam(params, ...keys);
    if (!raw) {
        return { value: null };
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        return { value: null, error: `${keys[0] ?? "value"} must be an integer` };
    }
    if (parsed < minimum) {
        return { value: null, error: `${keys[0] ?? "value"} must be ≥ ${minimum}` };
    }
    return { value: parsed };
}
/** Normalises severity filters into canonical logger levels. */
function normaliseLevelFilters(values) {
    if (values.length === 0) {
        return { value: null };
    }
    const allowed = new Map([
        ["info", "info"],
        ["information", "info"],
        ["warn", "warn"],
        ["warning", "warn"],
        ["error", "error"],
        ["err", "error"],
        ["debug", "debug"],
    ]);
    const seen = new Set();
    const normalised = [];
    for (const entry of values) {
        const canonical = allowed.get(entry.trim().toLowerCase());
        if (!canonical) {
            return {
                value: null,
                error: `unsupported level "${entry}" (expected info|warn|error|debug)`,
            };
        }
        if (!seen.has(canonical)) {
            seen.add(canonical);
            normalised.push(canonical);
        }
    }
    return { value: normalised };
}
function buildTailFilters(params) {
    const runIds = collectQueryStrings(params, "runId", "run_id", "runIds", "run_ids");
    const jobIds = collectQueryStrings(params, "jobId", "job_id", "jobIds", "job_ids");
    const opIds = collectQueryStrings(params, "opId", "op_id", "opIds", "op_ids");
    const graphIds = collectQueryStrings(params, "graphId", "graph_id", "graphIds", "graph_ids");
    const nodeIds = collectQueryStrings(params, "nodeId", "node_id", "nodeIds", "node_ids");
    const childIds = collectQueryStrings(params, "childId", "child_id", "childIds", "child_ids");
    const components = collectQueryStrings(params, "component", "components");
    const stages = collectQueryStrings(params, "stage", "stages");
    const messageIncludes = collectQueryStrings(params, "messageIncludes", "message", "contains");
    const minElapsed = parseOptionalInt(params, 0, "minElapsedMs", "min_elapsed_ms");
    if (minElapsed.error) {
        return { filters: null, error: minElapsed.error, issues: ["minElapsedMs"] };
    }
    const maxElapsed = parseOptionalInt(params, 0, "maxElapsedMs", "max_elapsed_ms");
    if (maxElapsed.error) {
        return { filters: null, error: maxElapsed.error, issues: ["maxElapsedMs"] };
    }
    const sinceTs = parseOptionalInt(params, 0, "sinceTs", "since_ts", "since");
    if (sinceTs.error) {
        return { filters: null, error: sinceTs.error, issues: ["sinceTs"] };
    }
    const untilTs = parseOptionalInt(params, 0, "untilTs", "until_ts", "until");
    if (untilTs.error) {
        return { filters: null, error: untilTs.error, issues: ["untilTs"] };
    }
    const filters = {};
    let hasFilters = false;
    if (runIds.length > 0) {
        filters.runIds = [...runIds];
        hasFilters = true;
    }
    if (jobIds.length > 0) {
        filters.jobIds = [...jobIds];
        hasFilters = true;
    }
    if (opIds.length > 0) {
        filters.opIds = [...opIds];
        hasFilters = true;
    }
    if (graphIds.length > 0) {
        filters.graphIds = [...graphIds];
        hasFilters = true;
    }
    if (nodeIds.length > 0) {
        filters.nodeIds = [...nodeIds];
        hasFilters = true;
    }
    if (childIds.length > 0) {
        filters.childIds = [...childIds];
        hasFilters = true;
    }
    if (components.length > 0) {
        filters.components = [...components];
        hasFilters = true;
    }
    if (stages.length > 0) {
        filters.stages = [...stages];
        hasFilters = true;
    }
    if (messageIncludes.length > 0) {
        filters.messageIncludes = [...messageIncludes];
        hasFilters = true;
    }
    if (minElapsed.value !== null) {
        filters.minElapsedMs = minElapsed.value;
        hasFilters = true;
    }
    if (maxElapsed.value !== null) {
        filters.maxElapsedMs = maxElapsed.value;
        hasFilters = true;
    }
    if (sinceTs.value !== null) {
        filters.sinceTs = sinceTs.value;
        hasFilters = true;
    }
    if (untilTs.value !== null) {
        filters.untilTs = untilTs.value;
        hasFilters = true;
    }
    return { filters: hasFilters ? Object.freeze({ ...filters }) : null };
}
function serialiseSnapshotForInlineScript(snapshot) {
    return JSON.stringify(snapshot)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}
//# sourceMappingURL=dashboard.js.map