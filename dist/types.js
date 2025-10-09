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
};
/**
 * Builds a flattened object whose properties map to their fully qualified error
 * codes (e.g. `PLAN_STATE`). The helper keeps runtime data immutable while
 * preserving the strongly typed relationship with {@link ERROR_CATALOG}.
 */
function flattenCatalog(catalog) {
    const flat = {};
    for (const familyKey of Object.keys(catalog)) {
        const family = catalog[familyKey];
        for (const codeKey of Object.keys(family)) {
            flat[`${familyKey}_${codeKey}`] = family[codeKey];
        }
    }
    return Object.freeze(flat);
}
/** Flat access to all stable error codes (e.g. `ERROR_CODES.PLAN_STATE`). */
export const ERROR_CODES = flattenCatalog(ERROR_CATALOG);
/** Maximum number of UTF-16 code units allowed for error messages and hints. */
export const ERROR_TEXT_MAX_LENGTH = 120;
/**
 * Collapses whitespace, trims surrounding spaces and enforces the maximum length
 * for an error message. If the provided text is empty once trimmed a generic
 * fallback is returned so clients never receive an empty string.
 */
export function normaliseErrorMessage(text, fallback = "unexpected error") {
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
export function normaliseErrorHint(hint) {
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
/**
 * Helper used by tools to build a failure response with the expected shape.
 * Keeping the implementation centralised guarantees a consistent structure
 * (including optional hints) across every feature surface.
 */
export function fail(code, message, hint) {
    const normalisedMessage = normaliseErrorMessage(message);
    const normalisedHint = normaliseErrorHint(hint);
    return normalisedHint
        ? { ok: false, code, message: normalisedMessage, hint: normalisedHint }
        : { ok: false, code, message: normalisedMessage };
}
