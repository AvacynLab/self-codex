/**
 * Summary utilities dedicated to plan tooling. The helpers condense arbitrary
 * payloads into lightweight, JSON-serialisable structures so causal memory and
 * telemetry outputs remain readable without losing critical diagnostic signal.
 */
const MAX_STRING_PREVIEW_LENGTH = 200;
const ARRAY_PREVIEW_WINDOW = 5;
const OBJECT_PREVIEW_WINDOW = 6;
const MAX_RECURSION_DEPTH = 2;

/**
 * Truncates long strings so snapshots keep their context while avoiding
 * excessive payload sizes. The ellipsis mirrors the historical behaviour used
 * by {@link summariseForCausalMemory} before the refactor.
 */
function summariseStringForCausalMemory(value: string): string {
  if (value.length <= MAX_STRING_PREVIEW_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_PREVIEW_LENGTH)}…`;
}

/**
 * Produces a bounded preview for arrays. Only the first
 * {@link ARRAY_PREVIEW_WINDOW} entries are summarised recursively while the
 * helper appends a sentinel when additional values were omitted.
 */
function summariseArrayForCausalMemory(values: readonly unknown[], depth: number): unknown {
  if (depth >= MAX_RECURSION_DEPTH) {
    return `array(${values.length})`;
  }

  const preview = values
    .slice(0, ARRAY_PREVIEW_WINDOW)
    .map((entry) => summariseForCausalMemory(entry, depth + 1));

  if (values.length === 1 && Array.isArray(values[0])) {
    const [onlyPreview] = preview;
    if (typeof onlyPreview === "string" && onlyPreview.startsWith("array(")) {
      return onlyPreview;
    }
  }

  if (values.length > ARRAY_PREVIEW_WINDOW) {
    preview.push(`…${values.length - ARRAY_PREVIEW_WINDOW} more`);
  }
  return preview;
}

/**
 * Produces a bounded preview for object records. The function intentionally
 * mirrors the previous inline logic to maintain identical summaries for
 * dashboards and persisted artefacts.
 */
function summariseObjectForCausalMemory(value: Record<string, unknown>, depth: number): unknown {
  if (depth >= MAX_RECURSION_DEPTH) {
    return "object";
  }

  const entries = Object.entries(value);
  const summary: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, OBJECT_PREVIEW_WINDOW)) {
    summary[key] = summariseForCausalMemory(entry, depth + 1);
  }
  if (entries.length > OBJECT_PREVIEW_WINDOW) {
    summary.__truncated__ = `${entries.length - OBJECT_PREVIEW_WINDOW} more`;
  }
  return summary;
}

/**
 * Produces a compact JSON-serialisable summary suitable for causal memory
 * storage. Large strings are truncated and deep structures are collapsed to
 * keep artefacts lightweight while preserving actionable hints for operators.
 */
export function summariseForCausalMemory(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return summariseStringForCausalMemory(value);
  }

  if (typeof value === "undefined") {
    return null;
  }

  if (Array.isArray(value)) {
    return summariseArrayForCausalMemory(value, depth);
  }

  if (value !== null && typeof value === "object") {
    return summariseObjectForCausalMemory(value as Record<string, unknown>, depth);
  }

  return String(value);
}

