import { z } from "zod";

import type { CausalExplanation, CausalEventSnapshot } from "../knowledge/causalMemory.js";
import { CausalMemory } from "../knowledge/causalMemory.js";
import { StructuredLogger } from "../logger.js";

/** Context injected by the server when invoking causal memory tools. */
export interface CausalToolContext {
  /** Shared causal memory capturing runtime executions. */
  causalMemory: CausalMemory;
  /** Structured logger recording tool usage. */
  logger: StructuredLogger;
}

/** Schema validating the payload accepted by the `causal_export` tool. */
export const CausalExportInputSchema = z.object({}).strict();
export const CausalExportInputShape = CausalExportInputSchema.shape;

/** Schema validating the payload accepted by the `causal_explain` tool. */
export const CausalExplainInputSchema = z
  .object({
    outcome_id: z.string().min(1),
    max_depth: z.number().int().min(1).max(32).optional(),
  })
  .strict();
export const CausalExplainInputShape = CausalExplainInputSchema.shape;

/** Result returned by {@link handleCausalExport}. */
export interface CausalExportResult extends Record<string, unknown> {
  events: SerializedCausalEvent[];
  total: number;
}

/** Result returned by {@link handleCausalExplain}. */
export interface CausalExplainResult extends Record<string, unknown> {
  outcome: SerializedCausalEvent;
  ancestors: SerializedCausalEvent[];
  edges: CausalEdgePayload[];
  depth: number;
}

interface SerializedCausalEvent extends Record<string, unknown> {
  id: string;
  type: string;
  label: string | null;
  data: Record<string, unknown>;
  tags: string[];
  causes: string[];
  effects: string[];
  created_at: number;
  ordinal: number;
}

interface CausalEdgePayload extends Record<string, unknown> {
  from: string;
  to: string;
}

/** Dumps the entire causal memory for offline audits. */
export function handleCausalExport(
  context: CausalToolContext,
  _input: z.infer<typeof CausalExportInputSchema>,
): CausalExportResult {
  const events = context.causalMemory.exportAll().map(serializeEvent);
  context.logger.info("causal_export", { count: events.length });
  return { events, total: events.length };
}

/** Computes an explanation graph for a given outcome event. */
export function handleCausalExplain(
  context: CausalToolContext,
  input: z.infer<typeof CausalExplainInputSchema>,
): CausalExplainResult {
  const explanation = context.causalMemory.explain(input.outcome_id, { maxDepth: input.max_depth });
  context.logger.info("causal_explain", {
    outcome_id: input.outcome_id,
    ancestors: explanation.ancestors.length,
    depth: explanation.depth,
  });
  return serializeExplanation(explanation);
}

function serializeExplanation(explanation: CausalExplanation): CausalExplainResult {
  return {
    outcome: serializeEvent(explanation.outcome),
    ancestors: explanation.ancestors.map(serializeEvent),
    edges: explanation.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    depth: explanation.depth,
  };
}

function serializeEvent(snapshot: CausalEventSnapshot): SerializedCausalEvent {
  return {
    id: snapshot.id,
    type: snapshot.type,
    label: snapshot.label,
    data: snapshot.data,
    tags: [...snapshot.tags],
    causes: [...snapshot.causes],
    effects: [...snapshot.effects],
    created_at: snapshot.createdAt,
    ordinal: snapshot.ordinal,
  };
}
