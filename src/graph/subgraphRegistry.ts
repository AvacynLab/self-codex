import type { HierGraph } from "./hierarchy.js";
import type { NormalisedGraph, GraphAttributeValue } from "./types.js";
import type { GraphDescriptorPayload } from "../tools/graph/snapshot.js";

/**
 * Metadata key storing the registry of hierarchical sub-graphs referenced by
 * normalised plans. Keeping the constant centralised avoids hard-coded strings
 * across modules and simplifies migrations.
 */
export const SUBGRAPH_REGISTRY_KEY = "hierarchy:subgraphs";

/** Descriptor persisted alongside a sub-graph entry inside the registry. */
export interface SubgraphDescriptor {
  graph: HierGraph | NormalisedGraph;
  entryPoints?: string[];
  exitPoints?: string[];
}

/** Mapping between sub-graph references and their descriptors. */
export type SubgraphRegistry = Map<string, SubgraphDescriptor>;

/**
 * Parse a registry serialised in the graph metadata. The helper gracefully
 * tolerates malformed payloads by returning `null` so callers can surface
 * actionable diagnostics.
 */
export function parseSubgraphRegistry(
  value: GraphAttributeValue | undefined,
): SubgraphRegistry | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, SubgraphDescriptor>;
    const registry: SubgraphRegistry = new Map();
    for (const [key, descriptor] of Object.entries(parsed)) {
      if (!descriptor || typeof descriptor !== "object") {
        continue;
      }
      registry.set(key, descriptor);
    }
    return registry;
  } catch {
    return null;
  }
}

/**
 * Serialise a registry so it can be persisted back into the graph metadata.
 */
export function stringifySubgraphRegistry(registry: SubgraphRegistry): string {
  const serialisable: Record<string, SubgraphDescriptor> = {};
  for (const [key, descriptor] of registry.entries()) {
    serialisable[key] = descriptor;
  }
  return JSON.stringify(serialisable);
}

/**
 * Collect the references of every node flagged as a sub-graph.
 */
export function collectSubgraphReferences(
  graph: Pick<GraphDescriptorPayload | NormalisedGraph, "nodes">,
): Set<string> {
  const refs = new Set<string>();
  for (const node of graph.nodes) {
    const attributes = (node as { attributes?: Record<string, unknown> }).attributes;
    if (!attributes) {
      continue;
    }
    if (attributes.kind !== "subgraph") {
      continue;
    }
    const ref =
      typeof attributes.ref === "string"
        ? attributes.ref
        : typeof attributes.subgraph_ref === "string"
          ? attributes.subgraph_ref
          : null;
    if (ref) {
      refs.add(ref);
    }
  }
  return refs;
}

/**
 * Determine which sub-graph references currently lack a descriptor entry.
 */
export function collectMissingSubgraphDescriptors(
  graph: Pick<GraphDescriptorPayload | NormalisedGraph, "nodes" | "metadata">,
): string[] {
  const refs = collectSubgraphReferences(graph);
  if (refs.size === 0) {
    return [];
  }
  const metadata = graph.metadata as Record<string, GraphAttributeValue> | undefined;
  const registry = parseSubgraphRegistry(metadata?.[SUBGRAPH_REGISTRY_KEY]);
  if (!registry) {
    return Array.from(refs);
  }
  const missing: string[] = [];
  for (const ref of refs) {
    if (!registry.has(ref)) {
      missing.push(ref);
    }
  }
  return missing;
}

/**
 * Fetch a descriptor from the registry, returning `null` when the reference is
 * unknown or the registry cannot be parsed.
 */
export function resolveSubgraphDescriptor(
  graph: Pick<GraphDescriptorPayload | NormalisedGraph, "metadata">,
  ref: string,
): SubgraphDescriptor | null {
  const metadata = graph.metadata as Record<string, GraphAttributeValue> | undefined;
  const registry = parseSubgraphRegistry(metadata?.[SUBGRAPH_REGISTRY_KEY]);
  if (!registry) {
    return null;
  }
  return registry.get(ref) ?? null;
}
