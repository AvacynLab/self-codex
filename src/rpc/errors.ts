import { getActiveTraceContext } from "../infra/tracing.js";
import type { JsonRpcResponse } from "../orchestrator/runtime.js";

/**
 * Canonical taxonomy describing the JSON-RPC error categories recognised by the
 * orchestrator. Each entry provides the JSON-RPC error code and the default
 * human-readable message wired to that category.
 */
export const JSON_RPC_ERROR_TAXONOMY = {
  VALIDATION_ERROR: { code: -32602, message: "Invalid params" },
  AUTH_REQUIRED: { code: -32001, message: "Authentication required" },
  RATE_LIMITED: { code: -32002, message: "Rate limit exceeded" },
  IDEMPOTENCY_CONFLICT: { code: -32080, message: "Idempotency conflict" },
  BUDGET_EXCEEDED: { code: -32004, message: "Budget exhausted" },
  TIMEOUT: { code: -32003, message: "Request timeout" },
  INTERNAL: { code: -32000, message: "Internal error" },
} as const;

/** Union type describing the supported JSON-RPC error categories. */
export type JsonRpcErrorCategory = keyof typeof JSON_RPC_ERROR_TAXONOMY;

/**
 * Additional metadata propagated alongside JSON-RPC error responses. The
 * payload mirrors the historic format used across the project so existing
 * telemetry, tests and tooling continue to operate unchanged.
 */
export interface JsonRpcErrorData {
  category: JsonRpcErrorCategory;
  request_id?: string | number | null;
  trace_id?: string | null;
  hint?: string;
  issues?: unknown;
  meta?: Record<string, unknown>;
  status?: number;
}

/**
 * Optional knobs allowing callers to enrich {@link JsonRpcErrorData}. The
 * `code` property lets transports override the JSON-RPC code when a category
 * re-uses multiple protocol codes (e.g. parse vs invalid request).
 */
export interface JsonRpcErrorOptions {
  code?: number;
  requestId?: string | number | null;
  hint?: string;
  issues?: unknown;
  meta?: Record<string, unknown>;
  status?: number;
}

/**
 * Returns the telemetry-friendly data payload included with JSON-RPC error
 * responses. The helper injects trace identifiers from the active span to ease
 * correlation in distributed traces while keeping the function free of
 * side-effects.
 */
function createJsonRpcErrorData(
  category: JsonRpcErrorCategory,
  options: JsonRpcErrorOptions,
): JsonRpcErrorData {
  const snapshot: JsonRpcErrorData = { category };
  if (options.requestId !== undefined) {
    snapshot.request_id = options.requestId;
  }
  const traceId = getActiveTraceContext()?.traceId ?? null;
  if (traceId) {
    snapshot.trace_id = traceId;
  }
  if (options.hint !== undefined) {
    snapshot.hint = options.hint;
  }
  if (options.issues !== undefined) {
    snapshot.issues = options.issues;
  }
  if (options.meta !== undefined) {
    snapshot.meta = options.meta;
  }
  if (options.status !== undefined) {
    snapshot.status = options.status;
  }
  return snapshot;
}

/**
 * Base class for all typed JSON-RPC errors thrown by the orchestrator. Concrete
 * subclasses simply fix the error category while preserving the ergonomic
 * options bag to attach hints and metadata.
 */
export class JsonRpcError extends Error {
  readonly category: JsonRpcErrorCategory;
  readonly code: number;
  readonly data: JsonRpcErrorData;

  constructor(category: JsonRpcErrorCategory, message?: string, options: JsonRpcErrorOptions = {}) {
    const taxonomy = JSON_RPC_ERROR_TAXONOMY[category];
    const resolvedMessage = message ?? taxonomy.message;
    const resolvedCode = options.code ?? taxonomy.code;
    super(resolvedMessage);
    this.category = category;
    this.code = resolvedCode;
    this.data = createJsonRpcErrorData(category, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Typed error surface dedicated to payload validation failures. */
export class ValidationError extends JsonRpcError {
  constructor(message?: string, options: JsonRpcErrorOptions = {}) {
    super("VALIDATION_ERROR", message, options);
  }
}

/**
 * Error thrown when the caller fails authentication. Timing safe comparisons
 * live outside of this class; the class strictly captures the failure outcome.
 */
export class AuthError extends JsonRpcError {
  constructor(message?: string, options: JsonRpcErrorOptions = {}) {
    super("AUTH_REQUIRED", message, options);
  }
}

/** Error raised whenever a request takes longer than the allotted budget. */
export class TimeoutError extends JsonRpcError {
  constructor(message?: string, options: JsonRpcErrorOptions = {}) {
    super("TIMEOUT", message, options);
  }
}

/** Error signalling an idempotency key collision. */
export class IdempotencyConflict extends JsonRpcError {
  constructor(message?: string, options: JsonRpcErrorOptions = {}) {
    super("IDEMPOTENCY_CONFLICT", message, options);
  }
}

/** Catch-all internal failure propagated to clients. */
export class InternalError extends JsonRpcError {
  constructor(message?: string, options: JsonRpcErrorOptions = {}) {
    super("INTERNAL", message, options);
  }
}

/**
 * Convenience helper preserving the previous `createJsonRpcError` API. The
 * function instantiates the appropriate typed error class based on the
 * requested category to ease incremental adoption across the code base.
 */
export function createJsonRpcError(
  category: JsonRpcErrorCategory,
  message?: string,
  options: JsonRpcErrorOptions = {},
): JsonRpcError {
  switch (category) {
    case "VALIDATION_ERROR":
      return new ValidationError(message, options);
    case "AUTH_REQUIRED":
      return new AuthError(message, options);
    case "TIMEOUT":
      return new TimeoutError(message, options);
    case "IDEMPOTENCY_CONFLICT":
      return new IdempotencyConflict(message, options);
    case "INTERNAL":
      return new InternalError(message, options);
    default:
      return new JsonRpcError(category, message, options);
  }
}

/**
 * Formats a {@link JsonRpcError} into a JSON-RPC error response object. Having
 * a single entry point ensures all transports include the same diagnostic data
 * and makes future schema adjustments straightforward.
 */
export function toJsonRpc(
  id: string | number | null,
  error: JsonRpcError,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: error.code,
      message: error.message,
      data: error.data,
    },
  };
}

/** Backwards-compatible alias to ease migration of existing imports. */
export const buildJsonRpcErrorResponse = toJsonRpc;
