/**
 * Shared type aliases used across the orchestrator. Centralising identifiers
 * avoids sprinkling plain strings throughout the codebase and improves
 * legibility when cross-referencing logs with in-memory entities.
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

/** Roles a message can carry when exchanged between agents. */
export type Role = "system" | "user" | "assistant";

/** Originators that can emit a message inside a transcript. */
export type Actor = "orchestrator" | "child" | "external" | "user";

/** Structured entry stored when persisting conversational transcripts. */
export interface MessageRecord {
  /** Message role as understood by downstream LLMs. */
  role: Role;
  /** Raw textual content supplied by the actor. */
  content: string;
  /** Unix timestamp (milliseconds) at which the message was recorded. */
  ts: number;
  /** Optional actor identifier used for auditing/debugging. */
  actor?: Actor;
}

/**
 * Strongly typed catalogue of stable error codes grouped by feature family.
 * Keeping a single source of truth ensures every tool emits consistent codes
 * which simplifies documentation and client handling.
 */
export const ERROR_CATALOG = {
  MCP: {
    INVALID_REQUEST: "E-MCP-INVALID-REQUEST",
    UNSUPPORTED: "E-MCP-UNSUPPORTED",
    UNAVAILABLE: "E-MCP-UNAVAILABLE",
  },
  RES: {
    NOT_FOUND: "E-RES-NOT-FOUND",
    FORBIDDEN: "E-RES-FORBIDDEN",
    WATCH_UNSUPPORTED: "E-RES-WATCH-UNSUPPORTED",
  },
  EVT: {
    STREAM_CLOSED: "E-EVT-STREAM-CLOSED",
    FILTER_UNSUPPORTED: "E-EVT-FILTER-UNSUPPORTED",
    BACKPRESSURE_DROPPED: "E-EVT-BACKPRESSURE-DROPPED",
  },
  CANCEL: {
    NOT_FOUND: "E-CANCEL-NOTFOUND",
    ALREADY_RESOLVED: "E-CANCEL-ALREADY-RESOLVED",
    UNSUPPORTED: "E-CANCEL-UNSUPPORTED",
  },
  BULK: {
    PARTIAL: "E-BULK-PARTIAL",
    DISABLED: "E-BULK-DISABLED",
  },
  TX: {
    NOT_FOUND: "E-TX-NOTFOUND",
    CONFLICT: "E-TX-CONFLICT",
    INVALID_OP: "E-TX-INVALIDOP",
    UNEXPECTED: "E-TX-UNEXPECTED",
    INVALID_INPUT: "E-TX-INVALID-INPUT",
    EXPIRED: "E-TX-EXPIRED",
  },
  LOCK: {
    HELD: "E-LOCK-HELD",
    NOT_FOUND: "E-LOCK-NOT-FOUND",
    EXPIRED: "E-LOCK-EXPIRED",
  },
  PATCH: {
    INVALID: "E-PATCH-INVALID",
    INVARIANT_VIOLATION: "E-PATCH-INVARIANT-VIOLATION",
    CYCLE: "E-PATCH-CYCLE",
    PORTS: "E-PATCH-PORTS",
    CARD: "E-PATCH-CARD",
  },
  PLAN: {
    NOT_RUNNING: "E-PLAN-NOT-RUNNING",
    ALREADY_PAUSED: "E-PLAN-ALREADY-PAUSED",
    STATE: "E-PLAN-STATE",
    UNEXPECTED: "E-PLAN-UNEXPECTED",
    INVALID_INPUT: "E-PLAN-INVALID-INPUT",
  },
  CHILD: {
    NOT_FOUND: "E-CHILD-NOTFOUND",
    LIMIT_EXCEEDED: "E-CHILD-LIMIT",
    UNEXPECTED: "E-CHILD-UNEXPECTED",
    INVALID_INPUT: "E-CHILD-INVALID-INPUT",
  },
  VALUES: {
    VIOLATION: "E-VALUES-VIOLATION",
    EXPLAIN_UNAVAILABLE: "E-VALUES-EXPLAIN-UNAVAILABLE",
  },
  ASSIST: {
    UNAVAILABLE: "E-ASSIST-UNAVAILABLE",
    NOT_READY: "E-ASSIST-NOT-READY",
  },
  GRAPH: {
    UNEXPECTED: "E-GRAPH-UNEXPECTED",
    INVALID_INPUT: "E-GRAPH-INVALID-INPUT",
  },
} as const;

type ErrorCatalog = typeof ERROR_CATALOG;

/** Utility type used to flatten the nested error catalogue. */
type FlattenCatalog<T extends Record<string, Record<string, string>>> = {
  [Family in keyof T & string as `${Family}_${keyof T[Family] & string}`]: T[Family][keyof T[Family] & string];
};

/** Flattened version of {@link ERROR_CATALOG} used for ergonomic lookups. */
type FlatErrorCatalog = FlattenCatalog<ErrorCatalog>;

/**
 * Builds a flattened object whose properties map to their fully qualified error
 * codes (e.g. `PLAN_STATE`). The helper keeps runtime data immutable while
 * preserving the strongly typed relationship with {@link ERROR_CATALOG}.
 */
function flattenCatalog<T extends Record<string, Record<string, string>>>(
  catalog: T,
): FlattenCatalog<T> {
  const flat: Record<string, string> = {};
  for (const familyKey of Object.keys(catalog) as Array<keyof T & string>) {
    const family = catalog[familyKey];
    for (const codeKey of Object.keys(family) as Array<keyof T[typeof familyKey] & string>) {
      flat[`${familyKey}_${codeKey}`] = family[codeKey];
    }
  }
  return Object.freeze(flat) as FlattenCatalog<T>;
}

/** Flat access to all stable error codes (e.g. `ERROR_CODES.PLAN_STATE`). */
export const ERROR_CODES: FlatErrorCatalog = flattenCatalog(ERROR_CATALOG);

/** Union type representing every stable error code emitted by MCP tools. */
export type ErrorCode = FlatErrorCatalog[keyof FlatErrorCatalog];

/** Maximum number of UTF-16 code units allowed for error messages and hints. */
export const ERROR_TEXT_MAX_LENGTH = 120;

/**
 * Collapses whitespace, trims surrounding spaces and enforces the maximum length
 * for an error message. If the provided text is empty once trimmed a generic
 * fallback is returned so clients never receive an empty string.
 */
export function normaliseErrorMessage(text: string, fallback = "unexpected error"): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const base = collapsed.length === 0 ? fallback : collapsed;
  if (base.length <= ERROR_TEXT_MAX_LENGTH) {
    return base;
  }
  return `${base.slice(0, ERROR_TEXT_MAX_LENGTH - 1)}…`;
}

/**
 * Normalises the optional hint attached to an error. Empty strings collapse to
 * `undefined` while overly long hints are truncated to keep payloads concise.
 */
export function normaliseErrorHint(hint?: string): string | undefined {
  if (hint === undefined) {
    return undefined;
  }
  const collapsed = hint.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  if (collapsed.length <= ERROR_TEXT_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, ERROR_TEXT_MAX_LENGTH - 1)}…`;
}

/** Structure returned by tools when an operation succeeds. */
export interface ToolSuccess<T> {
  ok: true;
  value: T;
}

/** Standard structure returned by tools when an operation fails. */
export interface ToolError {
  ok: false;
  code: ErrorCode;
  message: string;
  hint?: string;
}

/** Convenience union describing the common tool result envelope. */
export type ToolResult<T> = ToolSuccess<T> | ToolError;

/**
 * Helper used by tools to build a failure response with the expected shape.
 * Keeping the implementation centralised guarantees a consistent structure
 * (including optional hints) across every feature surface.
 */
export function fail(code: ErrorCode, message: string, hint?: string): ToolError {
  const normalisedMessage = normaliseErrorMessage(message);
  const normalisedHint = normaliseErrorHint(hint);
  return normalisedHint
    ? { ok: false, code, message: normalisedMessage, hint: normalisedHint }
    : { ok: false, code, message: normalisedMessage };
}
