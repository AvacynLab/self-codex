/**
 * Shared type definitions describing the normalised in-memory representation of
 * graphs handled by the orchestrator. Keeping the types centralised prevents
 * circular dependencies between the tooling modules and ensures the
 * optimisation/cache helpers can be reused easily inside tests.
 */

/** Allowed scalar attribute persisted on nodes/edges. */
export type GraphAttributeValue = string | number | boolean;

/** Normalised representation of a node within a graph. */
export interface GraphNodeRecord {
  id: string;
  label?: string;
  attributes: Record<string, GraphAttributeValue>;
}

/** Normalised representation of an edge within a graph. */
export interface GraphEdgeRecord {
  from: string;
  to: string;
  label?: string;
  weight?: number;
  attributes: Record<string, GraphAttributeValue>;
}

/**
 * Graph descriptor used once a payload has been validated by the zod schemata
 * in {@link src/tools/graphTools.ts}. The `graphId`/`graphVersion` fields allow
 * caches to invalidate their content deterministically when a mutation occurs.
 */
export interface NormalisedGraph {
  name: string;
  graphId: string;
  graphVersion: number;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  metadata: Record<string, GraphAttributeValue>;
}
