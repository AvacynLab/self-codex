/**
 * Shared type aliases used across the orchestrator. The goal is to centralise
 * identifiers so that server modules rely on descriptive names instead of raw
 * strings.
 */
export type RunId = string;
/** Identifier of a tool invocation or long running operation. */
export type OpId = string;
/** Identifier of a graph persisted in the registry. */
export type GraphId = string;
/** Semantic version string used to track graph revisions. */
export type Version = string;
/** Identifier assigned to a spawned child runtime. */
export type ChildId = string;
/** Identifier representing an open transaction. */
export type TransactionId = string;
/** Canonical URI referencing a resource exposed via MCP. */
export type ResourceUri = string;

export type Role = "system" | "user" | "assistant";
export type Actor = "orchestrator" | "child" | "external" | "user";

export interface MessageRecord {
  role: Role;
  content: string;
  ts: number;
  actor?: Actor;
}

/**
 * Canonical list of error codes returned by MCP tools. Keeping the catalogue in
 * a single location ensures codes remain stable and discoverable when new
 * modules are introduced.
 */
export const ERROR_CODES = {
  MCP_INVALID_REQUEST: "E-MCP-INVALID-REQUEST",
  MCP_UNAVAILABLE: "E-MCP-UNAVAILABLE",
  RES_NOT_FOUND: "E-RES-NOT-FOUND",
  RES_FORBIDDEN: "E-RES-FORBIDDEN",
  EVT_STREAM_CLOSED: "E-EVT-STREAM-CLOSED",
  EVT_FILTER_UNSUPPORTED: "E-EVT-FILTER-UNSUPPORTED",
  CANCEL_UNSUPPORTED: "E-CANCEL-UNSUPPORTED",
  CANCEL_ALREADY_RESOLVED: "E-CANCEL-ALREADY-RESOLVED",
  TX_CONFLICT: "E-TX-CONFLICT",
  TX_UNKNOWN: "E-TX-UNKNOWN",
  LOCK_HELD: "E-LOCK-HELD",
  LOCK_NOT_FOUND: "E-LOCK-NOT-FOUND",
  PATCH_INVALID: "E-PATCH-INVALID",
  PATCH_INVARIANT_VIOLATION: "E-PATCH-INVARIANT-VIOLATION",
  PLAN_NOT_RUNNING: "E-PLAN-NOT-RUNNING",
  PLAN_ALREADY_PAUSED: "E-PLAN-ALREADY-PAUSED",
  CHILD_NOT_FOUND: "E-CHILD-NOT-FOUND",
  CHILD_LIMIT_EXCEEDED: "E-CHILD-LIMIT-EXCEEDED",
  VALUES_VIOLATION: "E-VALUES-VIOLATION",
  ASSIST_UNAVAILABLE: "E-ASSIST-UNAVAILABLE",
} as const;

/** Union type representing every stable error code emitted by MCP tools. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Standard structure returned by tools when an operation fails. */
export interface ToolError {
  ok: false;
  code: ErrorCode;
  message: string;
  hint?: string;
}
