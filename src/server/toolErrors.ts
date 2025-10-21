import { z } from "zod";

import type { StructuredLogger } from "../logger.js";
import { normaliseErrorHint, normaliseErrorMessage } from "../types.js";
import { omitUndefinedEntries } from "../utils/object.js";
import { ResourceRegistryError } from "../resources/registry.js";
import { UnknownChildError } from "../state/childrenIndex.js";

/**
 * Structured payload returned by tool handlers when an error occurs. The MCP
 * transport expects the `content` array to contain textual JSON so downstream
 * clients can parse the code, hint and optional details.
 */
export interface ToolErrorResponse {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Normalised representation of a thrown error used to enrich tool responses and
 * log entries with machine readable metadata.
 */
export interface NormalisedToolError {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

/** Configuration describing the codes associated with an error category. */
export interface ToolErrorCodes {
  /** Default error code applied when no specific mapping is provided. */
  defaultCode: string;
  /** Optional error code used when the failure originates from input parsing. */
  invalidInputCode?: string;
}

/**
 * Serialises a JSON payload with indentation so MCP clients can display the
 * error in a readable form while still allowing structured parsing.
 */
function serialise(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * Normalises an arbitrary error into a structured representation that captures
 * the code, message, optional hint and any provided details. Zod validation
 * errors are mapped to a dedicated invalid-input code to help clients surface
 * actionable feedback.
 */
export function normaliseToolError(error: unknown, codes: ToolErrorCodes): NormalisedToolError {
  const message = error instanceof Error ? error.message : String(error);
  let code = codes.defaultCode;
  let hint: string | undefined;
  let details: unknown;

  if (error instanceof z.ZodError) {
    code = codes.invalidInputCode ?? codes.defaultCode;
    hint = "invalid_input";
    details = { issues: error.issues };
  } else if (typeof (error as { code?: unknown }).code === "string") {
    code = (error as { code: string }).code;
    if (typeof (error as { hint?: unknown }).hint === "string") {
      hint = (error as { hint: string }).hint;
    }
    if (Object.prototype.hasOwnProperty.call(error as object, "details")) {
      details = (error as { details?: unknown }).details;
    }
  } else if (Object.prototype.hasOwnProperty.call(error as object, "details")) {
    details = (error as { details?: unknown }).details;
  }

  const normalisedMessage = normaliseErrorMessage(message);
  const normalisedHint = normaliseErrorHint(hint);
  // NOTE: Undefined hints/details are stripped so the resulting structure stays
  // compliant once `exactOptionalPropertyTypes` enforces exactness on optional
  // properties across the code base.
  return {
    code,
    message: normalisedMessage,
    ...omitUndefinedEntries({
      hint: normalisedHint,
      details,
    }),
  };
}

/** Writes the structured error into the shared logger and returns the response. */
function logAndWrap(
  logger: StructuredLogger,
  toolName: string,
  normalised: NormalisedToolError,
  context: Record<string, unknown>,
): ToolErrorResponse {
  logger.error(`${toolName}_failed`, {
    ...context,
    message: normalised.message,
    code: normalised.code,
    details: normalised.details,
  });

  const payload: Record<string, unknown> = {
    // Attach the explicit `{ ok:false }` marker requested by the checklist so
    // clients can branch on success/error uniformly without inspecting codes.
    ok: false,
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }

  return {
    isError: true,
    content: [{ type: "text", text: serialise(payload) }],
  };
}

/** Base configuration shared by all child-tool error responses. */
const CHILD_ERROR_CODES: ToolErrorCodes = {
  defaultCode: "E-CHILD-UNEXPECTED",
  invalidInputCode: "E-CHILD-INVALID-INPUT",
};

/**
 * Formats an error raised by a child-related tool. Unknown child identifiers
 * surface the dedicated not-found code alongside contextual metadata so clients
 * can retry or reconcile their state.
 */
export function childToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
): ToolErrorResponse {
  if (error instanceof UnknownChildError) {
    const normalised = normaliseToolError(error, { defaultCode: "E-CHILD-NOTFOUND" });
    if (!normalised.hint) {
      normalised.hint = "unknown_child";
    }
    if (normalised.details === undefined) {
      normalised.details = { child_id: error.childId };
    }
    return logAndWrap(logger, toolName, normalised, context);
  }

  const normalised = normaliseToolError(error, CHILD_ERROR_CODES);
  return logAndWrap(logger, toolName, normalised, context);
}

/** Base configuration for general plan-tool failures. */
const PLAN_ERROR_CODES: ToolErrorCodes = {
  defaultCode: "E-PLAN-UNEXPECTED",
  invalidInputCode: "E-PLAN-INVALID-INPUT",
};

/**
 * Formats an error emitted by plan lifecycle tools. Callers may provide
 * overrides to align specialised tools (e.g. BT compilation) with their
 * dedicated code families.
 */
export function planToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const codes: ToolErrorCodes = {
    ...PLAN_ERROR_CODES,
    ...overrides,
  };
  if (!codes.invalidInputCode) {
    codes.invalidInputCode = codes.defaultCode === PLAN_ERROR_CODES.defaultCode ? PLAN_ERROR_CODES.invalidInputCode : codes.defaultCode;
  }
  const normalised = normaliseToolError(error, codes);
  return logAndWrap(logger, toolName, normalised, context);
}

/** Base configuration used by graph-related tools. */
const GRAPH_ERROR_CODES: ToolErrorCodes = {
  defaultCode: "E-GRAPH-UNEXPECTED",
  invalidInputCode: "E-GRAPH-INVALID-INPUT",
};

/** Wraps an error raised by a graph-manipulation tool. */
export function graphToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const normalised = normaliseToolError(error, { ...GRAPH_ERROR_CODES, ...overrides });
  return logAndWrap(logger, toolName, normalised, context);
}

/** Wraps failures originating from transaction operations. */
export function transactionToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const codes: ToolErrorCodes = {
    defaultCode: "E-TX-UNEXPECTED",
    invalidInputCode: "E-TX-INVALID-INPUT",
    ...overrides,
  };
  return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}

/** Wraps failures originating from coordination helpers (blackboard, stigmergy…). */
export function coordinationToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const codes: ToolErrorCodes = {
    defaultCode: "E-MCP-COORD-UNEXPECTED",
    invalidInputCode: "E-MCP-COORD-INVALID-INPUT",
    ...overrides,
  };
  return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}

/** Wraps errors raised by knowledge graph and assistive tooling. */
export function knowledgeToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const codes: ToolErrorCodes = {
    defaultCode: "E-ASSIST-UNEXPECTED",
    invalidInputCode: "E-ASSIST-INVALID-INPUT",
    ...overrides,
  };
  return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}

/** Wraps errors originating from the causal memory helpers. */
export function causalToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const codes: ToolErrorCodes = {
    defaultCode: "E-ASSIST-UNEXPECTED",
    invalidInputCode: "E-ASSIST-INVALID-INPUT",
    ...overrides,
  };
  return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}

/** Wraps errors raised by the value guard. */
export function valueToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  const codes: ToolErrorCodes = {
    defaultCode: "E-VALUES-UNEXPECTED",
    invalidInputCode: "E-VALUES-INVALID-INPUT",
    ...overrides,
  };
  return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}

/**
 * Wraps errors coming from the resource registry. Domain-specific errors expose
 * their own codes while unexpected failures fall back to the shared E-RES
 * namespace.
 */
export function resourceToolError(
  logger: StructuredLogger,
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  overrides: Partial<ToolErrorCodes> = {},
): ToolErrorResponse {
  if (error instanceof ResourceRegistryError) {
    const normalised: NormalisedToolError = {
      code: error.code,
      message: error.message,
      ...omitUndefinedEntries({
        hint: error.hint,
        details: error.details,
      }),
    };
    return logAndWrap(logger, toolName, normalised, context);
  }

  const codes: ToolErrorCodes = {
    defaultCode: "E-RES-UNEXPECTED",
    invalidInputCode: "E-RES-INVALID-INPUT",
    ...overrides,
  };
  return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}
