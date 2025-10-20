import { setTimeout as delay } from "node:timers/promises";
import { runtimeTimers, type TimeoutHandle } from "../runtime/timers.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Status values reported after executing a sandboxed action.
 */
export type SandboxStatus = "ok" | "error" | "timeout" | "skipped";

/**
 * Normalised shape returned by sandbox handlers.
 */
export interface SandboxHandlerResult {
  /** Indicates whether the simulated execution succeeded or failed. */
  outcome: "success" | "failure";
  /** Optional preview payload describing the simulated output. */
  preview?: unknown;
  /** Optional metrics (duration, tokens, cost…) reported by the handler. */
  metrics?: Record<string, number>;
  /** Optional error produced when {@link outcome} equals "failure". */
  error?: Error | string;
}

/**
 * Request forwarded to sandbox handlers.
 */
export interface SandboxExecutionRequest {
  /** Unique action identifier resolved by the orchestrator. */
  action: string;
  /** Payload mirroring the message that would be sent to the real child. */
  payload: unknown;
  /** Arbitrary metadata (child id, risk level…) attached to the request. */
  metadata?: Record<string, unknown>;
  /** Maximum amount of time granted to the handler (milliseconds). */
  timeoutMs?: number;
  /** Abort signal toggled when a timeout elapses. */
  signal: AbortSignal;
}

/**
 * Result produced after simulating an action.
 */
export interface SandboxExecutionResult {
  action: string;
  status: SandboxStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  preview?: unknown;
  metrics?: Record<string, number>;
  error?: { name: string; message: string };
  /** Human readable reason (missing handler, error message…). */
  reason?: string;
  /** Echo of the metadata provided in the request. */
  metadata?: Record<string, unknown>;
}

/** Shape implemented by sandbox handlers. */
export type SandboxHandler = (
  request: SandboxExecutionRequest,
) => Promise<SandboxHandlerResult | void> | SandboxHandlerResult | void;

/**
 * Error raised internally when a sandbox handler exceeds the granted timeout.
 */
class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutError";
  }
}

/**
 * Configuration accepted by {@link SandboxRegistry}.
 */
export interface SandboxRegistryOptions {
  /** Default timeout (milliseconds) applied when requests omit the field. */
  defaultTimeoutMs?: number;
}

/**
 * Registry storing sandbox handlers. The orchestrator keeps a singleton
 * instance but tests can create isolated registries to exercise behaviours.
 */
export class SandboxRegistry {
  private readonly handlers = new Map<string, SandboxHandler>();
  private readonly defaultTimeoutMs: number;

  constructor(options: SandboxRegistryOptions = {}) {
    const timeout = options.defaultTimeoutMs ?? 2_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("defaultTimeoutMs must be a positive finite number");
    }
    this.defaultTimeoutMs = timeout;
  }

  /** Registers (or overrides) a handler associated with the provided action. */
  register(action: string, handler: SandboxHandler): void {
    if (!action || typeof action !== "string") {
      throw new Error("sandbox action name must be a non-empty string");
    }
    this.handlers.set(action, handler);
  }

  /** Removes a handler from the registry. */
  unregister(action: string): void {
    this.handlers.delete(action);
  }

  /** Returns true when a handler exists for the requested action. */
  has(action: string): boolean {
    return this.handlers.has(action);
  }

  /** Clears every registered handler (mainly used in unit tests). */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Executes the handler registered for the provided action. The method never
   * throws: failures/timeouts are encoded in the returned status so callers can
   * decide how to react (abort, warn, retry…).
   */
  async execute(request: {
    action: string;
    payload: unknown;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<SandboxExecutionResult> {
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
    const executionRequest: SandboxExecutionRequest = {
      action: request.action,
      payload: payloadClone,
      metadata: cloneRecord(request.metadata),
      timeoutMs,
      signal: abortSignal,
    };

    let timeoutHandle: TimeoutHandle | null = null;
    let timedOut = false;

    const handlerPromise = Promise.resolve()
      .then(() => handler(executionRequest))
      .then((result) => normaliseHandlerResult(result));

    const timeoutPromise: Promise<SandboxHandlerResult> = new Promise((_, reject) => {
      timeoutHandle = runtimeTimers.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new SandboxTimeoutError(`Sandbox action "${request.action}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let handlerResult: SandboxHandlerResult | null = null;
    let caughtError: unknown = null;

    try {
      handlerResult = await (timeoutMs > 0 ? Promise.race([handlerPromise, timeoutPromise]) : handlerPromise);
    } catch (error) {
      caughtError = error;
    } finally {
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

    const result = handlerResult ?? { outcome: "success" as const };
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
export function getSandboxRegistry(): SandboxRegistry {
  return activeRegistry;
}

/**
 * Overrides the shared sandbox registry. Mainly used by integration tests that
 * need a deterministic set of handlers.
 */
export function setSandboxRegistry(registry: SandboxRegistry): SandboxRegistry {
  const previous = activeRegistry;
  activeRegistry = registry;
  return previous;
}

/**
 * Convenience helper used by production code when the caller does not need to
 * interact with a custom registry instance.
 */
export async function runSandboxAction(request: {
  action: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<SandboxExecutionResult> {
  return activeRegistry.execute(request);
}

function normaliseHandlerResult(value: SandboxHandlerResult | void): SandboxHandlerResult {
  if (!value) {
    return { outcome: "success" };
  }
  if (value.outcome !== "success" && value.outcome !== "failure") {
    return { outcome: "success" };
  }
  return value;
}

function normaliseMetrics(metrics?: Record<string, number>): Record<string, number> | undefined {
  if (!metrics || typeof metrics !== "object") {
    return undefined;
  }
  const filtered: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function normaliseTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return 2_000;
  }
  return Math.min(timeout, 60_000);
}

function cloneRecord(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const clone = cloneValue(metadata);
  return freezeDeep(clone);
}

function normaliseError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  const message = typeof error === "string" ? error : JSON.stringify(error);
  return { name: "SandboxError", message };
}

// -- Internal helpers -----------------------------------------------------

function cloneValue<T>(value: T): T;
function cloneValue(value: unknown): unknown {
  const structuredCloneFn: (<K>(value: K) => K) | undefined =
    typeof globalThis.structuredClone === "function"
      ? (globalThis.structuredClone as <K>(val: K) => K)
      : undefined;

  if (structuredCloneFn) {
    try {
      return structuredCloneFn(value);
    } catch (error) {
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
    return new Map(Array.from(value.entries(), ([key, entry]) => [key, cloneValue(entry)] as const));
  }

  if (value instanceof Set) {
    return new Set(Array.from(value.values(), (entry) => cloneValue(entry)));
  }

  const clone: Record<string | symbol, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneValue(entry);
  }
  return clone;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      freezeDeep(entry);
    }
  } else if (value instanceof Map || value instanceof Set) {
    for (const entry of value.values()) {
      freezeDeep(entry);
    }
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursive walk across arbitrary payloads
      freezeDeep((value as Record<string, any>)[key]);
    }
  }

  return Object.freeze(value);
}
