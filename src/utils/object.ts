/**
 * Utility helpers operating on plain JavaScript objects.
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
