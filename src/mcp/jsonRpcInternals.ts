import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Règle hygiène : documenter les doubles assertions TS sans mentionner textuellement le motif (unknown→T).

/**
 * Signature implemented by the MCP SDK for registered JSON-RPC request handlers.
 *
 * The orchestrator relies on this shape when wiring internal middleware without
 * exposing the handlers publicly. Keeping the definition centralised allows the
 * rest of the codebase to avoid hand-written structural casts.
 */
export type InternalJsonRpcHandler = (
  request: { jsonrpc: "2.0"; id: string | number | null; method: string; params?: unknown },
  extra: {
    signal: AbortSignal;
    sessionId?: string;
    sendNotification: (notification: unknown) => Promise<void>;
    sendRequest: (req: unknown, schema?: unknown, options?: unknown) => Promise<unknown>;
    authInfo?: unknown;
    requestId: string | number | null;
    requestInfo?: { headers?: Record<string, string> };
  },
) => Promise<unknown> | unknown;

/**
 * Determines whether the provided value is a plain object record. The helper is
 * intentionally strict so we do not treat primitives, arrays or functions as
 * legitimate registry hosts.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Runtime type guard validating the structure of the internal handler registry.
 *
 * Besides checking the `Map` instance we also inspect a sample of entries to
 * guarantee keys are strings and handlers are functions. This lets TypeScript
 * narrow the value without relying on the double assertion motif (unknown→T).
 */
function isInternalJsonRpcHandlerMap(value: unknown): value is Map<string, InternalJsonRpcHandler> {
  if (!(value instanceof Map)) {
    return false;
  }

  for (const [key, handler] of value.entries()) {
    if (typeof key !== "string" || typeof handler !== "function") {
      return false;
    }
  }

  return true;
}

/**
 * Retrieves the mutable JSON-RPC handler registry maintained by the MCP server.
 *
 * The SDK stores the registry on a private field, therefore we reach it via
 * `Reflect.get` while performing runtime validations. Centralising the logic in
 * this module keeps the rest of the codebase free from manual casts.
 */
export function getMutableJsonRpcRequestHandlerRegistry(
  server: McpServer,
): Map<string, InternalJsonRpcHandler> {
  const registryHost = Reflect.get(server, "server");
  if (!isPlainRecord(registryHost)) {
    throw new Error("JSON-RPC request handler registry unavailable");
  }

  const handlers = Reflect.get(registryHost, "_requestHandlers");
  if (!isInternalJsonRpcHandlerMap(handlers)) {
    throw new Error("JSON-RPC request handler registry unavailable");
  }

  return handlers;
}
