import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { writeJsonFile } from "./runSetup.js";
import type { JsonRpcCallOutcome } from "./introspection.js";

/**
 * Represents the high-level outcome of a single JSON-RPC call executed during
 * the introspection phase.  The structure intentionally captures only the
 * debugging signals we need for the validation report so the output remains
 * concise and human-readable.
 */
export interface IntrospectionCallSummary {
  /** Identifier supplied by the runner (e.g. `mcp_info`). */
  name: string;
  /** JSON-RPC method that was invoked. */
  method: string;
  /** HTTP status code observed during the request. */
  status: number;
  /** Total duration of the HTTP round-trip in milliseconds. */
  durationMs: number;
  /** Optional error payload returned by the MCP server (if any). */
  error?: unknown;
}

/**
 * Captures the analysis performed on the events returned by
 * `events_subscribe`.  The helper verifies whether sequence numbers are
 * strictly increasing and records a few sample events for manual inspection.
 */
export interface IntrospectionEventSummary {
  /** Total number of events included in the response. */
  total: number;
  /** First events returned by the server (up to three) for quick debugging. */
  samples: unknown[];
  /** Result of the monotonicity analysis applied to the `seq` field. */
  sequence: {
    /** Indicates whether at least one numeric sequence number was analysed. */
    analysed: boolean;
    /**
     * When sequence numbers are available, communicates whether they are
     * strictly increasing.  The value is `null` when no numeric `seq` field
     * could be extracted from the events.
     */
    monotonic: boolean | null;
    /** First numeric sequence value encountered (if any). */
    first?: number;
    /** Last numeric sequence value encountered (if any). */
    last?: number;
    /**
     * Detailed list of anomalies encountered while scanning the events.  The
     * helper records the offending index, the previous `seq` value (if known),
     * and the current value that violated the monotonic contract.  Missing or
     * non-numeric `seq` fields are surfaced with a `current` value of `null`.
     */
    violations: Array<{
      index: number;
      previous: number | null;
      current: number | null;
    }>;
  };
}

/**
 * Aggregated document written into `report/introspection_summary.json`.  The
 * file helps future agents understand what the MCP server advertised during the
 * introspection phase without having to manually inspect the raw JSONL logs.
 */
export interface IntrospectionSummaryDocument {
  /** Timestamp (ISO 8601) describing when the summary was generated. */
  generatedAt: string;
  /** One entry per JSON-RPC call executed by the introspection workflow. */
  calls: IntrospectionCallSummary[];
  /** Optional structured payload returned by `mcp_info`. */
  info?: unknown;
  /** Optional structured payload returned by `mcp_capabilities`. */
  capabilities?: unknown;
  /** Optional structured payload returned by `tools/list`. */
  tools?: unknown;
  /** Optional structured payload returned by `resources_list`. */
  resources?: unknown;
  /** Event-related diagnostics derived from the `events_subscribe` response. */
  events?: IntrospectionEventSummary;
}

/** Attempts to coerce a raw event into a numeric sequence number. */
function extractNumericSequence(event: unknown): number | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const candidate = (event as Record<string, unknown>).seq;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string") {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Computes statistics about a set of events returned by `events_subscribe`.
 *
 * The helper focuses on the monotonicity of the `seq` field because it is a
 * critical signal for downstream consumers that rely on event ordering.  Any
 * anomaly is recorded in the returned structure so the operator can escalate
 * issues with a precise reproduction.
 */
function analyseEventSequence(events: unknown[]): IntrospectionEventSummary["sequence"] {
  const violations: IntrospectionEventSummary["sequence"]["violations"] = [];
  let previousSeq: number | null = null;
  let firstSeq: number | undefined;
  let lastSeq: number | undefined;
  let hasNumericSequence = false;
  let monotonic = true;

  events.forEach((event, index) => {
    const currentSeq = extractNumericSequence(event);
    if (currentSeq === null) {
      violations.push({ index, previous: previousSeq, current: null });
      monotonic = false;
      return;
    }

    if (!hasNumericSequence) {
      firstSeq = currentSeq;
      lastSeq = currentSeq;
      previousSeq = currentSeq;
      hasNumericSequence = true;
      return;
    }

    if (previousSeq !== null && currentSeq <= previousSeq) {
      violations.push({ index, previous: previousSeq, current: currentSeq });
      monotonic = false;
    }

    previousSeq = currentSeq;
    lastSeq = currentSeq;
  });

  if (!hasNumericSequence) {
    return { analysed: false, monotonic: null, violations };
  }

  // Only surface boundary indices when monotonic tracking encountered numeric
  // values. This keeps the structure compatible with `exactOptionalPropertyTypes`.
  return {
    analysed: true,
    monotonic,
    ...(firstSeq !== undefined ? { first: firstSeq } : {}),
    ...(lastSeq !== undefined ? { last: lastSeq } : {}),
    violations,
  };
}

/** Safely extracts the `result` property from a JSON-RPC response body. */
function extractJsonRpcResult(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const envelope = body as Record<string, unknown>;
  const result = envelope.result;
  if (result && typeof result === "object") {
    return result as Record<string, unknown>;
  }

  return undefined;
}

/** Extracts the `error` object from a JSON-RPC response body when present. */
function extractJsonRpcError(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const envelope = body as Record<string, unknown>;
  return envelope.error;
}

/**
 * Builds the aggregated summary document from the raw introspection outcomes.
 *
 * The resulting object focuses on the key playbook artefacts so the validation
 * report can highlight the advertised capabilities without parsing the JSONL
 * files.  Event diagnostics are included when `events_subscribe` returned a
 * payload with an `events` array.
 */
export function buildIntrospectionSummary(outcomes: JsonRpcCallOutcome[]): IntrospectionSummaryDocument {
  const summary: IntrospectionSummaryDocument = {
    generatedAt: new Date().toISOString(),
    calls: outcomes.map((outcome) => {
      const error = extractJsonRpcError(outcome.check.response.body);

      return {
        name: outcome.call.name,
        method: outcome.call.method,
        status: outcome.check.response.status,
        durationMs: outcome.check.durationMs,
        // Only surface the optional error payload when the JSON-RPC response
        // explicitly included one. Leaving the property absent ensures we stay
        // compliant with `exactOptionalPropertyTypes` once the compiler flag is
        // fully enforced and avoids serialising meaningless `undefined` values.
        ...(error !== undefined ? { error } : {}),
      } satisfies IntrospectionCallSummary;
    }),
  };

  const outcomesByName = new Map<string, JsonRpcCallOutcome>();
  for (const outcome of outcomes) {
    outcomesByName.set(outcome.call.name, outcome);
  }

  const infoResult = extractJsonRpcResult(outcomesByName.get("mcp_info")?.check.response.body);
  if (infoResult !== undefined) {
    summary.info = infoResult;
  }

  const capabilitiesResult = extractJsonRpcResult(outcomesByName.get("mcp_capabilities")?.check.response.body);
  if (capabilitiesResult !== undefined) {
    summary.capabilities = capabilitiesResult;
  }

  const toolsResult = extractJsonRpcResult(outcomesByName.get("tools_list")?.check.response.body);
  if (toolsResult !== undefined) {
    summary.tools = toolsResult;
  }

  const resourcesResult = extractJsonRpcResult(outcomesByName.get("resources_list")?.check.response.body);
  if (resourcesResult !== undefined) {
    summary.resources = resourcesResult;
  }

  const eventsResult = extractJsonRpcResult(outcomesByName.get("events_subscribe")?.check.response.body);
  if (eventsResult) {
    const eventsValue = eventsResult.events;
    const eventsArray = Array.isArray(eventsValue) ? (eventsValue as unknown[]) : [];
    summary.events = {
      total: eventsArray.length,
      samples: eventsArray.slice(0, 3),
      sequence: analyseEventSequence(eventsArray),
    };
  }

  return summary;
}

/**
 * Persists the introspection summary under `report/introspection_summary.json`.
 *
 * The helper returns the absolute path to the generated file so CLI commands
 * can display a friendly pointer to the artefact.
 */
export async function persistIntrospectionSummary(
  runRoot: string,
  summary: IntrospectionSummaryDocument,
): Promise<string> {
  const targetPath = join(runRoot, "report", "introspection_summary.json");
  await writeJsonFile(targetPath, summary);
  return targetPath;
}
