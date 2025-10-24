/**
 * Utility helpers operating on plain JavaScript objects.
 * Centralises sanitisation helpers reused by the orchestrator and the tests.
 * Every function remains pure so callers can rely on deterministic behaviour.
 */

/**
 * Returns a shallow copy of the provided record without any `undefined` values.
 *
 * The helper is useful when building objects that expose optional fields while
 * the inputs come from schemas that surface `undefined` explicitly (e.g. Zod).
 * By dropping those keys we keep the resulting objects compliant with
 * TypeScript's `exactOptionalPropertyTypes` semantics without having to mutate
 * them afterwards.
 */
export function omitUndefinedEntries<
  T extends Record<string, unknown | undefined>,
>(entries: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  const result: Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> = {};
  for (const key of Object.keys(entries) as (keyof T)[]) {
    const value = entries[key];
    if (value !== undefined) {
      (result as Record<keyof T, unknown>)[key] = value as Exclude<T[typeof key], undefined>;
    }
  }
  return result;
}

/**
 * Recursively drops `undefined` entries from plain JSON structures.
 *
 * The helper sanitises objects and arrays so artefacts persisted to disk never
 * contain `undefined` placeholders that would otherwise surface in regression
 * tests once `exactOptionalPropertyTypes` is enabled. Nested objects retain
 * their identity semantics whereas array entries with `undefined` values are
 * simply removed to preserve dense sequences for downstream consumers.
 */
/**
 * Type guard mirroring `Array.isArray` while keeping the type-system away from
 * `any[]`. Returning `unknown[]` ensures downstream transformations stay typed.
 */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Predicate used to remove undefined entries from array traversals. */
function isDefined<T>(value: T): value is Exclude<T, undefined> {
  return value !== undefined;
}

export function omitUndefinedDeep<T>(value: T): T {
  if (isArray(value)) {
    const compacted = value
      .map((entry) => omitUndefinedDeep(entry))
      .filter(isDefined);
    return compacted as typeof value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) {
      continue;
    }
    result[key] = omitUndefinedDeep(nested);
  }
  return result as T;
}

/**
 * Collapses nullable values to `undefined` so they can be omitted by
 * {@link omitUndefinedEntries}. This is useful when callers surface `null`
 * placeholders but downstream consumers expect properties to disappear
 * entirely when no concrete value is available.
 */
export function coerceNullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}
