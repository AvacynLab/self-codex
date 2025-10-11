import { AsyncLocalStorage } from "node:async_hooks";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import type { JsonRpcRouteContext } from "../server.js";

/**
 * Lightweight AsyncLocalStorage used to expose the JSON-RPC routing context to
 * downstream helpers (tool handlers, supervisors, …). HTTP requests propagate
 * child identifiers and custom headers through this channel so nested
 * invocations can reuse them when spawning additional children.
 */
const storage = new AsyncLocalStorage<JsonRpcRouteContext | undefined>();

/**
 * Executes the provided callback while exposing the supplied JSON-RPC context
 * via AsyncLocalStorage. When no context is provided the callback is executed
 * directly without incurring the storage cost.
 */
export function runWithJsonRpcContext<T>(
  context: JsonRpcRouteContext | undefined,
  callback: () => T,
): T {
  if (!context) {
    return callback();
  }
  return storage.run(context, callback);
}

/** Retrieves the JSON-RPC context associated with the current async execution. */
export function getJsonRpcContext(): JsonRpcRouteContext | undefined {
  return storage.getStore();
}
