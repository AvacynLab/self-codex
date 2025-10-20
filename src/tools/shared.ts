/**
 * Utility helpers shared across tooling modules. Extracted from legacy monoliths
 * so that graph and plan tooling can reuse common behaviours without depending
 * on giant files again.
 */

/** Deduplicate a list of strings while preserving the first occurrence order. */
export function dedupeStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/**
 * Trim entries, drop blanks and return a set when at least one value survives.
 * Returning `undefined` keeps optional parameters ergonomic for callers.
 */
export function toTrimmedStringSet(values?: Iterable<string>): Set<string> | undefined {
  if (!values) {
    return undefined;
  }
  const trimmed = new Set<string>();
  for (const value of values) {
    const normalised = value.trim();
    if (normalised.length > 0) {
      trimmed.add(normalised);
    }
  }
  return trimmed.size > 0 ? trimmed : undefined;
}

/**
 * Same as {@link toTrimmedStringSet} but expose an array for callers that rely
 * on deterministic ordering when serialising payloads.
 */
export function toTrimmedStringList(values?: Iterable<string>): string[] | null {
  const set = toTrimmedStringSet(values);
  if (!set) {
    return null;
  }
  return Array.from(set);
}

