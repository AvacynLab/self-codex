import { GraphModel } from "../model.js";
import {
  EdgeCostDescriptor,
  EdgeCostEvaluator,
  buildEdgeCostEvaluator,
} from "./dijkstra.js";

export interface BetweennessCentralityOptions {
  /**
   * Whether the computation should account for weighted edges. When enabled the
   * `weightAttribute` (or `costFunction`) will be used to evaluate every edge
   * cost during the internal single-source shortest path traversals.
   */
  readonly weighted?: boolean;
  /**
   * Name of the edge attribute that stores the weight used during weighted
   * traversals.
   */
  readonly weightAttribute?: string;
  /**
   * Optional custom edge cost evaluator (or descriptor) used when
   * `weighted=true`. Defaults to the `weightAttribute`.
   */
  readonly costFunction?: EdgeCostEvaluator | EdgeCostDescriptor | string;
  /**
   * Normalise the resulting betweenness scores by the number of possible
   * ordered node pairs. This keeps the scores within [0, 1] for simple graphs
   * which helps comparing graphs of different sizes.
   */
  readonly normalise?: boolean;
}

export interface BetweennessCentralityScore {
  readonly node: string;
  readonly score: number;
}

/**
 * Compute the betweenness centrality for every node using Brandes' algorithm.
 * The implementation supports both unweighted and weighted graphs with
 * non-negative edge costs.
 */
export function betweennessCentrality(
  graph: GraphModel,
  options: BetweennessCentralityOptions = {},
): BetweennessCentralityScore[] {
  const nodes = graph.listNodes();
  const nodeIds = nodes.map((node) => node.id);
  const scores = new Map<string, number>();
  for (const id of nodeIds) {
    scores.set(id, 0);
  }

  const useWeights = options.weighted === true;
  const weightKey = options.weightAttribute ?? "weight";
  const evaluator = useWeights ? buildEdgeCostEvaluator(graph, weightKey, options.costFunction) : null;

  for (const source of nodeIds) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const distance = new Map<string, number>();

    for (const id of nodeIds) {
      predecessors.set(id, []);
      sigma.set(id, 0);
      distance.set(id, Number.POSITIVE_INFINITY);
    }
    sigma.set(source, 1);
    distance.set(source, 0);

    if (useWeights) {
      runWeightedSearch(graph, source, evaluator!, stack, predecessors, sigma, distance);
    } else {
      runUnweightedSearch(graph, source, stack, predecessors, sigma, distance);
    }

    const delta = new Map<string, number>();
    for (const id of nodeIds) {
      delta.set(id, 0);
    }

    while (stack.length) {
      const w = stack.pop()!;
      const wSigma = sigma.get(w)!;
      for (const v of predecessors.get(w) ?? []) {
        const share = (sigma.get(v)! / wSigma) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + share);
      }
      if (w !== source) {
        scores.set(w, (scores.get(w) ?? 0) + (delta.get(w) ?? 0));
      }
    }
  }

  if (options.normalise) {
    const n = nodeIds.length;
    if (n > 2) {
      const factor = 1 / ((n - 1) * (n - 2));
      for (const id of nodeIds) {
        scores.set(id, (scores.get(id) ?? 0) * factor);
      }
    }
  }

  return nodeIds.map((id) => ({ node: id, score: scores.get(id) ?? 0 }));
}

function runUnweightedSearch(
  graph: GraphModel,
  source: string,
  stack: string[],
  predecessors: Map<string, string[]>,
  sigma: Map<string, number>,
  distance: Map<string, number>,
): void {
  const queue: string[] = [];
  queue.push(source);

  while (queue.length) {
    const v = queue.shift()!;
    stack.push(v);
    for (const edge of graph.getOutgoing(v)) {
      const nextDistance = distance.get(v)! + 1;
      const currentDistance = distance.get(edge.to)!;
      if (nextDistance < currentDistance) {
        distance.set(edge.to, nextDistance);
        queue.push(edge.to);
        sigma.set(edge.to, sigma.get(v)!);
        predecessors.set(edge.to, [v]);
      } else if (nextDistance === currentDistance) {
        sigma.set(edge.to, (sigma.get(edge.to) ?? 0) + (sigma.get(v) ?? 0));
        const existing = predecessors.get(edge.to)!;
        if (!existing.includes(v)) {
          existing.push(v);
        }
      }
    }
  }
}

interface WeightedQueueEntry {
  readonly node: string;
  readonly priority: number;
}

function runWeightedSearch(
  graph: GraphModel,
  source: string,
  evaluator: EdgeCostEvaluator,
  stack: string[],
  predecessors: Map<string, string[]>,
  sigma: Map<string, number>,
  distance: Map<string, number>,
): void {
  const queue: WeightedQueueEntry[] = [];
  queue.push({ node: source, priority: 0 });

  while (queue.length) {
    queue.sort((a, b) => a.priority - b.priority);
    const current = queue.shift()!;
    const v = current.node;
    if ((distance.get(v) ?? Number.POSITIVE_INFINITY) < current.priority) {
      continue;
    }
    stack.push(v);

    for (const edge of graph.getOutgoing(v)) {
      const weight = evaluator(edge, graph);
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error("Betweenness centrality requires non-negative edge weights");
      }
      const tentative = (distance.get(v) ?? Number.POSITIVE_INFINITY) + weight;
      const targetDistance = distance.get(edge.to)!;
      const epsilon = 1e-9;
      if (tentative + epsilon < targetDistance) {
        distance.set(edge.to, tentative);
        queue.push({ node: edge.to, priority: tentative });
        sigma.set(edge.to, sigma.get(v)!);
        predecessors.set(edge.to, [v]);
      } else if (Math.abs(tentative - targetDistance) <= epsilon) {
        sigma.set(edge.to, (sigma.get(edge.to) ?? 0) + (sigma.get(v) ?? 0));
        const existing = predecessors.get(edge.to)!;
        if (!existing.includes(v)) {
          existing.push(v);
        }
      }
    }
  }
}
