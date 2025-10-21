import { setTimeout as delay } from "node:timers/promises";
import { runtimeTimers } from "../runtime/timers.js";
/**
 * Error raised internally when a sandbox handler exceeds the granted timeout.
 */
class SandboxTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "SandboxTimeoutError";
    }
}
/**
 * Registry storing sandbox handlers. The orchestrator keeps a singleton
 * instance but tests can create isolated registries to exercise behaviours.
 */
export class SandboxRegistry {
    handlers = new Map();
    defaultTimeoutMs;
    constructor(options = {}) {
        const timeout = options.defaultTimeoutMs ?? 2_000;
        if (!Number.isFinite(timeout) || timeout <= 0) {
            throw new Error("defaultTimeoutMs must be a positive finite number");
        }
        this.defaultTimeoutMs = timeout;
    }
    /** Registers (or overrides) a handler associated with the provided action. */
    register(action, handler) {
        if (!action || typeof action !== "string") {
            throw new Error("sandbox action name must be a non-empty string");
        }
        this.handlers.set(action, handler);
    }
    /** Removes a handler from the registry. */
    unregister(action) {
        this.handlers.delete(action);
    }
    /** Returns true when a handler exists for the requested action. */
    has(action) {
        return this.handlers.has(action);
    }
    /** Clears every registered handler (mainly used in unit tests). */
    clear() {
        this.handlers.clear();
    }
    /**
     * Executes the handler registered for the provided action. The method never
     * throws: failures/timeouts are encoded in the returned status so callers can
     * decide how to react (abort, warn, retry…).
     */
    async execute(request) {
        const handler = this.handlers.get(request.action);
        const startedAt = Date.now();
        if (!handler) {
            const finishedAt = Date.now();
            return {
                action: request.action,
                status: "skipped",
                startedAt,
                finishedAt,
                durationMs: finishedAt - startedAt,
                reason: "handler_missing",
                metadata: cloneRecord(request.metadata),
            };
        }
        const timeoutMs = normaliseTimeout(request.timeoutMs ?? this.defaultTimeoutMs);
        const controller = new AbortController();
        const abortSignal = controller.signal;
        const payloadClone = freezeDeep(cloneValue(request.payload));
        const executionRequest = {
            action: request.action,
            payload: payloadClone,
            metadata: cloneRecord(request.metadata),
            timeoutMs,
            signal: abortSignal,
        };
        let timeoutHandle = null;
        let timedOut = false;
        const handlerPromise = Promise.resolve()
            .then(() => handler(executionRequest))
            .then((result) => normaliseHandlerResult(result));
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = runtimeTimers.setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(new SandboxTimeoutError(`Sandbox action "${request.action}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
        let handlerResult = null;
        let caughtError = null;
        try {
            handlerResult = await (timeoutMs > 0 ? Promise.race([handlerPromise, timeoutPromise]) : handlerPromise);
        }
        catch (error) {
            caughtError = error;
        }
        finally {
            if (timeoutHandle) {
                runtimeTimers.clearTimeout(timeoutHandle);
            }
            // Give cooperative handlers a brief chance to observe the abort signal.
            if (timedOut) {
                await delay(5);
            }
        }
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        if (timedOut) {
            return {
                action: request.action,
                status: "timeout",
                startedAt,
                finishedAt,
                durationMs,
                reason: `timeout_after_${timeoutMs}ms`,
                metadata: executionRequest.metadata,
            };
        }
        if (caughtError) {
            const normalised = normaliseError(caughtError);
            return {
                action: request.action,
                status: "error",
                startedAt,
                finishedAt,
                durationMs,
                error: normalised,
                reason: normalised.message,
                metadata: executionRequest.metadata,
            };
        }
        const result = handlerResult ?? { outcome: "success" };
        const metrics = normaliseMetrics(result.metrics);
        if (result.outcome === "failure") {
            const normalisedError = normaliseError(result.error ?? "sandbox failure");
            return {
                action: request.action,
                status: "error",
                startedAt,
                finishedAt,
                durationMs,
                preview: result.preview,
                metrics,
                error: normalisedError,
                reason: normalisedError.message,
                metadata: executionRequest.metadata,
            };
        }
        return {
            action: request.action,
            status: "ok",
            startedAt,
            finishedAt,
            durationMs,
            preview: result.preview,
            metrics,
            metadata: executionRequest.metadata,
        };
    }
}
let activeRegistry = new SandboxRegistry();
/** Returns the shared sandbox registry used by the server. */
export function getSandboxRegistry() {
    return activeRegistry;
}
/**
 * Overrides the shared sandbox registry. Mainly used by integration tests that
 * need a deterministic set of handlers.
 */
export function setSandboxRegistry(registry) {
    const previous = activeRegistry;
    activeRegistry = registry;
    return previous;
}
/**
 * Convenience helper used by production code when the caller does not need to
 * interact with a custom registry instance.
 */
export async function runSandboxAction(request) {
    return activeRegistry.execute(request);
}
function normaliseHandlerResult(value) {
    if (!value) {
        return { outcome: "success" };
    }
    if (value.outcome !== "success" && value.outcome !== "failure") {
        return { outcome: "success" };
    }
    return value;
}
function normaliseMetrics(metrics) {
    if (!metrics || typeof metrics !== "object") {
        return undefined;
    }
    const filtered = {};
    for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === "number" && Number.isFinite(value)) {
            filtered[key] = value;
        }
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
}
function normaliseTimeout(timeout) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
        return 2_000;
    }
    return Math.min(timeout, 60_000);
}
function cloneRecord(metadata) {
    if (!metadata || typeof metadata !== "object") {
        return undefined;
    }
    const clone = cloneValue(metadata);
    return freezeDeep(clone);
}
function normaliseError(error) {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    const message = typeof error === "string" ? error : JSON.stringify(error);
    return { name: "SandboxError", message };
}
function cloneValue(value) {
    const structuredCloneFn = typeof globalThis.structuredClone === "function"
        ? globalThis.structuredClone
        : undefined;
    if (structuredCloneFn) {
        try {
            return structuredCloneFn(value);
        }
        catch (error) {
            // Fall through to the manual copy below when the value contains
            // unsupported entries such as functions or symbols.
        }
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => cloneValue(entry));
    }
    if (value instanceof Map) {
        return new Map(Array.from(value.entries(), ([key, entry]) => [key, cloneValue(entry)]));
    }
    if (value instanceof Set) {
        return new Set(Array.from(value.values(), (entry) => cloneValue(entry)));
    }
    const clone = {};
    for (const [key, entry] of Object.entries(value)) {
        clone[key] = cloneValue(entry);
    }
    return clone;
}
function freezeDeep(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            freezeDeep(entry);
        }
    }
    else if (value instanceof Map || value instanceof Set) {
        for (const entry of value.values()) {
            freezeDeep(entry);
        }
    }
    else {
        for (const key of Object.keys(value)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursive walk across arbitrary payloads
            freezeDeep(value[key]);
        }
    }
    return Object.freeze(value);
}
//# sourceMappingURL=sandbox.js.map