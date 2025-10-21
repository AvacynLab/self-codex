import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpResponseLike } from "../httpServer.js";
import { randomUUID } from "node:crypto";

/**
 * Security headers applied to every HTTP response served by the MCP endpoint.
 * Tests exercise the helper through {@link HttpResponseLike} doubles so the
 * signature accepts either the Node response implementation or the in-memory
 * stub used by the suite.
 */
export function applySecurityHeaders(res: ServerResponse | HttpResponseLike): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Guarantees that the request/response pair carries a stable correlation id.
 * Existing identifiers provided by reverse proxies are preserved to ease log
 * aggregation, otherwise a fresh UUID is minted.
 */
export function ensureRequestId(
  req: IncomingMessage,
  res: ServerResponse | HttpResponseLike,
): string {
  const incoming = req.headers["x-request-id"];
  const requestId = typeof incoming === "string" && incoming.trim() ? incoming.trim() : randomUUID();
  res.setHeader("x-request-id", requestId);
  return requestId;
}
