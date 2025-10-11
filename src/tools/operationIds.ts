import { randomUUID } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Determine the operation identifier to correlate a tool invocation.
 *
 * The orchestrator exposes a wide catalogue of MCP tools and the checklist
 * requires every handler to surface a stable `op_id` so downstream clients can
 * cancel, resume or audit operations without relying on positional context.
 *
 * @param provided Optional identifier supplied by the caller. When defined and
 *   non-empty it is returned verbatim so idempotent replays keep the same
 *   correlation handle.
 * @param prefix Human readable prefix applied when the caller omits an
 *   identifier. Coupling the prefix with a UUID keeps the value unique while
 *   hinting at the originating surface in logs and traces.
 */
export function resolveOperationId(provided: unknown, prefix: string): string {
  const trimmed = typeof provided === "string" ? provided.trim() : "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  return `${prefix}_${randomUUID()}`;
}
