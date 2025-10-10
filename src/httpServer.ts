import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer as createHttpServer, Server as NodeHttpServer } from "http";
import { Buffer } from "buffer";
import process from "process";

import { StructuredLogger } from "./logger.js";
import { handleJsonRpc, type JsonRpcRequest, type JsonRpcRouteContext } from "./server.js";
import { HttpRuntimeOptions, createHttpSessionId } from "./serverOptions.js";

type HttpTransportRequest = Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
type HttpTransportResponse = Parameters<StreamableHTTPServerTransport["handleRequest"]>[1];

/** Maximum payload size accepted by the lightweight JSON handler (5 MiB). */
const MAX_JSON_RPC_BYTES = 5 * 1024 * 1024;

export interface HttpServerHandle {
  close: () => Promise<void>;
  /** Actual port bound by the HTTP server (useful when `0` was requested). */
  port: number;
}

/**
 * Starts the HTTP transport when requested by CLI flags. Errors are logged
 * using the structured logger but not thrown as they would crash the process.
 */
export async function startHttpServer(
  server: McpServer,
  options: HttpRuntimeOptions,
  logger: StructuredLogger,
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
    const requestUrl = request.url ? new URL(request.url, `http://${request.headers.host ?? "localhost"}`) : null;

    if (!requestUrl || requestUrl.pathname !== options.path) {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }

    if (!enforceBearerToken(request, response, logger)) {
      return;
    }

    if (await tryHandleJsonRpc(request, response, logger)) {
      return;
    }

    try {
      await httpTransport.handleRequest(request, response);
    } catch (error) {
      logger.error("http_request_failure", {
        message: error instanceof Error ? error.message : String(error),
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

/**
 * Ensures the bearer token advertised via {@link process.env.MCP_HTTP_TOKEN}
 * is present on incoming HTTP requests. A `401` JSON-RPC error response is
 * returned when the header is missing or does not match.
 */
function enforceBearerToken(
  req: HttpTransportRequest,
  res: HttpTransportResponse,
  logger: StructuredLogger,
): boolean {
  const requiredToken = process.env.MCP_HTTP_TOKEN ?? "";
  if (!requiredToken) {
    return true;
  }

  const header = req.headers["authorization"];
  const provided = Array.isArray(header) ? header[0] : header;
  const valid = typeof provided === "string" && provided.startsWith("Bearer ") && provided.slice(7) === requiredToken;

  if (valid) {
    return true;
  }

  logger.warn("http_auth_rejected", { reason: "missing_or_invalid_token" });
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 401, message: "E-MCP-AUTH" } }), "utf8");
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
  delegate: (request: JsonRpcRequest, context?: JsonRpcRouteContext) => Promise<unknown> = handleJsonRpc,
): Promise<boolean> {
  if (req.method !== "POST" || !req.headers["content-type"]?.includes("application/json")) {
    return false;
  }
  if (!req.headers.accept || !req.headers.accept.includes("application/json")) {
    return false;
  }

  let raw: string;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    logger.warn("http_body_read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(413, { "Content-Type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Payload Too Large" } }),
      "utf8",
    );
    return true;
  }

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(raw) as JsonRpcRequest;
  } catch (error) {
    logger.warn("http_json_invalid", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      "utf8",
    );
    return true;
  }

  const context = buildRouteContextFromHeaders(req, parsed);

  try {
    const response = await delegate(parsed, context);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response), "utf8");
  } catch (error) {
    logger.error("http_jsonrpc_failure", {
      message: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(500, { "Content-Type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", id: parsed?.id ?? null, error: { code: -32000, message: "Internal error" } }),
      "utf8",
    );
  }
  return true;
}

/** Reads the raw request body while guarding against over-sized payloads. */
async function readRequestBody(req: HttpTransportRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_RPC_BYTES) {
      throw new Error("JSON-RPC payload exceeds limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  tryHandleJsonRpc,
  buildRouteContextFromHeaders,
  readRequestBody,
};

