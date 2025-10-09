import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

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
  const stream = Readable.from([payload]) as unknown as IncomingMessage;
  stream.method = "POST";
  stream.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  stream.url = "/mcp";
  return stream;
}
