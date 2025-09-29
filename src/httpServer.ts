import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer as createHttpServer } from "node:http";
import { StructuredLogger } from "./logger.js";
import { HttpRuntimeOptions, createHttpSessionId } from "./serverOptions.js";

export interface HttpServerHandle {
  close: () => Promise<void>;
}

/**
 * Starts the HTTP transport when requested by CLI flags. Errors are logged
 * using the structured logger but not thrown as they would crash the process.
 */
export async function startHttpServer(
  server: McpServer,
  options: HttpRuntimeOptions,
  logger: StructuredLogger
): Promise<HttpServerHandle> {
  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: options.stateless ? undefined : () => createHttpSessionId(),
    enableJsonResponse: options.enableJson
  });

  httpTransport.onerror = (error) => {
    logger.error("http_transport_error", {
      message: error instanceof Error ? error.message : String(error)
    });
  };

  httpTransport.onclose = () => {
    logger.warn("http_transport_closed");
  };

  await server.connect(httpTransport);

  const httpServer = createHttpServer(async (req, res) => {
    const requestUrl = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`) : null;

    if (!requestUrl || requestUrl.pathname !== options.path) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }

    try {
      await httpTransport.handleRequest(req, res);
    } catch (error) {
      logger.error("http_request_failure", {
        message: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        res
          .writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "INTERNAL_ERROR" }));
      } else {
        res.end();
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
        port: options.port,
        path: options.path,
        json: options.enableJson,
        stateless: options.stateless
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
    }
  };
}
