import { GraphEdgeData, GraphModel } from "../model.js";
import {
  DijkstraResult,
  EdgeCostDescriptor,
  EdgeCostEvaluator,
  buildEdgeCostEvaluator,
  shortestPath,
} from "./dijkstra.js";

export interface YenKShortestPathOptions {
  /**
   * Name of the edge attribute used as the default weight when no custom cost
   * function is provided.
   */
  readonly weightAttribute?: string;
  /**
   * Optional custom edge cost evaluator (or descriptor) used by the internal
   * Dijkstra runs. When omitted the `weightAttribute` will be read on every
   * edge and default to 1 when missing.
   */
  readonly costFunction?: EdgeCostEvaluator | EdgeCostDescriptor | string;
  /**
   * Maximum tolerated absolute deviation from the best path cost. When
   * provided only the paths whose total weight is within this threshold will
   * be returned.
   */
  readonly maxDeviation?: number;
}

export interface YenKShortestPathResult extends DijkstraResult {}

/**
 * Compute the `k` loop-less shortest paths between the provided start and goal
 * nodes using Yen's algorithm. The algorithm relies on repeated Dijkstra
 * searches and therefore only supports non-negative edge weights.
 */
export function kShortestPaths(
  graph: GraphModel,
  start: string,
  goal: string,
  k: number,
  options: YenKShortestPathOptions = {},
): YenKShortestPathResult[] {
  if (k <= 0) {
    throw new Error("k must be greater than zero");
  }
  const weightKey = options.weightAttribute ?? "weight";
  const evaluator = buildEdgeCostEvaluator(graph, weightKey, options.costFunction);

  const initial = shortestPath(graph, start, goal, { weightAttribute: weightKey, costFunction: evaluator });
  if (!initial.path.length) {
    return [];
  }

  const results: YenKShortestPathResult[] = [initial];
  const candidates: { path: string[]; cost: number }[] = [];

  for (let index = 1; index < k; index += 1) {
    const lastPath = results[index - 1];
    for (let spurIndex = 0; spurIndex < lastPath.path.length - 1; spurIndex += 1) {
      const spurNode = lastPath.path[spurIndex];
      const rootPath = lastPath.path.slice(0, spurIndex + 1);

      const removedEdges: GraphEdgeData[] = [];
      for (const path of results) {
        if (prefixEquals(path.path, rootPath)) {
          const edge = getEdge(graph, path.path[spurIndex], path.path[spurIndex + 1]);
          if (edge) {
            removedEdges.push(edge);
          }
        }
      }

      const pruned = pruneEdges(graph, removedEdges);
      const spurPath = shortestPath(pruned, spurNode, goal, {
        weightAttribute: weightKey,
        costFunction: (edge, model) => evaluator(edge, model),
      });
      if (!spurPath.path.length) {
        continue;
      }

      const totalPath = rootPath.slice(0, -1).concat(spurPath.path);
      if (hasPath(results, totalPath) || hasCandidate(candidates, totalPath)) {
        continue;
      }

      const cost = computeCost(graph, totalPath, evaluator);
      candidates.push({ path: totalPath, cost });
    }

    if (!candidates.length) {
      break;
    }

    candidates.sort((a, b) => a.cost - b.cost);
    const best = candidates.shift()!;
    results.push({ distance: best.cost, path: best.path, visitedOrder: [] });
  }

  const deviation = options.maxDeviation ?? Number.POSITIVE_INFINITY;
  if (Number.isFinite(deviation)) {
    const baseline = results[0]?.distance ?? 0;
    return results.filter((path) => path.distance - baseline <= deviation);
  }
  return results;
}

function pruneEdges(graph: GraphModel, edges: GraphEdgeData[]): GraphModel {
  if (!edges.length) {
    return graph;
  }
  const removed = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));
  const filtered = graph.listEdges().filter((edge) => !removed.has(`${edge.from}->${edge.to}`));
  return new GraphModel(graph.name, graph.listNodes(), filtered, new Map(graph.directives));
}

function getEdge(graph: GraphModel, from: string, to: string): GraphEdgeData | undefined {
  return graph.getOutgoing(from).find((edge) => edge.to === to);
}

function computeCost(graph: GraphModel, path: string[], evaluator: EdgeCostEvaluator): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const edge = getEdge(graph, path[i], path[i + 1]);
    if (!edge) {
      return Number.POSITIVE_INFINITY;
    }
    total += evaluator(edge, graph);
  }
  return total;
}

function prefixEquals(fullPath: string[], prefix: string[]): boolean {
  if (prefix.length > fullPath.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (fullPath[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

function hasPath(collection: { path: string[] }[], candidate: string[]): boolean {
  return collection.some((entry) => arraysEqual(entry.path, candidate));
}

function hasCandidate(collection: { path: string[] }[], candidate: string[]): boolean {
  return collection.some((entry) => arraysEqual(entry.path, candidate));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
