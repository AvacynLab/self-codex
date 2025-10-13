import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer as createHttpServer, Server as NodeHttpServer } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { StructuredLogger } from "./logger.js";
import { handleJsonRpc, type JsonRpcRequest, type JsonRpcRouteContext } from "./server.js";
import { HttpRuntimeOptions, createHttpSessionId } from "./serverOptions.js";
import { applySecurityHeaders, ensureRequestId } from "./http/headers.js";
import { rateLimitOk } from "./http/rateLimit.js";
import { readJsonBody } from "./http/body.js";
import { tokenOk } from "./http/auth.js";
import { buildIdempotencyCacheKey } from "./infra/idempotency.js";
import type { IdempotencyStore } from "./infra/idempotencyStore.js";
import {
  runWithRpcTrace,
  annotateTraceContext,
  registerInboundBytes,
  registerOutboundBytes,
  getActiveTraceContext,
  renderMetricsSnapshot,
} from "./infra/tracing.js";

type HttpTransportRequest = Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
type HttpTransportResponse = Parameters<StreamableHTTPServerTransport["handleRequest"]>[1];

/** Maximum payload size accepted by the lightweight JSON handler (1 MiB). */
const MAX_JSON_RPC_BYTES = 1 * 1024 * 1024;
/** Event-loop delay budget considered healthy by the `/healthz` probe. */
const HEALTH_EVENT_LOOP_DELAY_BUDGET_MS = 100;
/** Default steady-state refill rate (requests per second) for the HTTP limiter. */
const DEFAULT_RATE_LIMIT_RPS = 10;
/** Default burst capacity tolerated by the HTTP limiter before throttling. */
const DEFAULT_RATE_LIMIT_BURST = 20;

/** Runtime representation of the limiter configuration. */
interface RateLimiterConfig {
  /** When `true`, all requests bypass throttling regardless of token balance. */
  disabled: boolean;
  /** Steady-state refill rate expressed as requests per second. */
  rps: number;
  /** Maximum number of tokens stored in the bucket. */
  burst: number;
}

/** Default limiter configuration used when no environment overrides are supplied. */
const DEFAULT_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  disabled: false,
  rps: DEFAULT_RATE_LIMIT_RPS,
  burst: DEFAULT_RATE_LIMIT_BURST,
};

/** Global limiter configuration shared across all HTTP server instances. */
let rateLimiterConfig: RateLimiterConfig = DEFAULT_RATE_LIMIT_CONFIG;

/**
 * Parses the user supplied `number` ensuring NaN/Infinity fall back to the
 * provided default. Returning the fallback keeps the rest of the code simple
 * and documents how invalid overrides are handled.
 */
function coerceFiniteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Reads a rate-limit tuning parameter from `process.env`, tolerating garbage values. */
function parseEnvRateLimitSetting(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Applies the supplied overrides on top of the existing limiter configuration.
 * Returning the updated object makes the helper convenient to use in tests.
 */
function configureRateLimiter(overrides: Partial<RateLimiterConfig>): RateLimiterConfig {
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
function refreshRateLimiterFromEnv(): RateLimiterConfig {
  const envDisabled = (process.env.MCP_HTTP_RATE_LIMIT_DISABLE ?? "").toLowerCase() === "1";
  const envRps = parseEnvRateLimitSetting("MCP_HTTP_RATE_LIMIT_RPS");
  const envBurst = parseEnvRateLimitSetting("MCP_HTTP_RATE_LIMIT_BURST");

  return configureRateLimiter({
    disabled: envDisabled,
    rps: coerceFiniteNumber(envRps, DEFAULT_RATE_LIMIT_CONFIG.rps),
    burst: coerceFiniteNumber(envBurst, DEFAULT_RATE_LIMIT_CONFIG.burst),
  });
}

// Initialise the limiter from the current environment as soon as the module loads.
refreshRateLimiterFromEnv();

export interface HttpServerHandle {
  close: () => Promise<void>;
  /** Actual port bound by the HTTP server (useful when `0` was requested). */
  port: number;
}

/** Parameters controlling the persistent idempotency layer. */
export interface HttpIdempotencyConfig {
  store: IdempotencyStore;
  ttlMs: number;
}

/** Optional hooks extending the default HTTP server behaviour. */
export interface HttpServerExtras {
  /** Persistent idempotency layer used to replay JSON-RPC responses. */
  idempotency?: HttpIdempotencyConfig;
  /** Optional readiness probe invoked by `/readyz`. */
  readiness?: HttpReadinessExtras;
}

/** Details returned by the readiness probe so operators can diagnose failures. */
export interface HttpReadinessReport {
  ok: boolean;
  components: {
    graphForge: { ok: boolean; message?: string };
    idempotency: { ok: boolean; message?: string };
    eventQueue: { ok: boolean; usage: number; capacity: number };
  };
}

/** Hook implemented by the orchestrator to evaluate readiness conditions. */
export interface HttpReadinessExtras {
  check: () => Promise<HttpReadinessReport>;
}

/**
 * Starts the HTTP transport when requested by CLI flags. Errors are logged
 * using the structured logger but not thrown as they would crash the process.
 */
export async function startHttpServer(
  server: McpServer,
  options: HttpRuntimeOptions,
  logger: StructuredLogger,
  extras: HttpServerExtras = {},
): Promise<HttpServerHandle> {
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

  const httpServer = createHttpServer(async (req, res) => {
    const request = req as HttpTransportRequest;
    const response = res as HttpTransportResponse;
    applySecurityHeaders(response);
    const requestUrl = request.url ? new URL(request.url, `http://${request.headers.host ?? "localhost"}`) : null;
    const requestId = ensureRequestId(request, response);

    if (!requestUrl) {
      response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "BAD_REQUEST" }));
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
      if (!enforceRateLimit(`${request.socket.remoteAddress ?? "unknown"}:${requestUrl.pathname}`, response, logger, requestId)) {
        return;
      }
      if (!enforceBearerToken(request, response, logger, requestId)) {
        return;
      }

      const body = renderMetricsSnapshot();
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(body, "utf8");
      logger.info("http_metrics_served", {
        request_id: requestId,
        bytes_out: Buffer.byteLength(body, "utf8"),
      });
      return;
    }

    if (requestUrl.pathname !== options.path) {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }

    const clientKey = `${request.socket.remoteAddress ?? "unknown"}:${requestUrl.pathname}`;
    if (!enforceRateLimit(clientKey, response, logger, requestId)) {
      return;
    }

    if (!enforceBearerToken(request, response, logger, requestId)) {
      return;
    }

    if (await tryHandleJsonRpc(request, response, logger, requestId, undefined, extras.idempotency)) {
      return;
    }

    try {
      await httpTransport.handleRequest(request, response);
    } catch (error) {
      logger.error("http_request_failure", {
        message: error instanceof Error ? error.message : String(error),
        request_id: requestId,
      });
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "INTERNAL_ERROR" }));
      } else {
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

  await new Promise<void>((resolve) => {
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
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
    port: extractListeningPort(httpServer),
  };
}

/** Handles `/healthz` by measuring event loop responsiveness and GC availability. */
async function handleHealthCheck(
  req: HttpTransportRequest,
  res: HttpTransportResponse,
  logger: StructuredLogger,
  requestId: string,
): Promise<void> {
  const key = `${req.socket.remoteAddress ?? "unknown"}:/healthz`;
  if (!enforceRateLimit(key, res, logger, requestId)) {
    return;
  }

  const before = Date.now();
  await new Promise((resolve) => setImmediate(resolve));
  const delayMs = Date.now() - before;
  const gcAvailable = typeof (globalThis as { gc?: (() => void) | undefined }).gc === "function";
  const healthy = gcAvailable && delayMs <= HEALTH_EVENT_LOOP_DELAY_BUDGET_MS;
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
async function handleReadyCheck(
  req: HttpTransportRequest,
  res: HttpTransportResponse,
  logger: StructuredLogger,
  requestId: string,
  readiness: HttpReadinessExtras | undefined,
): Promise<void> {
  const key = `${req.socket.remoteAddress ?? "unknown"}:/readyz`;
  if (!enforceRateLimit(key, res, logger, requestId)) {
    return;
  }

  if (!enforceBearerToken(req, res, logger, requestId)) {
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
  } catch (error) {
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
function enforceBearerToken(
  req: HttpTransportRequest,
  res: HttpTransportResponse,
  logger: StructuredLogger,
  requestId: string,
): boolean {
  const requiredToken = process.env.MCP_HTTP_TOKEN ?? "";
  if (!requiredToken) {
    return true;
  }

  const header = req.headers["authorization"];
  const provided = Array.isArray(header) ? header[0] : header;
  const token = typeof provided === "string" && provided.startsWith("Bearer ") ? provided.slice(7) : undefined;
  const valid = typeof token === "string" && tokenOk(token, requiredToken);

  if (valid) {
    return true;
  }

  logger.warn("http_auth_rejected", { reason: "missing_or_invalid_token", request_id: requestId });
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 401, message: "E-MCP-AUTH" } }), "utf8");
  return false;
}

/**
 * Applies the in-memory rate limiter before consuming the request body. A
 * structured JSON error is returned to help clients identify throttling.
 */
function enforceRateLimit(
  key: string,
  res: HttpTransportResponse,
  logger: StructuredLogger,
  requestId: string,
): boolean {
  const config = rateLimiterConfig;
  if (config.disabled || rateLimitOk(key, config.rps, config.burst)) {
    return true;
  }

  logger.warn("http_rate_limited", { key, request_id: requestId });
  res.writeHead(429, { "Content-Type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too Many Requests" } }),
    "utf8",
  );
  return false;
}

/**
 * Attempts to service JSON-RPC POST requests directly via the in-process
 * adapter. The fast-path keeps Codex compatible with stateless HTTP clients
 * while still allowing the official Streamable transport to handle SSE.
 */
async function tryHandleJsonRpc(
  req: HttpTransportRequest,
  res: HttpTransportResponse,
  logger: StructuredLogger,
  requestIdOrDelegate?: string | ((request: JsonRpcRequest, context?: JsonRpcRouteContext) => Promise<unknown>),
  delegateParam?: (request: JsonRpcRequest, context?: JsonRpcRouteContext) => Promise<unknown>,
  idempotency?: HttpIdempotencyConfig,
): Promise<boolean> {
  let requestId: string | undefined;
  let delegate: (request: JsonRpcRequest, context?: JsonRpcRouteContext) => Promise<unknown> = handleJsonRpc;

  if (typeof requestIdOrDelegate === "function") {
    delegate = requestIdOrDelegate;
  } else {
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

  let parsed: JsonRpcRequest;
  let requestBytes = 0;
  try {
    const body = await readJsonBody<JsonRpcRequest>(req, MAX_JSON_RPC_BYTES);
    parsed = body.parsed;
    requestBytes = body.bytes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof (error as { status?: number } | undefined)?.status === "number" ? (error as any).status : 400;

    logger.warn(status === 413 ? "http_body_read_failed" : "http_json_invalid", {
      message,
      request_id: requestId,
    });

    const payload =
      status === 413
        ? { jsonrpc: "2.0" as const, id: null, error: { code: -32600, message: "Payload Too Large" } }
        : { jsonrpc: "2.0" as const, id: null, error: { code: -32700, message: "Parse error" } };
    await sendJson(res, status, payload, false, logger, requestId, undefined, idempotency);
    return true;
  }

  const context = {
    ...buildRouteContextFromHeaders(req, parsed),
    payloadSizeBytes: requestBytes,
  };

  const idempotencyKey = context.idempotencyKey;
  let cacheKey: string | null = null;
  if (idempotency && idempotencyKey && typeof parsed?.method === "string") {
    cacheKey = buildIdempotencyCacheKey(parsed.method, idempotencyKey, parsed.params);
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
        return true;
      }
    } catch (lookupError) {
      const message = lookupError instanceof Error ? lookupError.message : String(lookupError);
      logger.warn("http_idempotency_lookup_failed", { request_id: requestId, cache_key: cacheKey, message });
    }
  }

  const transport = context.transport ?? "http";
  const requestIdentifier = typeof parsed?.id === "string" || typeof parsed?.id === "number" ? parsed.id : null;
  const methodName = typeof parsed?.method === "string" ? parsed.method : "unknown";

  await runWithRpcTrace(
    {
      method: methodName,
      requestId: requestIdentifier,
      childId: context.childId ?? null,
      transport,
      bytesIn: 0,
    },
    async () => {
      annotateTraceContext({
        method: methodName,
        requestId: requestIdentifier,
        childId: context.childId ?? null,
        transport,
      });
      registerInboundBytes(requestBytes);

      try {
        const response = await delegate(parsed, context);
        await sendJson(
          res,
          200,
          response,
          cacheKey !== null,
          logger,
          requestId,
          cacheKey ?? undefined,
          idempotency,
        );
      } catch (error) {
        logger.error("http_jsonrpc_failure", {
          message: error instanceof Error ? error.message : String(error),
          request_id: requestId,
        });
        await sendJson(
          res,
          500,
          { jsonrpc: "2.0" as const, id: parsed?.id ?? null, error: { code: -32000, message: "Internal error" } },
          cacheKey !== null,
          logger,
          requestId,
          cacheKey ?? undefined,
          idempotency,
        );
      }
    },
  );
  return true;
}

/**
 * Builds the routing context forwarded to {@link handleJsonRpc} from the HTTP
 * headers set by Codex clients.
 */
function buildRouteContextFromHeaders(req: HttpTransportRequest, request: JsonRpcRequest): JsonRpcRouteContext {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }

  const childId = typeof headers["x-child-id"] === "string" ? headers["x-child-id"].trim() || undefined : undefined;
  const idempotencyKey =
    typeof headers["idempotency-key"] === "string" ? headers["idempotency-key"].trim() || undefined : undefined;
  const childLimitsHeader = headers["x-child-limits"];
  let childLimits: JsonRpcRouteContext["childLimits"];
  if (childLimitsHeader) {
    try {
      const decoded = Buffer.from(childLimitsHeader, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as JsonRpcRouteContext["childLimits"];
      if (parsed && typeof parsed === "object") {
        childLimits = parsed;
      }
    } catch {
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
function extractListeningPort(server: NodeHttpServer): number {
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
};

async function sendJson(
  res: HttpTransportResponse,
  status: number,
  payload: unknown,
  shouldPersist: boolean,
  logger: StructuredLogger,
  requestId: string | undefined,
  cacheKey: string | undefined,
  idempotency?: HttpIdempotencyConfig,
): Promise<void> {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  const trace = getActiveTraceContext();
  if (trace) {
    res.setHeader("x-trace-id", trace.traceId);
  }
  res.end(body, "utf8");
  registerOutboundBytes(Buffer.byteLength(body, "utf8"));

  if (!shouldPersist || !idempotency || !cacheKey) {
    return;
  }

  try {
    await idempotency.store.set(cacheKey, status, body, idempotency.ttlMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("http_idempotency_store_failed", { request_id: requestId, cache_key: cacheKey, message });
  }
}

