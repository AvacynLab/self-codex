import { GraphComputationCache } from "../../graph/cache.js";
import { loadGraphForge } from "../../graph/forgeLoader.js";
import type { NormalisedGraph } from "../../graph/types.js";
import type {
  GraphModel as GraphForgeModelInstance,
  EdgeCostDescriptor as ForgeEdgeCostDescriptor,
  ConstrainedPathResult as ForgeConstrainedPathResult,
} from "graph-forge/dist/index.js";

/** Edge cost descriptor re-exported from Graph Forge for typed callers. */
export type GraphForgeEdgeCostDescriptor = ForgeEdgeCostDescriptor;
/** Result returned by the constrained shortest path helper. */
export type GraphForgeConstrainedResult = ForgeConstrainedPathResult;

export const computationCache = new GraphComputationCache(128);

const {
  GraphModel,
  betweennessCentrality,
  kShortestPaths,
  constrainedShortestPath,
} = await loadGraphForge();

export { GraphModel, betweennessCentrality, constrainedShortestPath, kShortestPaths };

export function withCachedComputation<T>(
  descriptor: NormalisedGraph,
  operation: string,
  variant: unknown,
  compute: () => T,
): T {
  const cached = computationCache.get<T>(descriptor.graphId, descriptor.graphVersion, operation, variant);
  if (cached !== undefined) {
    return cached;
  }
  const result = compute();
  computationCache.set(descriptor.graphId, descriptor.graphVersion, operation, variant, result);
  return result;
}

export function descriptorToGraphModel(descriptor: NormalisedGraph): GraphForgeModelInstance {
  return new GraphModel(
    descriptor.name,
    descriptor.nodes.map((node) => ({ id: node.id, attributes: { ...node.attributes } })),
    descriptor.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      attributes: {
        ...edge.attributes,
        ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
      },
    })),
    new Map(Object.entries(descriptor.metadata)),
  );
}

