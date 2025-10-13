import { ZodError } from "zod";
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

export class JsonRpcValidationError extends Error {
  readonly code: number;
  readonly data: { request_id?: string | number | null; hint?: string; issues?: unknown };

  constructor(code: number, message: string, data: { request_id?: string | number | null; hint?: string; issues?: unknown } = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function formatZodIssues(error: ZodError): { hint: string; issues: unknown } {
  const flat = error.flatten((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
  const hint = flat.formErrors.length > 0 ? flat.formErrors.join("; ") : error.errors.map((issue) => issue.message).join("; ");
  return { hint: hint || "Invalid parameters", issues: flat.fieldErrors };
}

export function normaliseJsonRpcRequest(
  raw: JsonRpcRequest,
  options: NormaliseOptions = {},
  registry: RpcMethodSchemaRegistry = RPC_METHOD_SCHEMAS,
): NormalisedJsonRpcRequest {
  if (!raw || typeof raw !== "object") {
    throw new JsonRpcValidationError(-32600, "Invalid Request", { request_id: options.requestId, hint: "Body must be an object" });
  }

  if (raw.jsonrpc !== "2.0") {
    throw new JsonRpcValidationError(-32600, "Invalid Request", {
      request_id: options.requestId,
      hint: "jsonrpc must equal '2.0'",
    });
  }

  const rawMethod = typeof raw.method === "string" ? raw.method : "";
  const method = rawMethod.trim();
  if (!method) {
    throw new JsonRpcValidationError(-32600, "Invalid Request", {
      request_id: options.requestId,
      hint: "method must be a non-empty string",
    });
  }

  if (method === "tools/call") {
    const envelope = ToolsCallEnvelopeSchema.parse(raw.params ?? {});
    const toolName = envelope.name.trim();
    const schema = registry[toolName];
    if (!schema) {
      throw new JsonRpcValidationError(-32601, "Method not found", {
        request_id: options.requestId,
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
        throw new JsonRpcValidationError(-32602, "Invalid params", {
          request_id: options.requestId,
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
      throw new JsonRpcValidationError(-32602, "Invalid params", {
        request_id: options.requestId,
        hint: details.hint,
        issues: details.issues,
      });
    }
    throw error;
  }
}

export function buildJsonRpcErrorResponse(
  id: string | number | null,
  error: JsonRpcValidationError,
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
