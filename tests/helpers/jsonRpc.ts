import type { JsonRpcRequest } from "../../src/server.js";

/**
 * Coerces arbitrary payloads into {@link JsonRpcRequest} instances for tests
 * that emulate untyped transports. Keeping the helper isolated documents the
 * intent while avoiding `as unknown as` assertions in the suites.
 */
export function coerceToJsonRpcRequest(value: unknown): JsonRpcRequest {
  return value as JsonRpcRequest;
}
