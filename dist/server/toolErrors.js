import { z } from "zod";
import { ResourceRegistryError } from "../resources/registry.js";
import { UnknownChildError } from "../state/childrenIndex.js";
/**
 * Serialises a JSON payload with indentation so MCP clients can display the
 * error in a readable form while still allowing structured parsing.
 */
function serialise(payload) {
    return JSON.stringify(payload, null, 2);
}
/**
 * Normalises an arbitrary error into a structured representation that captures
 * the code, message, optional hint and any provided details. Zod validation
 * errors are mapped to a dedicated invalid-input code to help clients surface
 * actionable feedback.
 */
export function normaliseToolError(error, codes) {
    const message = error instanceof Error ? error.message : String(error);
    let code = codes.defaultCode;
    let hint;
    let details;
    if (error instanceof z.ZodError) {
        code = codes.invalidInputCode ?? codes.defaultCode;
        hint = "invalid_input";
        details = { issues: error.issues };
    }
    else if (typeof error.code === "string") {
        code = error.code;
        if (typeof error.hint === "string") {
            hint = error.hint;
        }
        if (Object.prototype.hasOwnProperty.call(error, "details")) {
            details = error.details;
        }
    }
    else if (Object.prototype.hasOwnProperty.call(error, "details")) {
        details = error.details;
    }
    return { code, message, hint, details };
}
/** Writes the structured error into the shared logger and returns the response. */
function logAndWrap(logger, toolName, normalised, context) {
    logger.error(`${toolName}_failed`, {
        ...context,
        message: normalised.message,
        code: normalised.code,
        details: normalised.details,
    });
    const payload = {
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
const CHILD_ERROR_CODES = {
    defaultCode: "E-CHILD-UNEXPECTED",
    invalidInputCode: "E-CHILD-INVALID-INPUT",
};
/**
 * Formats an error raised by a child-related tool. Unknown child identifiers
 * surface the dedicated not-found code alongside contextual metadata so clients
 * can retry or reconcile their state.
 */
export function childToolError(logger, toolName, error, context = {}) {
    if (error instanceof UnknownChildError) {
        const normalised = normaliseToolError(error, { defaultCode: "E-CHILD-NOT-FOUND" });
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
const PLAN_ERROR_CODES = {
    defaultCode: "E-PLAN-UNEXPECTED",
    invalidInputCode: "E-PLAN-INVALID-INPUT",
};
/**
 * Formats an error emitted by plan lifecycle tools. Callers may provide
 * overrides to align specialised tools (e.g. BT compilation) with their
 * dedicated code families.
 */
export function planToolError(logger, toolName, error, context = {}, overrides = {}) {
    const codes = {
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
const GRAPH_ERROR_CODES = {
    defaultCode: "E-GRAPH-UNEXPECTED",
    invalidInputCode: "E-GRAPH-INVALID-INPUT",
};
/** Wraps an error raised by a graph-manipulation tool. */
export function graphToolError(logger, toolName, error, context = {}, overrides = {}) {
    const normalised = normaliseToolError(error, { ...GRAPH_ERROR_CODES, ...overrides });
    return logAndWrap(logger, toolName, normalised, context);
}
/** Wraps failures originating from transaction operations. */
export function transactionToolError(logger, toolName, error, context = {}, overrides = {}) {
    const codes = {
        defaultCode: "E-TX-UNEXPECTED",
        invalidInputCode: "E-TX-INVALID-INPUT",
        ...overrides,
    };
    return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}
/** Wraps failures originating from coordination helpers (blackboard, stigmergy…). */
export function coordinationToolError(logger, toolName, error, context = {}, overrides = {}) {
    const codes = {
        defaultCode: "E-MCP-COORD-UNEXPECTED",
        invalidInputCode: "E-MCP-COORD-INVALID-INPUT",
        ...overrides,
    };
    return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}
/** Wraps errors raised by knowledge graph and assistive tooling. */
export function knowledgeToolError(logger, toolName, error, context = {}, overrides = {}) {
    const codes = {
        defaultCode: "E-ASSIST-UNEXPECTED",
        invalidInputCode: "E-ASSIST-INVALID-INPUT",
        ...overrides,
    };
    return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}
/** Wraps errors originating from the causal memory helpers. */
export function causalToolError(logger, toolName, error, context = {}, overrides = {}) {
    const codes = {
        defaultCode: "E-ASSIST-UNEXPECTED",
        invalidInputCode: "E-ASSIST-INVALID-INPUT",
        ...overrides,
    };
    return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}
/** Wraps errors raised by the value guard. */
export function valueToolError(logger, toolName, error, context = {}, overrides = {}) {
    const codes = {
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
export function resourceToolError(logger, toolName, error, context = {}, overrides = {}) {
    if (error instanceof ResourceRegistryError) {
        const normalised = {
            code: error.code,
            message: error.message,
            hint: error.hint,
            details: error.details,
        };
        return logAndWrap(logger, toolName, normalised, context);
    }
    const codes = {
        defaultCode: "E-RES-UNEXPECTED",
        invalidInputCode: "E-RES-INVALID-INPUT",
        ...overrides,
    };
    return logAndWrap(logger, toolName, normaliseToolError(error, codes), context);
}
