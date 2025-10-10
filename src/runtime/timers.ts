import {
  clearInterval as nodeClearInterval,
  clearTimeout as nodeClearTimeout,
  setInterval as nodeSetInterval,
  setTimeout as nodeSetTimeout,
} from "node:timers";

/**
 * Handle returned by {@link runtimeSetTimeout}. The type mirrors the Node.js
 * timer handle so existing code (and tests) can keep calling `.ref()` or
 * `.unref()` when available. Fake timers replace the implementation at runtime
 * but we retain the nominal shape for type-safety.
 */
export type TimeoutHandle = ReturnType<typeof nodeSetTimeout>;

/** Handle returned by {@link runtimeSetInterval}. */
export type IntervalHandle = ReturnType<typeof nodeSetInterval>;

/**
 * Internal mapping of the built-in Node.js timer functions. Keeping them in a
 * dedicated object makes it trivial to reference the canonical implementations
 * when the global runtime does not expose compatible overrides.
 */
const fallbackTimers = {
  setTimeout: nodeSetTimeout,
  clearTimeout: nodeClearTimeout,
  setInterval: nodeSetInterval,
  clearInterval: nodeClearInterval,
} as const;

/**
 * Helper retrieving the timer function currently exposed by the runtime. When
 * libraries such as Sinon install fake timers, the overrides live on
 * {@link globalThis}. We detect them dynamically to ensure our orchestrator
 * cooperates with the deterministic scheduler used in the integration tests.
 */
function resolveTimer<K extends keyof typeof fallbackTimers>(key: K): (typeof fallbackTimers)[K] {
  const candidate = (globalThis as Record<string, unknown>)[key];
  if (typeof candidate === "function") {
    return candidate as (typeof fallbackTimers)[K];
  }
  return fallbackTimers[key];
}

/**
 * Schedule a timeout using the currently active timer implementation. This
 * indirection avoids capturing the native Node.js timers which would bypass
 * test doubles (e.g. Sinon fake timers) and lead to flakiness.
 */
export function runtimeSetTimeout(
  ...args: Parameters<typeof nodeSetTimeout>
): TimeoutHandle {
  const candidate = resolveTimer("setTimeout");
  if (candidate === fallbackTimers.setTimeout) {
    return candidate(...args);
  }
  return candidate.apply(globalThis, args);
}

/** Cancel a timeout using the runtime-aware implementation. */
export function runtimeClearTimeout(handle: TimeoutHandle | number): void {
  const candidate = resolveTimer("clearTimeout");
  if (candidate === fallbackTimers.clearTimeout) {
    candidate(handle as TimeoutHandle);
    return;
  }
  candidate.apply(globalThis, [handle]);
}

/**
 * Register a periodic interval using the runtime-aware implementation so fake
 * timers (and other scheduler shims) keep full control over the cadence.
 */
export function runtimeSetInterval(
  ...args: Parameters<typeof nodeSetInterval>
): IntervalHandle {
  const candidate = resolveTimer("setInterval");
  if (candidate === fallbackTimers.setInterval) {
    return candidate(...args);
  }
  return candidate.apply(globalThis, args);
}

/** Clear an interval using the runtime-aware implementation. */
export function runtimeClearInterval(handle: IntervalHandle | number): void {
  const candidate = resolveTimer("clearInterval");
  if (candidate === fallbackTimers.clearInterval) {
    candidate(handle as IntervalHandle);
    return;
  }
  candidate.apply(globalThis, [handle]);
}

/**
 * Convenience namespace exported so call-sites can import the helpers as a
 * cohesive unit (e.g. `runtimeTimers.setTimeout`). Keeping both named
 * functions and the grouped object eases code readability.
 */
export const runtimeTimers = {
  setTimeout: runtimeSetTimeout,
  clearTimeout: runtimeClearTimeout,
  setInterval: runtimeSetInterval,
  clearInterval: runtimeClearInterval,
} as const;

