/**
 * Centralises the log enrichment helpers used by the orchestrator runtime.
 *
 * Isolating the category resolution and tag normalisation logic keeps
 * `runtime.ts` focused on composition while offering tests a single location to
 * exercise logging behaviour without bootstrapping the entire runtime.
 */
import { EVENT_CATEGORIES, type EventCategory } from "../events/bus.js";
import { assertValidEventMessage, type EventMessage } from "../events/types.js";
import type { EventKind } from "../eventStore.js";

/**
 * Mapping from event kinds emitted by the orchestrator to the canonical log
 * categories consumed by dashboards and telemetry exporters. The mapping mirrors
 * the one that previously lived in {@link runtime.ts} but is extracted in order
 * to provide a focused, reusable module.
 */
const EVENT_KIND_TO_CATEGORY: Record<EventKind, EventCategory> = {
  PLAN: "graph",
  START: "graph",
  PROMPT: "child",
  PENDING: "child",
  REPLY_PART: "child",
  REPLY: "child",
  STATUS: "graph",
  AGGREGATE: "graph",
  KILL: "scheduler",
  HEARTBEAT: "scheduler",
  INFO: "graph",
  WARN: "graph",
  ERROR: "graph",
  BT_RUN: "bt",
  SCHEDULER: "scheduler",
  AUTOSCALER: "scheduler",
  COGNITIVE: "child",
  HTTP_ACCESS: "graph",
};

const EVENT_CATEGORY_SET = new Set<EventCategory>(EVENT_CATEGORIES);

/**
 * Normalises optional tags originating from downstream payloads. The helper
 * trims surrounding whitespace and converts empty strings to `null` so callers
 * can easily fall back to deterministic defaults.
 */
export function normaliseTag(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Attempts to derive the final component label associated with an event. The
 * first candidate that resolves to a meaningful tag wins, otherwise the
 * category acts as the canonical fallback.
 */
export function resolveEventComponent(
  category: EventCategory,
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const normalised = normaliseTag(candidate ?? null);
    if (normalised) {
      return normalised;
    }
  }
  return category;
}

/**
 * Resolves the stage associated with an event by probing optional payload
 * fields before falling back to the event kind or message. The return value is
 * always a lower-case tag suitable for dashboards.
 */
export function resolveEventStage(
  kind: string,
  message: string,
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const normalised = normaliseTag(candidate ?? null);
    if (normalised) {
      return normalised;
    }
  }
  const fallback = normaliseTag(kind.toLowerCase()) ?? normaliseTag(message) ?? "event";
  return fallback;
}

/**
 * Collects the first elapsed time candidate expressed either as a number or as
 * a numeric string. Negative values are clamped to zero so latency charts do
 * not render misleading spikes.
 */
export function resolveEventElapsedMs(
  ...candidates: Array<number | null | undefined>
): number | null {
  for (const candidate of candidates) {
    if (candidate === null) {
      return null;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.round(candidate));
    }
  }
  return null;
}

/**
 * Extracts the message associated with an event. When no catalogue-backed
 * message is found the helper falls back to the lower-cased kind while still
 * honouring the validation enforced by {@link assertValidEventMessage}.
 */
export function deriveEventMessage(kind: EventKind, payload: unknown): EventMessage {
  const msg = extractStringProperty(payload, "msg");
  if (msg) {
    assertValidEventMessage(msg);
    return msg;
  }
  const fallback = kind.toLowerCase() as Lowercase<EventKind>;
  assertValidEventMessage(fallback);
  return fallback;
}

/**
 * Maps an event kind to the canonical category used by dashboards and log
 * routers. Unknown kinds default to the `graph` family which matches the legacy
 * behaviour.
 */
export function deriveEventCategory(kind: EventKind): EventCategory {
  return EVENT_KIND_TO_CATEGORY[kind] ?? "graph";
}

/**
 * Parses the optional category overrides provided by callers. Only recognised
 * categories survive the filtering step and duplicates are removed in the
 * process.
 */
export function parseEventCategories(values: readonly string[] | undefined): EventCategory[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const collected: EventCategory[] = [];
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || !EVENT_CATEGORY_SET.has(trimmed as EventCategory)) {
      continue;
    }
    const category = trimmed as EventCategory;
    if (!collected.includes(category)) {
      collected.push(category);
    }
  }
  return collected.length > 0 ? collected : undefined;
}

/**
 * Normalises child runtime streams to the log levels expected by the
 * orchestrator. The mapping is intentionally conservative so that stderr is
 * always elevated to `error` while metadata channels remain `debug`.
 */
export function resolveChildLogLevel(stream: "stdout" | "stderr" | "meta"): string {
  switch (stream) {
    case "stderr":
      return "error";
    case "meta":
      return "debug";
    default:
      return "info";
  }
}

/**
 * Extracts a string property from an arbitrary payload. Empty strings collapse
 * to `null` which simplifies the orchestration code when it computes fallbacks.
 */
export function extractStringProperty(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function extractStringCandidate(payload: unknown, keys: readonly string[]): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      return null;
    }
  }
  return null;
}

/** Returns the run identifier extracted from an event payload when present. */
export function extractRunId(payload: unknown): string | null {
  return extractStringProperty(payload, "run_id");
}

/** Returns the operation identifier extracted from an event payload when present. */
export function extractOpId(payload: unknown): string | null {
  return extractStringProperty(payload, "op_id") ?? extractStringProperty(payload, "operation_id");
}

/** Returns the graph identifier extracted from an event payload when present. */
export function extractGraphId(payload: unknown): string | null {
  return extractStringProperty(payload, "graph_id") ?? null;
}

/** Returns the node identifier extracted from an event payload when present. */
export function extractNodeId(payload: unknown): string | null {
  return extractStringProperty(payload, "node_id") ?? null;
}

/** Returns the child identifier extracted from an event payload when present. */
export function extractChildId(payload: unknown): string | null {
  return extractStringProperty(payload, "child_id") ?? null;
}

/** Returns the job identifier extracted from an event payload when present. */
export function extractJobId(payload: unknown): string | null {
  return extractStringProperty(payload, "job_id") ?? null;
}

/**
 * Looks up the most descriptive component tag available in the payload. The
 * helper accounts for historical field names so existing emitters continue to
 * work unchanged.
 */
export function extractComponentTag(payload: unknown): string | null {
  return (
    extractStringCandidate(payload, ["component", "component_id", "componentId", "origin", "source_component"]) ??
    null
  );
}

/** Returns the most suitable stage tag exposed by the payload. */
export function extractStageTag(payload: unknown): string | null {
  return extractStringCandidate(payload, ["stage", "phase", "status", "state"]);
}

/**
 * Extracts a positive elapsed time expressed either as a number or as a string.
 * When the payload explicitly reports `null` the helper preserves the value so
 * downstream logic can distinguish between “unknown” and “explicitly missing”.
 */
export function extractElapsedMilliseconds(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const keys = ["elapsed_ms", "elapsedMs", "duration_ms", "durationMs", "latency_ms", "latencyMs"];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.round(parsed));
      }
    }
  }
  return null;
}
