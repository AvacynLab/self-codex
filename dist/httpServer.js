import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import { handleJsonRpc, maybeRecordIdempotentWalEntry } from "./server.js";
import { createHttpSessionId } from "./serverOptions.js";
import { applySecurityHeaders, ensureRequestId } from "./http/headers.js";
import { parseRateLimitEnvBoolean, parseRateLimitEnvNumber, rateLimitOk, } from "./http/rateLimit.js";
import { readJsonBody } from "./http/body.js";
import { checkToken, resolveHttpAuthToken } from "./http/auth.js";
import { buildIdempotencyCacheKey } from "./infra/idempotency.js";
import { IdempotencyConflictError } from "./infra/idempotencyStore.js";
import { readBool } from "./config/env.js";
import { runWithRpcTrace, annotateTraceContext, registerOutboundBytes, registerIdempotencyConflict, getActiveTraceContext, renderMetricsSnapshot, } from "./infra/tracing.js";
import { createJsonRpcError, toJsonRpc, } from "./rpc/errors.js";
/** Maximum payload size accepted by the lightweight JSON handler (1 MiB). */
const MAX_JSON_RPC_BYTES = 1 * 1024 * 1024;
/** Event-loop delay budget considered healthy by the `/healthz` probe. */
const HEALTH_EVENT_LOOP_DELAY_BUDGET_MS = 100;
/** Default steady-state refill rate (requests per second) for the HTTP limiter. */
const DEFAULT_RATE_LIMIT_RPS = 10;
/** Default burst capacity tolerated by the HTTP limiter before throttling. */
const DEFAULT_RATE_LIMIT_BURST = 20;
/** Default limiter configuration used when no environment overrides are supplied. */
const DEFAULT_RATE_LIMIT_CONFIG = {
    disabled: false,
    rps: DEFAULT_RATE_LIMIT_RPS,
    burst: DEFAULT_RATE_LIMIT_BURST,
};
/** Global limiter configuration shared across all HTTP server instances. */
let rateLimiterConfig = DEFAULT_RATE_LIMIT_CONFIG;
/**
 * Parses the user supplied `number` ensuring NaN/Infinity fall back to the
 * provided default. Returning the fallback keeps the rest of the code simple
 * and documents how invalid overrides are handled.
 */
function coerceFiniteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** Reads a rate-limit tuning parameter from `process.env`, tolerating garbage values. */
function parseEnvRateLimitSetting(name) {
    return parseRateLimitEnvNumber(name);
}
/**
 * Applies the supplied overrides on top of the existing limiter configuration.
 * Returning the updated object makes the helper convenient to use in tests.
 */
function configureRateLimiter(overrides) {
    const nextRps = coerceFiniteNumber(overrides.rps, rateLimiterConfig.rps);
    const nextBurst = coerceFiniteNumber(overrides.burst, rateLimiterConfig.burst);
    const explicitDisable = typeof overrides.disabled === "boolean" ? overrides.disabled : rateLimiterConfig.disabled;
    const shouldDisable = explicitDisable || nextRps <= 0 || nextBurst <= 0;
    rateLimiterConfig = {
        disabled: shouldDisable,
        rps: nextRps,
        burst: nextBurst,
    };
    return rateLimiterConfig;
}
/** Refreshes the limiter configuration from environment variables. */
function refreshRateLimiterFromEnv() {
    const envDisabledFlag = parseRateLimitEnvBoolean("MCP_HTTP_RATE_LIMIT_DISABLE");
    const envRps = parseEnvRateLimitSetting("MCP_HTTP_RATE_LIMIT_RPS");
    const envBurst = parseEnvRateLimitSetting("MCP_HTTP_RATE_LIMIT_BURST");
    return configureRateLimiter({
        disabled: envDisabledFlag,
        rps: coerceFiniteNumber(envRps, DEFAULT_RATE_LIMIT_CONFIG.rps),
        burst: coerceFiniteNumber(envBurst, DEFAULT_RATE_LIMIT_CONFIG.burst),
    });
}
// Initialise the limiter from the current environment as soon as the module loads.
refreshRateLimiterFromEnv();
/** Tracks whether the unauthenticated override warning has already been logged. */
let noAuthBypassLogged = false;
/**
 * Starts the HTTP transport when requested by CLI flags. Errors are logged
 * using the structured logger but not thrown as they would crash the process.
 */
export async function startHttpServer(server, options, logger, extras = {}) {
    const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: options.stateless ? undefined : () => createHttpSessionId(),
        enableJsonResponse: options.enableJson,
    });
    httpTransport.onerror = (error) => {
        logger.error("http_transport_error", {
            message: error instanceof Error ? error.message : String(error),
        });
    };
    httpTransport.onclose = () => {
        logger.warn("http_transport_closed");
    };
    await server.connect(httpTransport);
    const accessLogStore = extras.eventStore;
    const httpServer = createHttpServer(async (req, res) => {
        const request = req;
        const response = res;
        applySecurityHeaders(response);
        const requestStartedAt = process.hrtime.bigint();
        const requestUrl = request.url ? new URL(request.url, `http://${request.headers.host ?? "localhost"}`) : null;
        const requestId = ensureRequestId(request, response);
        const remoteAddress = request.socket?.remoteAddress ?? "unknown";
        const route = requestUrl?.pathname ?? request.url ?? "/";
        const method = request.method ?? "UNKNOWN";
        const guardMeta = { startedAt: requestStartedAt };
        let accessLogged = false;
        const logAccess = (statusOverride) => {
            if (accessLogged) {
                return;
            }
            accessLogged = true;
            const status = typeof statusOverride === "number" ? statusOverride : response.statusCode ?? 0;
            const completedAt = process.hrtime.bigint();
            publishHttpAccessEvent(logger, accessLogStore, remoteAddress, route, method, status, requestStartedAt, completedAt);
        };
        response.once("finish", () => logAccess());
        response.once("close", () => logAccess(response.statusCode ?? 0));
        if (!requestUrl) {
            await respondWithJsonRpcError(response, 400, "VALIDATION_ERROR", "Invalid Request", logger, requestId, guardMeta, {
                code: -32600,
            });
            return;
        }
        if (requestUrl.pathname === "/healthz") {
            await handleHealthCheck(request, response, logger, requestId);
            return;
        }
        if (requestUrl.pathname === "/readyz") {
            await handleReadyCheck(request, response, logger, requestId, extras.readiness);
            return;
        }
        if (requestUrl.pathname === "/metrics") {
            // Authentication must run before throttling so operators receive a 401 when the
            // bearer token is missing, even if the rate-limit bucket is already empty.
            if (!enforceBearerToken(request, response, logger, requestId, guardMeta)) {
                return;
            }
            if (!enforceRateLimit(`${remoteAddress}:${requestUrl.pathname}`, response, logger, requestId, guardMeta)) {
                return;
            }
            const body = renderMetricsSnapshot();
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end(body, "utf8");
            const durationMs = computeDurationMs(requestStartedAt);
            const bytesOut = Buffer.byteLength(body, "utf8");
            registerOutboundBytes(bytesOut);
            logger.info("http_metrics_served", {
                request_id: requestId,
                trace_id: getActiveTraceContext()?.traceId ?? null,
                bytes_out: bytesOut,
                duration_ms: durationMs,
            });
            return;
        }
        if (requestUrl.pathname !== options.path) {
            await respondWithJsonRpcError(response, 404, "VALIDATION_ERROR", "Method not found", logger, requestId, guardMeta, {
                code: -32601,
            });
            return;
        }
        const clientKey = `${remoteAddress}:${requestUrl.pathname}`;
        // Enforce the documented guard ordering: authentication → rate limiting → body size →
        // JSON-RPC validation. Keeping the sequence explicit helps regression tests catch
        // accidental reordering when the handler is refactored in the future.
        if (!enforceBearerToken(request, response, logger, requestId, guardMeta)) {
            return;
        }
        if (!enforceRateLimit(clientKey, response, logger, requestId, guardMeta)) {
            return;
        }
        if (await tryHandleJsonRpc(request, response, logger, requestId, undefined, extras.idempotency)) {
            return;
        }
        try {
            await httpTransport.handleRequest(request, response);
        }
        catch (error) {
            logger.error("http_request_failure", {
                message: error instanceof Error ? error.message : String(error),
                request_id: requestId,
            });
            if (!response.headersSent) {
                await respondWithJsonRpcError(response, 500, "INTERNAL", "Internal error", logger, requestId, {
                    ...guardMeta,
                    method: "transport",
                });
            }
            else {
                response.end();
            }
        }
    });
    httpServer.on("error", (error) => {
        logger.error("http_server_error", { message: error instanceof Error ? error.message : String(error) });
    });
    httpServer.on("clientError", (error, socket) => {
        logger.warn("http_client_error", { message: error instanceof Error ? error.message : String(error) });
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    await new Promise((resolve) => {
        httpServer.listen(options.port, options.host, () => {
            logger.info("http_listening", {
                host: options.host,
                port: extractListeningPort(httpServer),
                requested_port: options.port,
                path: options.path,
                json: options.enableJson,
                stateless: options.stateless,
            });
            resolve();
        });
    });
    return {
        close: async () => {
            await new Promise((resolve, reject) => {
                httpServer.close((error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
            });
        },
        port: extractListeningPort(httpServer),
    };
}
/**
 * Handles `/healthz` by measuring event loop responsiveness while surfacing GC
 * availability for operators. The probe now treats the absence of an exposed
 * GC hook (common in production builds without `--expose-gc`) as informative
 * metadata rather than a failure condition so health checks succeed on
 * distroless images.
 */
async function handleHealthCheck(req, res, logger, requestId) {
    const key = `${req.socket.remoteAddress ?? "unknown"}:/healthz`;
    if (!enforceRateLimit(key, res, logger, requestId)) {
        return;
    }
    const before = Date.now();
    await new Promise((resolve) => setImmediate(resolve));
    const delayMs = Date.now() - before;
    const gcAvailable = typeof globalThis.gc === "function";
    const healthy = delayMs <= HEALTH_EVENT_LOOP_DELAY_BUDGET_MS;
    const payload = {
        ok: healthy,
        event_loop_delay_ms: delayMs,
        gc_available: gcAvailable,
    };
    res.statusCode = healthy ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload), "utf8");
    logger.info("http_healthz", {
        request_id: requestId,
        delay_ms: delayMs,
        gc_available: gcAvailable,
        status: res.statusCode,
    });
}
/** Handles `/readyz` by delegating to the orchestrator-provided readiness hook. */
async function handleReadyCheck(req, res, logger, requestId, readiness) {
    const key = `${req.socket.remoteAddress ?? "unknown"}:/readyz`;
    // `/readyz` should authenticate callers before touching shared limiter state so that
    // invalid tokens yield a deterministic 401 regardless of bucket usage.
    if (!enforceBearerToken(req, res, logger, requestId)) {
        return;
    }
    if (!enforceRateLimit(key, res, logger, requestId)) {
        return;
    }
    if (!readiness) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Readiness probe unavailable" }), "utf8");
        logger.warn("http_readyz_missing_probe", { request_id: requestId });
        return;
    }
    try {
        const report = await readiness.check();
        res.statusCode = report.ok ? 200 : 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(report), "utf8");
        logger.info("http_readyz", {
            request_id: requestId,
            status: res.statusCode,
            components: report.components,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: message }), "utf8");
        logger.error("http_readyz_failed", { request_id: requestId, message });
    }
}
/**
 * Ensures the bearer token advertised via {@link process.env.MCP_HTTP_TOKEN}
 * is present on incoming HTTP requests. A `401` JSON-RPC error response is
 * returned when the header is missing or does not match.
 */
function shouldAllowUnauthenticatedRequests() {
    return readBool("MCP_HTTP_ALLOW_NOAUTH", false);
}
function enforceBearerToken(req, res, logger, requestId, meta = {}) {
    const allowNoAuth = shouldAllowUnauthenticatedRequests();
    const configuredTokenRaw = process.env.MCP_HTTP_TOKEN;
    const requiredToken = typeof configuredTokenRaw === "string" ? configuredTokenRaw.trim() : "";
    const token = resolveHttpAuthToken(req.headers);
    const hasValidToken = requiredToken.length > 0 && typeof token === "string" && checkToken(token, requiredToken);
    if (hasValidToken) {
        return true;
    }
    if (allowNoAuth) {
        if (!noAuthBypassLogged) {
            logger.warn("http_auth_bypassed", { reason: "allow_noauth", request_id: requestId });
            noAuthBypassLogged = true;
        }
        return true;
    }
    const rejectionReason = requiredToken.length === 0 ? "token_not_configured" : "missing_or_invalid_token";
    logger.warn("http_auth_rejected", { reason: rejectionReason, request_id: requestId });
    void respondWithJsonRpcError(res, 401, "AUTH_REQUIRED", "Authentication required", logger, requestId, meta, {
        // Keep the legacy E-MCP-AUTH marker in metadata so downstream scrapers and
        // assertions that rely on the historical flag remain compatible while the
        // client-facing response stays intentionally vague.
        meta: { code: "E-MCP-AUTH" },
    });
    return false;
}
/**
 * Applies the in-memory rate limiter before consuming the request body. A
 * structured JSON error is returned to help clients identify throttling.
 */
function enforceRateLimit(key, res, logger, requestId, meta = {}) {
    const config = rateLimiterConfig;
    if (config.disabled || rateLimitOk(key, config.rps, config.burst)) {
        return true;
    }
    logger.warn("http_rate_limited", { key, request_id: requestId });
    void respondWithJsonRpcError(res, 429, "RATE_LIMITED", "Rate limit exceeded", logger, requestId, meta, {
        hint: "Rate limit exceeded",
    });
    return false;
}
/**
 * Attempts to service JSON-RPC POST requests directly via the in-process
 * adapter. The fast-path keeps Codex compatible with stateless HTTP clients
 * while still allowing the official Streamable transport to handle SSE.
 */
async function tryHandleJsonRpc(req, res, logger, requestIdOrDelegate, delegateParam, idempotency) {
    const startedAt = process.hrtime.bigint();
    let requestId;
    let delegate = handleJsonRpc;
    if (typeof requestIdOrDelegate === "function") {
        delegate = requestIdOrDelegate;
    }
    else {
        requestId = requestIdOrDelegate;
        if (delegateParam) {
            delegate = delegateParam;
        }
    }
    if (req.method !== "POST" || !req.headers["content-type"]?.includes("application/json")) {
        return false;
    }
    if (!req.headers.accept || !req.headers.accept.includes("application/json")) {
        return false;
    }
    let parsed;
    let requestBytes = 0;
    let methodName = "unknown";
    let jsonrpcId = null;
    try {
        const body = await readJsonBody(req, MAX_JSON_RPC_BYTES);
        parsed = body.parsed;
        requestBytes = body.bytes;
        jsonrpcId = typeof parsed?.id === "string" || typeof parsed?.id === "number" ? parsed.id : null;
        methodName = typeof parsed?.method === "string" ? parsed.method : "unknown";
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = typeof error?.status === "number" ? error.status : 400;
        logger.warn(status === 413 ? "http_body_read_failed" : "http_json_invalid", {
            message,
            request_id: requestId,
        });
        const errorDetails = status === 413
            ? createJsonRpcError("VALIDATION_ERROR", "Payload Too Large", { code: -32600, requestId: jsonrpcId })
            : createJsonRpcError("VALIDATION_ERROR", "Parse error", { code: -32700, requestId: jsonrpcId });
        const payload = toJsonRpc(null, errorDetails);
        const bytesOut = await sendJson(res, status, payload, false, logger, requestId, undefined, idempotency);
        logJsonRpcOutcome(logger, "warn", {
            httpRequestId: requestId,
            startedAt,
            bytesIn: requestBytes,
            bytesOut,
            method: methodName,
            jsonrpcId,
            status,
            cacheStatus: "bypass",
            errorCode: typeof payload.error?.code === "number" ? payload.error.code : undefined,
        });
        return true;
    }
    const context = {
        ...buildRouteContextFromHeaders(req, parsed),
        payloadSizeBytes: requestBytes,
    };
    const idempotencyKey = context.idempotencyKey;
    let cacheKey = null;
    if (idempotency && idempotencyKey && typeof parsed?.method === "string") {
        cacheKey = buildIdempotencyCacheKey(parsed.method, idempotencyKey, parsed.params);
        try {
            await Promise.resolve(idempotency.store.assertKeySemantics?.(cacheKey));
        }
        catch (assertionError) {
            if (assertionError instanceof IdempotencyConflictError || assertionError?.status === 409) {
                const conflict = createJsonRpcError("IDEMPOTENCY_CONFLICT", "Idempotency conflict", {
                    requestId: jsonrpcId,
                    hint: "Idempotency key was reused with different parameters.",
                });
                registerIdempotencyConflict();
                const payload = toJsonRpc(jsonrpcId, conflict);
                const bytesOut = await sendJson(res, 409, payload, false, logger, requestId, undefined, idempotency);
                logJsonRpcOutcome(logger, "warn", {
                    httpRequestId: requestId,
                    startedAt,
                    bytesIn: requestBytes,
                    bytesOut,
                    method: methodName,
                    jsonrpcId,
                    status: 409,
                    cacheStatus: "conflict",
                    errorCode: conflict.code,
                });
                return true;
            }
            const message = assertionError instanceof Error ? assertionError.message : String(assertionError);
            logger.warn("http_idempotency_assert_failed", { request_id: requestId, cache_key: cacheKey, message });
            cacheKey = null;
        }
        if (cacheKey) {
            try {
                const replay = await idempotency.store.get(cacheKey);
                if (replay) {
                    logger.info("http_idempotency_replayed", {
                        request_id: requestId,
                        cache_key: cacheKey,
                        status: replay.status,
                    });
                    res.statusCode = replay.status;
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("x-idempotency-cache", "hit");
                    res.end(replay.body, "utf8");
                    const bytesOut = Buffer.byteLength(replay.body, "utf8");
                    registerOutboundBytes(bytesOut);
                    logJsonRpcOutcome(logger, "info", {
                        httpRequestId: requestId,
                        startedAt,
                        bytesIn: requestBytes,
                        bytesOut,
                        method: methodName,
                        jsonrpcId,
                        status: replay.status,
                        cacheStatus: "hit",
                    });
                    return true;
                }
            }
            catch (lookupError) {
                const message = lookupError instanceof Error ? lookupError.message : String(lookupError);
                logger.warn("http_idempotency_lookup_failed", { request_id: requestId, cache_key: cacheKey, message });
            }
        }
    }
    const transport = context.transport ?? "http";
    const requestIdentifier = jsonrpcId;
    await runWithRpcTrace({
        method: methodName,
        requestId: requestIdentifier,
        childId: context.childId ?? null,
        transport,
        bytesIn: requestBytes,
    }, async () => {
        annotateTraceContext({
            method: methodName,
            requestId: requestIdentifier,
            childId: context.childId ?? null,
            transport,
        });
        try {
            await maybeRecordIdempotentWalEntry(parsed, context, { method: methodName });
            const response = await delegate(parsed, context);
            const bytesOut = await sendJson(res, 200, response, cacheKey !== null, logger, requestId, cacheKey ?? undefined, idempotency);
            logJsonRpcOutcome(logger, "info", {
                httpRequestId: requestId,
                startedAt,
                bytesIn: requestBytes,
                bytesOut,
                method: methodName,
                jsonrpcId,
                status: 200,
                cacheStatus: cacheKey ? "miss" : "bypass",
            });
        }
        catch (error) {
            logger.error("http_jsonrpc_failure", {
                message: error instanceof Error ? error.message : String(error),
                request_id: requestId,
            });
            const failure = toJsonRpc(parsed?.id ?? null, createJsonRpcError("INTERNAL", "Internal error", { requestId: jsonrpcId }));
            const bytesOut = await sendJson(res, 500, failure, cacheKey !== null, logger, requestId, cacheKey ?? undefined, idempotency);
            logJsonRpcOutcome(logger, "error", {
                httpRequestId: requestId,
                startedAt,
                bytesIn: requestBytes,
                bytesOut,
                method: methodName,
                jsonrpcId,
                status: 500,
                cacheStatus: cacheKey ? "miss" : "bypass",
                errorCode: failure.error?.code,
            });
        }
    });
    return true;
}
/**
 * Builds the routing context forwarded to {@link handleJsonRpc} from the HTTP
 * headers set by Codex clients.
 */
function buildRouteContextFromHeaders(req, request) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
            headers[key] = value;
        }
    }
    const childId = typeof headers["x-child-id"] === "string" ? headers["x-child-id"].trim() || undefined : undefined;
    const idempotencyKey = typeof headers["idempotency-key"] === "string" ? headers["idempotency-key"].trim() || undefined : undefined;
    const childLimitsHeader = headers["x-child-limits"];
    let childLimits;
    if (childLimitsHeader) {
        try {
            const decoded = Buffer.from(childLimitsHeader, "base64").toString("utf8");
            const parsed = JSON.parse(decoded);
            if (parsed && typeof parsed === "object") {
                childLimits = parsed;
            }
        }
        catch {
            // Ignore malformed limits to keep the request best-effort.
        }
    }
    return {
        headers,
        transport: "http",
        requestId: request?.id ?? null,
        childId,
        childLimits,
        idempotencyKey,
    };
}
/** Safely retrieves the bound port once the HTTP server is listening. */
function extractListeningPort(server) {
    const address = server.address();
    if (typeof address === "object" && address && typeof address.port === "number") {
        return address.port;
    }
    return 0;
}
/** @internal Expose internal helpers for unit tests without relying on network sockets. */
export const __httpServerInternals = {
    enforceBearerToken,
    enforceRateLimit,
    tryHandleJsonRpc,
    buildRouteContextFromHeaders,
    handleHealthCheck,
    handleReadyCheck,
    configureRateLimiter,
    refreshRateLimiterFromEnv,
    getRateLimiterConfig: () => rateLimiterConfig,
    resetNoAuthBypassWarning: () => {
        noAuthBypassLogged = false;
    },
    publishHttpAccessEvent,
};
async function respondWithJsonRpcError(res, status, category, message, logger, httpRequestId, meta = {}, options = {}) {
    const jsonId = typeof meta.jsonrpcId === "string" || typeof meta.jsonrpcId === "number" ? meta.jsonrpcId : null;
    const enrichedOptions = {
        ...options,
        requestId: jsonId,
        status: options.status ?? status,
    };
    const error = createJsonRpcError(category, message, enrichedOptions);
    const payload = toJsonRpc(jsonId, error);
    const bytesOut = await sendJson(res, status, payload, false, logger, httpRequestId, undefined, undefined);
    logJsonRpcOutcome(logger, status >= 500 ? "error" : "warn", {
        ...meta,
        httpRequestId,
        status,
        bytesOut,
        cacheStatus: "bypass",
        errorCode: error.code,
    });
    return bytesOut;
}
function logJsonRpcOutcome(logger, level, details) {
    const trace = getActiveTraceContext();
    const log = logger[level].bind(logger);
    log("http_jsonrpc_completed", {
        request_id: details.httpRequestId ?? null,
        trace_id: trace?.traceId ?? null,
        jsonrpc_id: details.jsonrpcId ?? null,
        method: details.method ?? "unknown",
        status: details.status,
        duration_ms: computeDurationMs(details.startedAt),
        bytes_in: Math.max(0, details.bytesIn ?? 0),
        bytes_out: Math.max(0, details.bytesOut),
        cache_status: details.cacheStatus ?? null,
        error_code: details.errorCode ?? null,
    });
}
function computeDurationMs(startedAt) {
    if (!startedAt) {
        return 0;
    }
    const elapsed = process.hrtime.bigint() - startedAt;
    return Number(elapsed / 1000000n);
}
async function sendJson(res, status, payload, shouldPersist, logger, requestId, cacheKey, idempotency) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    const trace = getActiveTraceContext();
    if (trace) {
        res.setHeader("x-trace-id", trace.traceId);
    }
    res.end(body, "utf8");
    const bytesOut = Buffer.byteLength(body, "utf8");
    registerOutboundBytes(bytesOut);
    if (!shouldPersist || !idempotency || !cacheKey) {
        return bytesOut;
    }
    try {
        await idempotency.store.set(cacheKey, status, body, idempotency.ttlMs);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("http_idempotency_store_failed", { request_id: requestId, cache_key: cacheKey, message });
    }
    return bytesOut;
}
/**
 * Emits a structured HTTP access log to the main logger while optionally
 * mirroring the same payload into the orchestrator event store. Centralising
 * the logic guarantees that all transports emit consistent metadata for
 * operators and automated diagnostics.
 */
function publishHttpAccessEvent(logger, store, remoteAddress, route, method, status, startedAt, completedAt) {
    const latencyNs = completedAt - startedAt;
    const latencyMs = Number(latencyNs) / 1_000_000;
    const payload = {
        ip: remoteAddress,
        route,
        method,
        status,
        latency_ms: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
    };
    logger.info("http_access", payload);
    if (!store) {
        return;
    }
    store.emit({
        kind: "HTTP_ACCESS",
        source: "system",
        level: "info",
        payload,
    });
}
//# sourceMappingURL=httpServer.js.map