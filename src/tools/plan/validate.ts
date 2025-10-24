/**
 * Groups the shared validation helpers for plan tooling so the orchestration
 * layer can stay focused on execution flow while delegating input sanitation
 * and correlation normalisation to a dedicated module.
 */
import type { EventCorrelationHints } from "../../events/correlation.js";
import type { ValueGraphCorrelationHints, ValueImpactInput } from "../../values/valueGraph.js";

/** Shape accepted by {@link normalisePlanImpact} before it becomes guard input. */
export interface PlanNodeImpactDraft {
  value: string;
  impact: ValueImpactInput["impact"];
  severity?: number | undefined;
  rationale?: string | undefined;
  source?: string | undefined;
  node_id?: string | undefined;
  nodeId?: string | undefined;
}

/** Optional correlation metadata supplied by clients when invoking plan tools. */
export interface PlanCorrelationHintsCandidate {
  run_id?: string | undefined;
  op_id?: string | undefined;
  job_id?: string | undefined;
  graph_id?: string | undefined;
  node_id?: string | undefined;
  child_id?: string | undefined;
}

/**
 * Normalises an impact payload so it matches {@link ValueImpactInput} while
 * preserving any correlation metadata declared on the plan node.
 */
export function normalisePlanImpact(
  impact: PlanNodeImpactDraft,
  fallbackNodeId: string | undefined,
): ValueImpactInput {
  const derivedNodeId = impact.nodeId ?? impact.node_id ?? fallbackNodeId;
  const sanitisedImpact: ValueImpactInput = {
    value: impact.value,
    impact: impact.impact,
    ...(impact.severity !== undefined ? { severity: impact.severity } : {}),
    ...(impact.rationale !== undefined ? { rationale: impact.rationale } : {}),
    ...(impact.source !== undefined ? { source: impact.source } : {}),
  };

  if (derivedNodeId !== undefined) {
    // Preserve explicit node correlations while avoiding `nodeId: undefined`
    // entries so value guard payloads stay compatible with
    // `exactOptionalPropertyTypes`.
    sanitisedImpact.nodeId = derivedNodeId;
  }

  return sanitisedImpact;
}

/**
 * Convert correlation hints provided by plan tooling into the camel-cased
 * structure consumed by downstream value guard and event bus helpers.
 */
export function extractPlanCorrelationHints(
  input: PlanCorrelationHintsCandidate,
): ValueGraphCorrelationHints | null {
  const hints: ValueGraphCorrelationHints = {};
  if (input.run_id !== undefined) hints.runId = input.run_id;
  if (input.op_id !== undefined) hints.opId = input.op_id;
  if (input.job_id !== undefined) hints.jobId = input.job_id;
  if (input.graph_id !== undefined) hints.graphId = input.graph_id;
  if (input.node_id !== undefined) hints.nodeId = input.node_id;
  if (input.child_id !== undefined) hints.childId = input.child_id;

  return Object.keys(hints).length > 0 ? hints : null;
}

/**
 * Convert plan-level correlation hints into the event-centric structure consumed by
 * the unified MCP bus. Keeping the mapping centralised ensures every tool uses the
 * same normalisation (notably the preservation of explicit `null` values).
 */
export function toEventCorrelationHints(
  hints: ValueGraphCorrelationHints | null | undefined,
): EventCorrelationHints {
  const correlation: EventCorrelationHints = {};
  if (!hints) {
    return correlation;
  }
  if (hints.runId !== undefined) correlation.runId = hints.runId;
  if (hints.opId !== undefined) correlation.opId = hints.opId;
  if (hints.jobId !== undefined) correlation.jobId = hints.jobId;
  if (hints.graphId !== undefined) correlation.graphId = hints.graphId;
  if (hints.nodeId !== undefined) correlation.nodeId = hints.nodeId;
  if (hints.childId !== undefined) correlation.childId = hints.childId;
  return correlation;
}

/**
 * Serialise correlation hints with snake_case keys for event payloads and logs.
 * The helper mirrors {@link toEventCorrelationHints} so call sites can reuse the
 * same structure without hand-crafting objects repeatedly.
 */
export function serialiseCorrelationForPayload(
  hints: EventCorrelationHints,
): {
  run_id: string | null;
  op_id: string | null;
  job_id: string | null;
  graph_id: string | null;
  node_id: string | null;
  child_id: string | null;
} {
  return {
    run_id: hints.runId ?? null,
    op_id: hints.opId ?? null,
    job_id: hints.jobId ?? null,
    graph_id: hints.graphId ?? null,
    node_id: hints.nodeId ?? null,
    child_id: hints.childId ?? null,
  };
}
