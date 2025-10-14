import { ZodError } from "zod";

import { getActiveTraceContext } from "../infra/tracing.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../server.js";
import { RPC_METHOD_SCHEMAS, ToolsCallEnvelopeSchema, type RpcMethodSchemaRegistry } from "./schemas.js";

interface NormaliseOptions {
  requestId?: string | number | null;
}

export interface NormalisedJsonRpcRequest {
  request: JsonRpcRequest;
  method: string;
  toolName?: string | null;
  schemaApplied: boolean;
}

export const JSON_RPC_ERROR_TAXONOMY = {
  VALIDATION_ERROR: { code: -32602, message: "Invalid params" },
  AUTH_REQUIRED: { code: -32001, message: "Authentication required" },
  RATE_LIMITED: { code: -32002, message: "Rate limit exceeded" },
  IDEMPOTENCY_CONFLICT: { code: -32080, message: "Idempotency conflict" },
  BUDGET_EXCEEDED: { code: -32004, message: "Budget exhausted" },
  TIMEOUT: { code: -32003, message: "Request timeout" },
  INTERNAL: { code: -32000, message: "Internal error" },
} as const;

export type JsonRpcErrorCategory = keyof typeof JSON_RPC_ERROR_TAXONOMY;

export interface JsonRpcErrorData {
  category: JsonRpcErrorCategory;
  request_id?: string | number | null;
  trace_id?: string | null;
  hint?: string;
  issues?: unknown;
  meta?: Record<string, unknown>;
  status?: number;
}

export interface JsonRpcErrorOptions {
  code?: number;
  requestId?: string | number | null;
  hint?: string;
  issues?: unknown;
  meta?: Record<string, unknown>;
  status?: number;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly category: JsonRpcErrorCategory;
  readonly data: JsonRpcErrorData;

  constructor(category: JsonRpcErrorCategory, message: string, code: number, data: JsonRpcErrorData) {
    super(message);
    this.category = category;
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function formatZodIssues(error: ZodError): { hint: string; issues: unknown } {
  const flat = error.flatten((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
  const hint = flat.formErrors.length > 0 ? flat.formErrors.join("; ") : error.errors.map((issue) => issue.message).join("; ");
  return { hint: hint || "Invalid parameters", issues: flat.fieldErrors };
}

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

export function createJsonRpcError(
  category: JsonRpcErrorCategory,
  message?: string,
  options: JsonRpcErrorOptions = {},
): JsonRpcError {
  const taxonomy = JSON_RPC_ERROR_TAXONOMY[category];
  const resolvedMessage = message ?? taxonomy.message;
  const resolvedCode = options.code ?? taxonomy.code;
  return new JsonRpcError(category, resolvedMessage, resolvedCode, createJsonRpcErrorData(category, options));
}

export function normaliseJsonRpcRequest(
  raw: JsonRpcRequest,
  options: NormaliseOptions = {},
  registry: RpcMethodSchemaRegistry = RPC_METHOD_SCHEMAS,
): NormalisedJsonRpcRequest {
  if (!raw || typeof raw !== "object") {
    throw createJsonRpcError("VALIDATION_ERROR", "Invalid Request", {
      code: -32600,
      requestId: options.requestId,
      hint: "Body must be an object",
    });
  }

  if (raw.jsonrpc !== "2.0") {
    throw createJsonRpcError("VALIDATION_ERROR", "Invalid Request", {
      code: -32600,
      requestId: options.requestId,
      hint: "jsonrpc must equal '2.0'",
    });
  }

  const rawMethod = typeof raw.method === "string" ? raw.method : "";
  const method = rawMethod.trim();
  if (!method) {
    throw createJsonRpcError("VALIDATION_ERROR", "Invalid Request", {
      code: -32600,
      requestId: options.requestId,
      hint: "method must be a non-empty string",
    });
  }

  if (method === "tools/call") {
    const envelope = ToolsCallEnvelopeSchema.parse(raw.params ?? {});
    const toolName = envelope.name.trim();
    const schema = registry[toolName];
    if (!schema) {
      throw createJsonRpcError("VALIDATION_ERROR", "Method not found", {
        code: -32601,
        requestId: options.requestId,
        hint: `Unknown tool '${toolName}'`,
      });
    }

    try {
      const parsedArgs = schema.parse(envelope.arguments ?? {});
      return {
        request: { ...raw, method: "tools/call", params: { name: toolName, arguments: parsedArgs } },
        method: method,
        toolName,
        schemaApplied: true,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        const details = formatZodIssues(error);
        throw createJsonRpcError("VALIDATION_ERROR", "Invalid params", {
          requestId: options.requestId,
          hint: details.hint,
          issues: details.issues,
        });
      }
      throw error;
    }
  }

  const schema = registry[method];
  if (!schema) {
    return { request: raw, method, toolName: method.includes("/") ? method : null, schemaApplied: false };
  }

  try {
    const parsedParams = schema.parse(raw.params ?? {});
    return { request: { ...raw, method, params: parsedParams }, method, toolName: method, schemaApplied: true };
  } catch (error) {
    if (error instanceof ZodError) {
      const details = formatZodIssues(error);
      throw createJsonRpcError("VALIDATION_ERROR", "Invalid params", {
        requestId: options.requestId,
        hint: details.hint,
        issues: details.issues,
      });
    }
    throw error;
  }
}

export function buildJsonRpcErrorResponse(
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

export { JsonRpcError as JsonRpcValidationError };
