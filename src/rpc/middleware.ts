import { ZodError } from "zod";

import type { JsonRpcRouteContext } from "../infra/runtime.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../server.js";
import { JsonRpcError, createJsonRpcError, toJsonRpc } from "./errors.js";
import { RPC_METHOD_SCHEMAS, ToolsCallEnvelopeSchema, type RpcMethodSchemaRegistry } from "./schemas.js";

/** Options propagated to the normaliser so it can enrich validation errors. */
interface NormaliseOptions {
  requestId?: string | number | null;
}

export interface NormalisedJsonRpcRequest {
  request: JsonRpcRequest;
  method: string;
  toolName?: string | null;
  schemaApplied: boolean;
}

/**
 * Minimal snapshot emitted when {@link createRpcHandler} maps a
 * {@link JsonRpcError} to a JSON-RPC response. The payload gives observability
 * hooks enough context to log or meter the failure without leaking
 * transport-specific details into the middleware.
 */
export interface RpcErrorSnapshot {
  /** Identifier propagated by the transport, if any. */
  readonly requestId: string | number | null;
  /** Fully qualified method name extracted from the request payload. */
  readonly method: string | null;
  /** Logical tool name targeted by the invocation, when available. */
  readonly toolName: string | null;
}

/** Pure function signature used to normalise incoming JSON-RPC requests. */
export type JsonRpcNormaliser = (
  raw: JsonRpcRequest,
  options: NormaliseOptions,
) => NormalisedJsonRpcRequest;

/** Dependencies required to build the reusable JSON-RPC middleware. */
export interface RpcHandlerDependencies {
  /**
   * Optional normaliser to use instead of the default implementation. Tests can
   * inject fakes while production code falls back to
   * {@link normaliseJsonRpcRequest}.
   */
  readonly normalise?: JsonRpcNormaliser;
  /**
   * Pure dispatcher invoked once the request payload has been validated. The
   * function returns the JSON-RPC response or throws a {@link JsonRpcError} to
   * surface domain-specific failures.
   */
  readonly route: (
    request: NormalisedJsonRpcRequest,
    context?: JsonRpcRouteContext,
  ) => Promise<JsonRpcResponse>;
  /** Optional hook triggered whenever routing results in a {@link JsonRpcError}. */
  readonly onError?: (error: JsonRpcError, snapshot: RpcErrorSnapshot) => void;
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

function extractRequestId(candidate: unknown): string | number | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const rawId = (candidate as { id?: unknown }).id;
  return typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
}

function extractMethod(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const rawMethod = (candidate as { method?: unknown }).method;
  return typeof rawMethod === "string" ? rawMethod.trim() || null : null;
}

/**
 * Creates a pure JSON-RPC middleware that normalises inbound payloads, applies
 * the registered Zod schema validations, and delegates to the provided router.
 * Any {@link JsonRpcError} thrown either by the normaliser or the router is
 * transformed into a compliant JSON-RPC error response to guarantee clients do
 * not receive generic 500 responses for validation failures.
 */
export function createRpcHandler(deps: RpcHandlerDependencies) {
  const normalise: JsonRpcNormaliser = deps.normalise ?? ((raw, options) => normaliseJsonRpcRequest(raw, options));

  return async function handle(
    rawRequest: JsonRpcRequest,
    context?: JsonRpcRouteContext,
  ): Promise<JsonRpcResponse> {
    const requestId = context?.requestId ?? extractRequestId(rawRequest);
    let method = extractMethod(rawRequest);
    let toolName: string | null = null;

    let normalised: NormalisedJsonRpcRequest | null = null;
    try {
      normalised = normalise(rawRequest, { requestId });
      method = normalised.method;
      toolName = normalised.toolName ?? null;
      return await deps.route(normalised, context);
    } catch (error) {
      if (error instanceof JsonRpcError) {
        deps.onError?.(error, { requestId, method, toolName });
        return toJsonRpc(requestId ?? null, error);
      }
      throw error;
    }
  };
}

export {
  JsonRpcError,
  JsonRpcError as JsonRpcValidationError,
  JSON_RPC_ERROR_TAXONOMY,
  createJsonRpcError,
  toJsonRpc,
  type JsonRpcErrorCategory,
  type JsonRpcErrorOptions,
} from "./errors.js";
