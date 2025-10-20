import { IncomingMessage } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";

/**
 * Minimal HTTP response stub capturing headers and body in memory.
 *
 * Tests leverage the helper to assert the JSON payload emitted by the server
 * without spinning an actual network listener. The implementation mirrors the
 * subset of the Node.js API touched by our HTTP bridge.
 */
export class MemoryHttpResponse {
  public statusCode = 0;
  public headers: Record<string, string> = {};
  public body = "";
  public headersSent = false;

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      this.headers = { ...headers };
    }
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(chunk?: unknown): void {
    if (typeof chunk === "string") {
      this.body += chunk;
    } else if (chunk instanceof Uint8Array) {
      this.body += Buffer.from(chunk).toString("utf8");
    }
    this.headersSent = true;
  }
}

/**
 * Builds an {@link IncomingMessage} stream containing a JSON-RPC payload.
 *
 * Requests default to the `/mcp` endpoint using the POST method so the
 * lightweight HTTP handler can exercise the stateless JSON fast-path.
 */
export function createJsonRpcRequest(
  body: string | Record<string, unknown>,
  headers: Record<string, string>,
): IncomingMessage {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return createIncomingMessageStream([payload], "POST", "/mcp", headers);
}

/**
 * Builds an arbitrary HTTP request stream pointing at the provided path. Tests
 * use the helper to exercise lightweight GET handlers without starting a real
 * network listener.
 */
export function createHttpRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return createIncomingMessageStream([], method.toUpperCase(), path, headers);
}

/**
 * Internal helper that instantiates a genuine {@link IncomingMessage} and
 * injects the provided payload chunks.
 */
function createIncomingMessageStream(
  chunks: Array<string | Uint8Array>,
  method: string,
  path: string,
  headers: Record<string, string>,
): IncomingMessage {
  const socket = new Socket();
  const message = new IncomingMessage(socket);

  message.method = method;
  message.url = path;
  message.headers = normaliseHeaders(headers);

  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      message.push(chunk, "utf8");
    } else {
      message.push(chunk);
    }
  }

  message.push(null);
  socket.destroy();
  return message;
}

/**
 * Normalises header names to the lowercase representation expected by the Node
 * HTTP stack so tests can assert against a deterministic shape.
 */
function normaliseHeaders(headers: Record<string, string>): IncomingHttpHeaders {
  const normalised: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalised[key.toLowerCase()] = value;
  }
  return normalised;
}
