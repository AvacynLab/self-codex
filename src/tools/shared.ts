/**
 * Utility helpers shared across tooling modules. Extracted from legacy monoliths
 * so that graph and plan tooling can reuse common behaviours without depending
 * on giant files again.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BudgetCharge } from "../infra/budget.js";

/** Structured payload type surfaced by MCP tool responses. */
type ToolStructuredContent = NonNullable<CallToolResult["structuredContent"]>;

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

/**
 * Helper used when building descriptor objects with optional fields. Returning
 * an empty object when the value is undefined avoids leaking `undefined`
 * placeholders while keeping call-sites expressive through spread syntax.
 */
export function withOptionalProperty<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as Record<K, V>;
}

/**
 * Clone a record only when it exists to guarantee callers keep defensive copy
 * semantics without paying allocations when inputs are absent.
 */
export function cloneDefinedRecord<T extends Record<string, unknown> | undefined>(
  source: T,
): T {
  if (!source) {
    return source;
  }
  return { ...source } as T;
}

/**
 * Parameters accepted by {@link buildToolResponse}. The helper expects callers
 * to pre-render the textual payload so each façade can keep its existing
 * `JSON.stringify` logic (tool name, indentation, localisation) without losing
 * the guarantee that the resulting MCP envelope shares a consistent shape.
 */
interface BuildToolResponseParams<TStructured extends ToolStructuredContent> {
  /** Pre-rendered textual payload exposed on the MCP textual channel. */
  readonly text: string;
  /** Structured JSON payload surfaced under `structuredContent`. */
  readonly structured: TStructured;
  /** Whether the invocation represents a transport-level error. */
  readonly isError: boolean;
}

/**
 * Normalises the `CallToolResult` emitted by façade handlers. Consolidating the
 * helper in one place removes subtle discrepancies across tools (missing
 * `isError`, shape variations in `content`) while keeping type-safety for the
 * structured payload forwarded to downstream clients.
 */
export function buildToolResponse<TStructured extends ToolStructuredContent>({
  text,
  structured,
  isError,
}: BuildToolResponseParams<TStructured>): CallToolResult & { structuredContent: TStructured } {
  return {
    isError,
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

/**
 * Convenience wrapper for {@link buildToolResponse} when the façade completed
 * successfully. Explicitly setting `isError: false` keeps the MCP payload
 * aligned across handlers and simplifies assertions in integration tests.
 */
export function buildToolSuccessResult<TStructured extends ToolStructuredContent>(
  text: string,
  structured: TStructured,
): CallToolResult & { structuredContent: TStructured } {
  return buildToolResponse({ text, structured, isError: false });
}

/**
 * Convenience wrapper for {@link buildToolResponse} when the façade encountered
 * an application-level failure. The helper guarantees that every error emitted
 * by the orchestration layer sets `isError: true` and retains the structured
 * diagnostics expected by observability tooling.
 */
export function buildToolErrorResult<TStructured extends ToolStructuredContent>(
  text: string,
  structured: TStructured,
): CallToolResult & { structuredContent: TStructured } {
  return buildToolResponse({ text, structured, isError: true });
}

/**
 * Canonical shape exposed when façades want to surface the budget they consumed
 * during an invocation. Values are expressed using snake_case keys to remain
 * consistent with the rest of the JSON payload emitted by the tools.
 */
export interface NormalisedBudgetUsage {
  readonly time_ms?: number;
  readonly tokens?: number;
  readonly tool_calls?: number;
  readonly bytes_in?: number;
  readonly bytes_out?: number;
}

/**
 * Converts the raw {@link BudgetCharge} returned by the tracker into a compact
 * JSON payload. Dimensions that were not consumed are omitted to keep the
 * structured response under the declared `bytes_out` budget.
 */
export function formatBudgetUsage(charge: BudgetCharge | null | undefined): NormalisedBudgetUsage | undefined {
  if (!charge) {
    return undefined;
  }

  const snapshot: NormalisedBudgetUsage = {
    ...(charge.timeMs > 0 ? { time_ms: Math.round(charge.timeMs) } : {}),
    ...(charge.tokens > 0 ? { tokens: Math.round(charge.tokens) } : {}),
    ...(charge.toolCalls > 0 ? { tool_calls: Math.round(charge.toolCalls) } : {}),
    ...(charge.bytesIn > 0 ? { bytes_in: Math.round(charge.bytesIn) } : {}),
    ...(charge.bytesOut > 0 ? { bytes_out: Math.round(charge.bytesOut) } : {}),
  };

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

