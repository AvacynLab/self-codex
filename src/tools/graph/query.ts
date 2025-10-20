import { z } from "zod";

import { buildGraphAttributeIndex } from "../../graph/index.js";
import { partitionGraph, type GraphPartitionObjective } from "../../graph/partition.js";
import type { NormalisedGraph } from "../../graph/types.js";
import { resolveOperationId } from "../operationIds.js";
import {
  betweennessCentrality,
  constrainedShortestPath,
  descriptorToGraphModel,
  kShortestPaths,
  withCachedComputation,
  type GraphForgeEdgeCostDescriptor,
} from "./runtime.js";
import {
  GraphDescriptorPayload,
  GraphDescriptorSchema,
  normaliseDescriptor,
  serialiseDescriptor,
} from "./snapshot.js";

type NormalisedNode = NormalisedGraph["nodes"][number];
type NormalisedEdge = NormalisedGraph["edges"][number];

/** Input payload accepted by `graph_validate`. */
export const GraphValidateInputSchema = z.object({
  graph: GraphDescriptorSchema,
  strict_weights: z.boolean().optional(),
  cycle_limit: z.number().int().positive().max(100).default(20),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphValidateInputShape = GraphValidateInputSchema.shape;

export type GraphValidateInput = z.infer<typeof GraphValidateInputSchema>;

export interface GraphValidationIssue {
  code: string;
  message: string;
  nodes?: string[];
  edge?: { from: string; to: string };
  suggestion?: string;
}

export interface GraphValidateResult extends Record<string, unknown> {
  op_id: string;
  ok: boolean;
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
  metrics: {
    node_count: number;
    edge_count: number;
    entrypoints: string[];
    disconnected: string[];
  };
}

/** Validate graph structure and detect common modelling issues. */
export function handleGraphValidate(input: GraphValidateInput): GraphValidateResult {
  const opId = resolveOperationId(input.op_id, "graph_validate_op");
  const descriptor = normaliseDescriptor(input.graph);
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];

  const nodeIds = new Set<string>();
  for (const node of descriptor.nodes) {
    if (nodeIds.has(node.id)) {
      warnings.push({
        code: "DUPLICATE_NODE",
        message: `node '${node.id}' is defined multiple times`,
        nodes: [node.id],
        suggestion: "remove the duplicate definition or merge attributes",
      });
    }
    nodeIds.add(node.id);
  }

  const edgeKeys = new Map<string, number>();
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of descriptor.nodes) {
    incomingCount.set(node.id, 0);
    outgoingCount.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of descriptor.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      errors.push({
        code: "MISSING_NODE",
        message: `edge '${edge.from}' -> '${edge.to}' references an unknown node`,
        edge: { from: edge.from, to: edge.to },
        suggestion: "declare the missing node or fix the dependency",
      });
      continue;
    }

    const key = `${edge.from}->${edge.to}`;
    edgeKeys.set(key, (edgeKeys.get(key) ?? 0) + 1);
    if ((edgeKeys.get(key) ?? 0) > 1) {
      warnings.push({
        code: "DUPLICATE_EDGE",
        message: `edge '${edge.from}' -> '${edge.to}' is declared multiple times`,
        edge: { from: edge.from, to: edge.to },
        suggestion: "drop redundant edges to keep the graph simple",
      });
    }

    adjacency.get(edge.from)?.push(edge.to);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);

    const weight = edge.weight ?? Number(edge.attributes.weight ?? NaN);
    if (Number.isFinite(weight)) {
      if (input.strict_weights && weight <= 0) {
        errors.push({
          code: "INVALID_WEIGHT",
          message: `edge '${edge.from}' -> '${edge.to}' has non-positive weight (${weight})`,
          edge: { from: edge.from, to: edge.to },
          suggestion: "ensure weights are strictly positive when strict_weights=true",
        });
      } else if (weight < 0) {
        warnings.push({
          code: "NEGATIVE_WEIGHT",
          message: `edge '${edge.from}' -> '${edge.to}' has a negative weight (${weight})`,
          edge: { from: edge.from, to: edge.to },
          suggestion: "negative weights may break scheduling algorithms",
        });
      }
    }
  }

  const entrypoints = Array.from(nodeIds).filter((id) => (incomingCount.get(id) ?? 0) === 0);
  const reachable = new Set<string>();
  const queue: string[] = [...entrypoints];

  while (queue.length) {
    const node = queue.shift()!;
    if (reachable.has(node)) {
      continue;
    }
    reachable.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!reachable.has(next)) {
        queue.push(next);
      }
    }
  }

  const disconnected = Array.from(nodeIds).filter((id) => !reachable.has(id));

  if (entrypoints.length === 0) {
    warnings.push({
      code: "NO_ENTRYPOINT",
      message: "no entrypoint detected (every node has incoming edges)",
      suggestion: "introduce a root task without dependencies",
    });
  }

  if (disconnected.length > 0) {
    warnings.push({
      code: "DISCONNECTED",
      message: `the following nodes are unreachable: ${disconnected.join(", ")}`,
      nodes: disconnected,
      suggestion: "connect the nodes to an entrypoint or drop them",
    });
  }

  const cycleAnalysis = detectCyclesInternal(adjacency, input.cycle_limit);
  if (cycleAnalysis.hasCycle) {
    warnings.push({
      code: "CYCLE_DETECTED",
      message: `cycles detected (${cycleAnalysis.cycles.length})`,
      suggestion: "break the cycle or mark it as an intentional loop",
    });
  }

  return {
    op_id: opId,
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      node_count: descriptor.nodes.length,
      edge_count: descriptor.edges.length,
      entrypoints,
      disconnected,
    },
  };
}

/** Input payload accepted by `graph_summarize`. */
export const GraphSummarizeInputSchema = z.object({
  graph: GraphDescriptorSchema,
  include_centrality: z.boolean().default(true),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphSummarizeInputShape = GraphSummarizeInputSchema.shape;

export type GraphSummarizeInput = z.infer<typeof GraphSummarizeInputSchema>;

export interface GraphSummarizeResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  layers: { index: number; nodes: string[] }[];
  metrics: {
    node_count: number;
    edge_count: number;
    average_in_degree: number;
    average_out_degree: number;
    density: number;
    entrypoints: string[];
    sinks: string[];
    isolated: string[];
    hubs: string[];
  };
  critical_nodes: { node: string; score: number }[];
  structure: {
    degree_summary: {
      average_in: number;
      average_out: number;
      min_in: number;
      max_in: number;
      min_out: number;
      max_out: number;
    };
    components: string[][];
  };
  notes: string[];
}

/** Provide a human readable summary for the provided graph. */
export function handleGraphSummarize(input: GraphSummarizeInput): GraphSummarizeResult {
  const opId = resolveOperationId(input.op_id, "graph_summarize_op");
  const descriptor = normaliseDescriptor(input.graph);
  const attributeIndex = buildGraphAttributeIndex(descriptor);
  const adjacency = attributeIndex.adjacency;
  const indegree = attributeIndex.indegree;
  const outdegree = attributeIndex.outdegree;

  const layers = computeLayers(adjacency, indegree);

  const nodeCount = descriptor.nodes.length;
  const edgeCount = descriptor.edges.length;
  const averageIn = nodeCount ? sumValues(indegree) / nodeCount : 0;
  const averageOut = nodeCount ? sumValues(outdegree) / nodeCount : 0;
  const density = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;

  const notes: string[] = [];
  if (layers.some((layer) => layer.length === 0)) {
    notes.push("graph contains empty layer due to cycles or disconnected nodes");
  }

  const critical_nodes: { node: string; score: number }[] = [];
  if (input.include_centrality && descriptor.nodes.length > 0) {
    const scores = computeBetweennessScores(descriptor);
    scores.sort((a, b) => b.score - a.score);
    for (const entry of scores.slice(0, 5)) {
      if (entry.score <= 0) {
        continue;
      }
      critical_nodes.push({ node: entry.node, score: Number(entry.score.toFixed(4)) });
    }
  }

  return {
    op_id: opId,
    graph: serialiseDescriptor(descriptor),
    layers: layers.map((nodes, index) => ({ index, nodes })),
    metrics: {
      node_count: nodeCount,
      edge_count: edgeCount,
      average_in_degree: Number(averageIn.toFixed(3)),
      average_out_degree: Number(averageOut.toFixed(3)),
      density: Number(density.toFixed(5)),
      entrypoints: attributeIndex.entrypoints,
      sinks: attributeIndex.sinks,
      isolated: attributeIndex.isolated,
      hubs: attributeIndex.hubs,
    },
    critical_nodes,
    structure: {
      degree_summary: {
        average_in: attributeIndex.degreeSummary.averageIn,
        average_out: attributeIndex.degreeSummary.averageOut,
        min_in: attributeIndex.degreeSummary.minIn,
        max_in: attributeIndex.degreeSummary.maxIn,
        min_out: attributeIndex.degreeSummary.minOut,
        max_out: attributeIndex.degreeSummary.maxOut,
      },
      components: attributeIndex.components,
    },
    notes,
  };
}

/** Descriptor accepted when tools customise the cost evaluation used by path algorithms. */
const EdgeCostConfigSchema = z.union([
  z.string().min(1, "cost attribute must be provided"),
  z.object({
    attribute: z.string().min(1, "cost attribute must be provided"),
    default_value: z
      .number()
      .finite()
      .nonnegative("default value must be a non-negative number")
      .optional(),
    scale: z
      .number()
      .finite()
      .positive("scale must be strictly positive when provided")
      .optional(),
  }),
]);

type EdgeCostConfig = z.infer<typeof EdgeCostConfigSchema>;

/** Input payload accepted by `graph_paths_k_shortest`. */
export const GraphPathsKShortestInputSchema = z.object({
  graph: GraphDescriptorSchema,
  from: z.string().min(1, "start node must be provided"),
  to: z.string().min(1, "goal node must be provided"),
  k: z
    .number()
    .int("k must be an integer")
    .min(1, "k must be at least 1")
    .max(64, "k larger than 64 is not supported")
    .default(3),
  weight_attribute: z.string().min(1).default("weight"),
  cost: EdgeCostConfigSchema.optional(),
  max_deviation: z
    .number()
    .finite("max_deviation must be finite")
    .nonnegative("max_deviation must be non-negative")
    .optional(),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphPathsKShortestInputShape = GraphPathsKShortestInputSchema.shape;

export type GraphPathsKShortestInput = z.infer<typeof GraphPathsKShortestInputSchema>;

/** Entry describing a single path returned by the k-shortest paths tool. */
export interface GraphPathsKShortestEntry extends Record<string, unknown> {
  rank: number;
  nodes: string[];
  cost: number;
}

export interface GraphPathsKShortestResult extends Record<string, unknown> {
  op_id: string;
  from: string;
  to: string;
  requested_k: number;
  returned_k: number;
  weight_attribute: string;
  cost_attribute: string | null;
  max_deviation: number | null;
  baseline_cost: number | null;
  paths: GraphPathsKShortestEntry[];
  notes: string[];
}

/**
 * Compute the `k` loop-less shortest paths using Yen's algorithm. The helper
 * exposes structured metadata so the orchestrator can present ranked detours
 * alongside the baseline cost.
 */
export function handleGraphPathsKShortest(
  input: GraphPathsKShortestInput,
): GraphPathsKShortestResult {
  const opId = resolveOperationId(input.op_id, "graph_paths_k_shortest_op");
  const descriptor = normaliseDescriptor(input.graph);
  assertNodeExists(descriptor, input.from, "start");
  assertNodeExists(descriptor, input.to, "goal");

  const variant = {
    from: input.from,
    to: input.to,
    k: input.k,
    weight_attribute: input.weight_attribute,
    cost: input.cost ?? null,
    max_deviation: input.max_deviation ?? null,
  };

  return withCachedComputation(descriptor, "graph_paths_k_shortest", variant, () => {
    const graph = descriptorToGraphModel(descriptor);
    const costConfig = normaliseCostConfig(input.cost);
    const results = kShortestPaths(graph, input.from, input.to, input.k, {
      weightAttribute: input.weight_attribute,
      costFunction: costConfig,
      maxDeviation: input.max_deviation,
    });

    const formatted: GraphPathsKShortestEntry[] = results.map(
      (entry, index): GraphPathsKShortestEntry => ({
        rank: index + 1,
        nodes: [...entry.path],
        cost: Number(entry.distance.toFixed(6)),
      }),
    );

    const notes: string[] = [];
    if (!formatted.length) {
      notes.push("no_path_found");
    } else if (formatted.length < input.k) {
      notes.push("fewer_paths_than_requested");
    }
    if (typeof input.max_deviation === "number") {
      notes.push("max_deviation_filter_active");
    }

    return {
      op_id: opId,
      from: input.from,
      to: input.to,
      requested_k: input.k,
      returned_k: formatted.length,
      weight_attribute: input.weight_attribute,
      cost_attribute: typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null,
      max_deviation: input.max_deviation ?? null,
      baseline_cost: formatted[0]?.cost ?? null,
      paths: formatted,
      notes,
    };
  });
}

/** Input payload accepted by `graph_paths_constrained`. */
export const GraphPathsConstrainedInputSchema = z.object({
  graph: GraphDescriptorSchema,
  from: z.string().min(1, "start node must be provided"),
  to: z.string().min(1, "goal node must be provided"),
  weight_attribute: z.string().min(1).default("weight"),
  cost: EdgeCostConfigSchema.optional(),
  avoid_nodes: z.array(z.string().min(1)).default([]),
  avoid_edges: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
    .default([]),
  max_cost: z
    .number()
    .finite("max_cost must be finite")
    .nonnegative("max_cost must be non-negative")
    .optional(),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphPathsConstrainedInputShape = GraphPathsConstrainedInputSchema.shape;

export type GraphPathsConstrainedInput = z.infer<typeof GraphPathsConstrainedInputSchema>;

export interface GraphPathsConstrainedResult extends Record<string, unknown> {
  op_id: string;
  status: "found" | "unreachable" | "cost_exceeded";
  reason: "START_OR_GOAL_EXCLUDED" | "NO_PATH" | "MAX_COST_EXCEEDED" | null;
  path: string[];
  cost: number | null;
  visited: string[];
  weight_attribute: string;
  cost_attribute: string | null;
  filtered: { nodes: number; edges: number };
  violations: string[];
  max_cost?: number;
  notes: string[];
}

/**
 * Run a Dijkstra search while honouring exclusion lists (nodes/edges) and an
 * optional cost budget. The tool surfaces why a route could not be produced so
 * the operator can adjust the constraints.
 */
export function handleGraphPathsConstrained(
  input: GraphPathsConstrainedInput,
): GraphPathsConstrainedResult {
  const opId = resolveOperationId(input.op_id, "graph_paths_constrained_op");
  const descriptor = normaliseDescriptor(input.graph);
  assertNodeExists(descriptor, input.from, "start");
  assertNodeExists(descriptor, input.to, "goal");

  const variant = {
    from: input.from,
    to: input.to,
    weight_attribute: input.weight_attribute,
    cost: input.cost ?? null,
    avoid_nodes: [...input.avoid_nodes].sort(),
    avoid_edges: input.avoid_edges
      .map((edge) => `${edge.from}->${edge.to}`)
      .sort(),
    max_cost: input.max_cost ?? null,
  };

  return withCachedComputation(descriptor, "graph_paths_constrained", variant, () => {
    const graph = descriptorToGraphModel(descriptor);
    const costConfig = normaliseCostConfig(input.cost);
    const constrained = constrainedShortestPath(graph, input.from, input.to, {
      weightAttribute: input.weight_attribute,
      costFunction: costConfig,
      avoidNodes: input.avoid_nodes,
      avoidEdges: input.avoid_edges,
      maxCost: input.max_cost,
    });

    const removedNodeCount = constrained.filteredNodes.length;
    const removedEdgeCount = constrained.filteredEdges.length;
    const costAttribute = typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null;
    const basePayload = {
      weight_attribute: input.weight_attribute,
      cost_attribute: costAttribute,
      filtered: { nodes: removedNodeCount, edges: removedEdgeCount },
      violations: constrained.violations,
      notes: constrained.notes,
    } as const;

    if (constrained.status === "start_or_goal_excluded") {
      return {
        op_id: opId,
        status: "unreachable" as const,
        reason: "START_OR_GOAL_EXCLUDED" as const,
        path: [],
        cost: null,
        visited: constrained.visitedOrder,
        ...basePayload,
      };
    }

    if (constrained.status === "unreachable") {
      return {
        op_id: opId,
        status: "unreachable" as const,
        reason: "NO_PATH" as const,
        path: [],
        cost: null,
        visited: constrained.visitedOrder,
        ...basePayload,
      };
    }

    if (constrained.status === "max_cost_exceeded") {
      const totalCost = Number.isFinite(constrained.distance) ? Number(constrained.distance.toFixed(6)) : null;
      return {
        op_id: opId,
        status: "cost_exceeded" as const,
        reason: "MAX_COST_EXCEEDED" as const,
        path: [...constrained.path],
        cost: totalCost,
        visited: constrained.visitedOrder,
        max_cost: input.max_cost,
        ...basePayload,
      };
    }

    const totalCost = Number(constrained.distance.toFixed(6));
    return {
      op_id: opId,
      status: "found" as const,
      reason: null,
      path: [...constrained.path],
      cost: totalCost,
      visited: constrained.visitedOrder,
      ...basePayload,
    };
  });
}

/** Input payload accepted by `graph_centrality_betweenness`. */
export const GraphCentralityBetweennessInputSchema = z.object({
  graph: GraphDescriptorSchema,
  weighted: z.boolean().default(false),
  weight_attribute: z.string().min(1).default("weight"),
  cost: EdgeCostConfigSchema.optional(),
  normalise: z.boolean().default(true),
  top_k: z
    .number()
    .int("top_k must be an integer")
    .min(1, "top_k must be at least 1")
    .max(64, "top_k larger than 64 is not supported")
    .default(5),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphCentralityBetweennessInputShape = GraphCentralityBetweennessInputSchema.shape;

export type GraphCentralityBetweennessInput = z.infer<typeof GraphCentralityBetweennessInputSchema>;

export interface GraphCentralityBetweennessResult extends Record<string, unknown> {
  op_id: string;
  weighted: boolean;
  normalised: boolean;
  weight_attribute: string;
  cost_attribute: string | null;
  scores: Array<{ node: string; score: number }>;
  top: Array<{ node: string; score: number }>;
  statistics: { min: number; max: number; mean: number };
  notes: string[];
}

/**
 * Compute Brandes betweenness centrality. The orchestrator exposes the full
 * ranking alongside the top-k nodes to assist in graph triage or runbook
 * generation.
 */
export function handleGraphCentralityBetweenness(
  input: GraphCentralityBetweennessInput,
): GraphCentralityBetweennessResult {
  const opId = resolveOperationId(input.op_id, "graph_centrality_betweenness_op");
  const descriptor = normaliseDescriptor(input.graph);
  const variant = {
    weighted: input.weighted,
    weight_attribute: input.weight_attribute,
    cost: input.cost ?? null,
    normalise: input.normalise,
  };

  const sorted: Array<{ node: string; score: number }> = withCachedComputation(
    descriptor,
    "graph_centrality_betweenness",
    variant,
    () => {
      const graph = descriptorToGraphModel(descriptor);
      const costConfig = normaliseCostConfig(input.cost);
      const scores = betweennessCentrality(graph, {
        weighted: input.weighted,
        weightAttribute: input.weight_attribute,
        costFunction: costConfig,
        normalise: input.normalise,
      });

      return scores
        .map((entry): { node: string; score: number } => ({
          node: entry.node,
          score: Number(entry.score.toFixed(6)),
        }))
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return a.node.localeCompare(b.node);
        });
    },
  );

  const top = sorted.slice(0, Math.min(input.top_k, sorted.length));
  const statistics = computeScoreStatistics(sorted);
  const notes = sorted.length === 0 ? ["graph_has_no_nodes"] : [];

  return {
    op_id: opId,
    weighted: input.weighted,
    normalised: input.normalise,
    weight_attribute: input.weight_attribute,
    cost_attribute: typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null,
    scores: sorted,
    top,
    statistics,
    notes,
  };
}

const GraphPartitionObjectiveSchema = z.enum(["min-cut", "community"]);

/** Input payload accepted by `graph_partition`. */
export const GraphPartitionInputSchema = z.object({
  graph: GraphDescriptorSchema,
  k: z.number().int().min(1, "k must be at least 1").max(32, "k larger than 32 is not supported").default(2),
  objective: GraphPartitionObjectiveSchema.default("community"),
  seed: z.number().int().nonnegative().optional(),
  max_iterations: z.number().int().positive().max(100).default(12),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphPartitionInputShape = GraphPartitionInputSchema.shape;

export type GraphPartitionInput = z.infer<typeof GraphPartitionInputSchema>;

export interface GraphPartitionAssignment extends Record<string, unknown> {
  node: string;
  partition: number;
}

export interface GraphPartitionToolResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  objective: GraphPartitionObjective;
  requested_k: number;
  partition_count: number;
  cut_edges: number;
  assignments: GraphPartitionAssignment[];
  seed_nodes: string[];
  iterations: number;
  notes: string[];
}

/** Partition the graph using a heuristic min-cut/community strategy. */
export function handleGraphPartition(input: GraphPartitionInput): GraphPartitionToolResult {
  const opId = resolveOperationId(input.op_id, "graph_partition_op");
  const descriptor = normaliseDescriptor(input.graph);
  const attributeIndex = buildGraphAttributeIndex(descriptor);
  const result = partitionGraph(descriptor, attributeIndex, {
    k: input.k,
    objective: input.objective,
    seed: input.seed,
    maxIterations: input.max_iterations,
  });

  const assignments: GraphPartitionAssignment[] = Array.from(result.assignments.entries())
    .map(([node, partition]) => ({ node, partition }))
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));

  return {
    op_id: opId,
    graph: serialiseDescriptor(descriptor),
    objective: input.objective,
    requested_k: input.k,
    partition_count: result.partitionCount,
    cut_edges: result.cutEdges,
    assignments,
    seed_nodes: result.seedNodes,
    iterations: result.iterations,
    notes: result.notes,
  };
}

function computeLayers(
  adjacency: Map<string, string[]>,
  indegree: Map<string, number>,
): string[][] {
  const workingIndegree = new Map<string, number>();
  for (const [key, value] of indegree.entries()) {
    workingIndegree.set(key, value);
  }

  const assigned = new Set<string>();
  const layers: string[][] = [];
  let frontier: string[] = Array.from(workingIndegree.entries())
    .filter(([, value]) => value === 0)
    .map(([node]) => node);

  while (frontier.length) {
    const layerNodes = frontier.sort();
    layers.push(layerNodes);
    const next = new Set<string>();
    for (const node of layerNodes) {
      assigned.add(node);
      for (const neighbour of adjacency.get(node) ?? []) {
        const remaining = (workingIndegree.get(neighbour) ?? 0) - 1;
        workingIndegree.set(neighbour, remaining);
        if (remaining === 0 && !assigned.has(neighbour)) {
          next.add(neighbour);
        }
      }
    }
    frontier = Array.from(next);
  }

  const leftovers = Array.from(adjacency.keys()).filter((node) => !assigned.has(node));
  if (leftovers.length) {
    leftovers.sort();
    layers.push(leftovers);
  }

  return layers;
}

function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) {
    total += value;
  }
  return total;
}

interface AdjacencyInfo {
  adjacency: Map<string, string[]>;
  indegree: Map<string, number>;
  outdegree: Map<string, number>;
}

interface WeightedEdge {
  to: string;
  weight: number;
}

function buildAdjacencyInfo(descriptor: NormalisedGraph): AdjacencyInfo {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();

  for (const node of descriptor.nodes) {
    adjacency.set(node.id, []);
    indegree.set(node.id, 0);
    outdegree.set(node.id, 0);
  }

  for (const edge of descriptor.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
      indegree.set(edge.from, indegree.get(edge.from) ?? 0);
      outdegree.set(edge.from, outdegree.get(edge.from) ?? 0);
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
      indegree.set(edge.to, indegree.get(edge.to) ?? 0);
      outdegree.set(edge.to, outdegree.get(edge.to) ?? 0);
    }
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outdegree.set(edge.from, (outdegree.get(edge.from) ?? 0) + 1);
  }

  return { adjacency, indegree, outdegree };
}

function detectCyclesInternal(
  adjacency: Map<string, string[]>,
  limit: number,
): { hasCycle: boolean; cycles: string[][] } {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (nodeId: string): void => {
    if (cycles.length >= limit) {
      return;
    }
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const neighbour of adjacency.get(nodeId) ?? []) {
      if (cycles.length >= limit) {
        break;
      }
      if (visiting.has(neighbour)) {
        const start = stack.indexOf(neighbour);
        if (start >= 0) {
          cycles.push(stack.slice(start).concat(neighbour));
        }
        continue;
      }
      if (!visited.has(neighbour)) {
        visit(neighbour);
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    stack.pop();
  };

  for (const node of adjacency.keys()) {
    if (cycles.length >= limit) {
      break;
    }
    if (!visited.has(node)) {
      visit(node);
    }
  }

  return { hasCycle: cycles.length > 0, cycles };
}

function buildWeightedAdjacency(descriptor: NormalisedGraph): Map<string, WeightedEdge[]> {
  const adjacency = new Map<string, WeightedEdge[]>();
  for (const node of descriptor.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of descriptor.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
    }
    adjacency.get(edge.from)!.push({ to: edge.to, weight: normaliseEdgeWeight(edge) });
  }
  return adjacency;
}

function normaliseCostConfig(
  config: EdgeCostConfig | undefined,
): GraphForgeEdgeCostDescriptor | string | undefined {
  if (!config) {
    return undefined;
  }
  if (typeof config === "string") {
    return config;
  }
  return {
    attribute: config.attribute,
    defaultValue: config.default_value,
    scale: config.scale,
  } satisfies GraphForgeEdgeCostDescriptor;
}

function assertNodeExists(descriptor: NormalisedGraph, id: string, role: "start" | "goal"): void {
  if (!descriptor.nodes.some((node) => node.id === id)) {
    throw new Error(`${role} node '${id}' is not present in the graph`);
  }
}

function normaliseEdgeWeight(edge: NormalisedEdge): number {
  const direct = typeof edge.weight === "number" ? edge.weight : undefined;
  const attributeWeight = Number(edge.attributes.weight ?? NaN);
  const weight = Number.isFinite(direct) ? direct! : Number.isFinite(attributeWeight) ? attributeWeight : 1;
  return weight < 0 ? 0 : weight;
}

function computeScoreStatistics(
  scores: Array<{ score: number }>,
): { min: number; max: number; mean: number } {
  if (scores.length === 0) {
    return { min: 0, max: 0, mean: 0 };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const entry of scores) {
    const value = entry.score;
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
    total += value;
  }
  const mean = total / scores.length;
  return {
    min: Number(min.toFixed(6)),
    max: Number(max.toFixed(6)),
    mean: Number(mean.toFixed(6)),
  };
}

function computeBetweennessScores(descriptor: NormalisedGraph): { node: string; score: number }[] {
  return withCachedComputation(descriptor, "graph_summarize_betweenness", "default", () => {
    const nodes = descriptor.nodes.map((node) => node.id);
    const adjacency = buildWeightedAdjacency(descriptor);
    const scores = new Map<string, number>();
    for (const id of nodes) {
      scores.set(id, 0);
    }

    const epsilon = 1e-9;

    for (const source of nodes) {
      const stack: string[] = [];
      const predecessors = new Map<string, string[]>();
      const sigma = new Map<string, number>();
      const distance = new Map<string, number>();

      for (const id of nodes) {
        predecessors.set(id, []);
        sigma.set(id, 0);
        distance.set(id, Number.POSITIVE_INFINITY);
      }
      sigma.set(source, 1);
      distance.set(source, 0);

      const queue: { node: string; priority: number }[] = [{ node: source, priority: 0 }];

      while (queue.length) {
        queue.sort((a, b) => a.priority - b.priority);
        const current = queue.shift()!;
        const v = current.node;
        if ((distance.get(v) ?? Number.POSITIVE_INFINITY) + epsilon < current.priority) {
          continue;
        }
        stack.push(v);
        for (const edge of adjacency.get(v) ?? []) {
          const weight = edge.weight;
          if (!Number.isFinite(weight)) {
            continue;
          }
          const tentative = (distance.get(v) ?? Number.POSITIVE_INFINITY) + weight;
          const targetDistance = distance.get(edge.to) ?? Number.POSITIVE_INFINITY;
          if (tentative + epsilon < targetDistance) {
            distance.set(edge.to, tentative);
            queue.push({ node: edge.to, priority: tentative });
            sigma.set(edge.to, sigma.get(v)!);
            predecessors.set(edge.to, [v]);
          } else if (Math.abs(tentative - targetDistance) <= epsilon) {
            sigma.set(edge.to, (sigma.get(edge.to) ?? 0) + (sigma.get(v) ?? 0));
            const list = predecessors.get(edge.to)!;
            if (!list.includes(v)) {
              list.push(v);
            }
          }
        }
      }

      const delta = new Map<string, number>();
      for (const id of nodes) {
        delta.set(id, 0);
      }

      while (stack.length) {
        const w = stack.pop()!;
        const wSigma = sigma.get(w) ?? 1;
        for (const v of predecessors.get(w) ?? []) {
          const share = (sigma.get(v)! / wSigma) * (1 + (delta.get(w) ?? 0));
          delta.set(v, (delta.get(v) ?? 0) + share);
        }
        if (w !== source) {
          scores.set(w, (scores.get(w) ?? 0) + (delta.get(w) ?? 0));
        }
      }
    }

    if (nodes.length > 2) {
      const factor = 1 / ((nodes.length - 1) * (nodes.length - 2));
      for (const id of nodes) {
        scores.set(id, (scores.get(id) ?? 0) * factor);
      }
    }

    return nodes.map((id) => ({ node: id, score: scores.get(id) ?? 0 }));
  });
}

const GraphSimulateInputShapeInternal = {
  graph: GraphDescriptorSchema,
  parallelism: z
    .number()
    .int()
    .min(1, "parallelism must be at least 1")
    .max(64, "parallelism larger than 64 is not supported")
    .default(4),
  duration_attribute: z.string().min(1).default("duration"),
  fallback_duration_attribute: z.string().min(1).optional(),
  default_duration: z
    .number()
    .finite()
    .positive("default duration must be strictly positive")
    .default(1),
  op_id: z.string().trim().min(1).optional(),
};

/** Input payload accepted by `graph_simulate`. */
export const GraphSimulateInputSchema = z.object(GraphSimulateInputShapeInternal);

export const GraphSimulateInputShape = GraphSimulateInputShapeInternal;

export type GraphSimulateInput = z.infer<typeof GraphSimulateInputSchema>;

/** Entry describing how a single node was scheduled during the simulation. */
export interface GraphSimulateScheduleEntry extends Record<string, unknown> {
  node_id: string;
  /** Actual time (in abstract units) when dependencies finished. */
  ready_at: number;
  /** Simulation start timestamp for the node (after potential queuing). */
  start: number;
  /** Simulation finish timestamp for the node. */
  end: number;
  /** Duration used by the simulator (after attribute resolution). */
  duration: number;
  /** Ideal start time ignoring resource contention (derived from longest path). */
  earliest_start: number;
  /** Slack time computed from critical path analysis. */
  slack: number;
  /** Whether the node lies on at least one critical path (zero slack). */
  critical: boolean;
  /** Waiting time introduced by resource contention (start - ready_at). */
  waiting_time: number;
  /** Dependency list recorded for traceability. */
  dependencies: string[];
}

/** Entry describing when a node had to wait in the execution queue. */
export interface GraphSimulateQueueRecord extends Record<string, unknown> {
  node_id: string;
  queued_at: number;
  started_at: number;
  wait: number;
}

/** Aggregated metrics returned by the simulator. */
export interface GraphSimulateMetrics extends Record<string, unknown> {
  parallelism: number;
  makespan: number;
  total_duration: number;
  max_concurrency: number;
  average_concurrency: number;
  utilisation: number;
  queue_events: number;
  total_wait_time: number;
}

export interface GraphSimulateResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  schedule: GraphSimulateScheduleEntry[];
  queue: GraphSimulateQueueRecord[];
  metrics: GraphSimulateMetrics;
  warnings: string[];
}

const GraphCriticalPathInputShapeInternal = {
  graph: GraphDescriptorSchema,
  duration_attribute: GraphSimulateInputShapeInternal.duration_attribute,
  fallback_duration_attribute: GraphSimulateInputShapeInternal.fallback_duration_attribute,
  default_duration: GraphSimulateInputShapeInternal.default_duration,
  op_id: z.string().trim().min(1).optional(),
};

/** Input payload accepted by `graph_critical_path`. */
export const GraphCriticalPathInputSchema = z.object(GraphCriticalPathInputShapeInternal);

export const GraphCriticalPathInputShape = GraphCriticalPathInputShapeInternal;

export type GraphCriticalPathInput = z.infer<typeof GraphCriticalPathInputSchema>;

export interface GraphCriticalPathResult extends Record<string, unknown> {
  op_id: string;
  duration: number;
  critical_path: string[];
  earliest_start: Record<string, number>;
  earliest_finish: Record<string, number>;
  slack_by_node: Record<string, number>;
  warnings: string[];
}

/**
 * Analyse the critical path of the DAG without running the full simulator. The
 * helper shares slack and earliest start/finish times so operators can spot
 * bottlenecks or parallelisation opportunities quickly.
 */
export function handleGraphCriticalPath(
  input: GraphCriticalPathInput,
): GraphCriticalPathResult {
  const opId = resolveOperationId(input.op_id, "graph_critical_path_op");
  const context = buildSimulationContext({
    graph: input.graph,
    duration_attribute: input.duration_attribute,
    fallback_duration_attribute: input.fallback_duration_attribute,
    default_duration: input.default_duration,
  });

  const earliestStart: Record<string, number> = {};
  for (const [node, value] of context.critical.earliestStart.entries()) {
    earliestStart[node] = Number(value.toFixed(6));
  }

  const earliestFinish: Record<string, number> = {};
  for (const [node, value] of context.critical.earliestFinish.entries()) {
    earliestFinish[node] = Number(value.toFixed(6));
  }

  const slackByNode: Record<string, number> = {};
  for (const [node, value] of context.critical.slack.entries()) {
    slackByNode[node] = Number(value.toFixed(6));
  }

  return {
    op_id: opId,
    duration: Number(context.critical.duration.toFixed(6)),
    critical_path: [...context.critical.criticalPath],
    earliest_start: earliestStart,
    earliest_finish: earliestFinish,
    slack_by_node: slackByNode,
    warnings: [...context.warnings],
  };
}

/** Input payload accepted by `graph_optimize`. */
const GraphOptimizeObjectiveSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("makespan"),
  }),
  z.object({
    type: z.literal("cost"),
    attribute: z.string().min(1).default("cost"),
    default_value: z
      .number()
      .finite()
      .nonnegative("default_value must be non-negative")
      .default(0),
    parallel_penalty: z
      .number()
      .finite()
      .nonnegative("parallel_penalty must be non-negative")
      .default(0),
  }),
  z.object({
    type: z.literal("risk"),
    attribute: z.string().min(1).default("risk"),
    default_value: z
      .number()
      .finite()
      .nonnegative("default_value must be non-negative")
      .default(0),
    parallel_penalty: z
      .number()
      .finite()
      .nonnegative("parallel_penalty must be non-negative")
      .default(0),
    concurrency_penalty: z
      .number()
      .finite()
      .nonnegative("concurrency_penalty must be non-negative")
      .default(0),
  }),
]);

const GraphOptimizeInputShapeInternal = {
  graph: GraphDescriptorSchema,
  parallelism: z
    .number()
    .int()
    .min(1, "parallelism must be at least 1")
    .max(64, "parallelism larger than 64 is not supported")
    .default(1),
  max_parallelism: z
    .number()
    .int()
    .min(1, "max_parallelism must be at least 1")
    .max(64, "max_parallelism larger than 64 is not supported")
    .default(8),
  explore_parallelism: z.array(z.number().int().min(1).max(64)).optional(),
  duration_attribute: z.string().min(1).default("duration"),
  fallback_duration_attribute: z.string().min(1).optional(),
  default_duration: z
    .number()
    .finite()
    .positive("default duration must be strictly positive")
    .default(1),
  objective: GraphOptimizeObjectiveSchema.default({ type: "makespan" }),
  op_id: z.string().trim().min(1).optional(),
};

export const GraphOptimizeInputSchema = z
  .object(GraphOptimizeInputShapeInternal)
  .superRefine((input, ctx) => {
    if (input.max_parallelism < input.parallelism) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "max_parallelism must be greater than or equal to parallelism",
        path: ["max_parallelism"],
      });
    }
  });

export const GraphOptimizeInputShape = GraphOptimizeInputShapeInternal;

export type GraphOptimizeInput = z.infer<typeof GraphOptimizeInputSchema>;
export type GraphOptimizeObjective = z.infer<typeof GraphOptimizeObjectiveSchema>;

export interface GraphOptimizationProjection extends Record<string, unknown> {
  parallelism: number;
  makespan: number;
  utilisation: number;
  total_wait_time: number;
  average_concurrency: number;
  objective_value: number;
  objective_label: string;
}

export interface GraphOptimizationSuggestion extends Record<string, unknown> {
  type: "increase_parallelism" | "critical_path_focus" | "rebalance_queue";
  description: string;
  impact: {
    baseline_makespan?: number;
    projected_makespan?: number;
    improvement?: number;
    baseline_objective?: number;
    projected_objective?: number;
    objective_label?: string;
  };
  details?: Record<string, unknown>;
}

export interface GraphOptimizeResult extends Record<string, unknown> {
  op_id: string;
  objective: {
    type: GraphOptimizeObjective["type"];
    label: string;
    attribute?: string;
  };
  baseline: GraphSimulateResult;
  projections: GraphOptimizationProjection[];
  suggestions: GraphOptimizationSuggestion[];
  critical_path: {
    nodes: string[];
    duration: number;
    slack_by_node: Record<string, number>;
  };
  warnings: string[];
}

/** Result of the pre-processing stage executed before any simulation. */
interface SimulationContext {
  descriptor: NormalisedGraph;
  adjacency: Map<string, string[]>;
  indegree: Map<string, number>;
  incoming: Map<string, string[]>;
  durations: Map<string, number>;
  critical: CriticalPathInfo;
  warnings: string[];
}

interface CriticalPathInfo {
  earliestStart: Map<string, number>;
  earliestFinish: Map<string, number>;
  slack: Map<string, number>;
  criticalPath: string[];
  duration: number;
}

interface SimulationOutput {
  schedule: GraphSimulateScheduleEntry[];
  queue: GraphSimulateQueueRecord[];
  metrics: GraphSimulateMetrics;
  warnings: string[];
}

interface ReadyEntry {
  nodeId: string;
  readyAt: number;
  duration: number;
  dependencies: string[];
}

interface RunningEntry {
  nodeId: string;
  start: number;
  finish: number;
  readyAt: number;
  duration: number;
  dependencies: string[];
}

/** Prepare the graph descriptor and sanity checks before simulation. */
function buildSimulationContext(
  input: Pick<
    GraphSimulateInput,
    "graph" | "duration_attribute" | "fallback_duration_attribute" | "default_duration"
  >,
): SimulationContext {
  const descriptor = normaliseDescriptor(input.graph);
  const { adjacency, indegree } = buildAdjacencyInfo(descriptor);
  const cycleInfo = detectCyclesInternal(adjacency, descriptor.nodes.length + 1);
  if (cycleInfo.hasCycle) {
    const preview = cycleInfo.cycles[0]?.join(" -> ") ?? "unknown";
    throw new Error(`graph contains cycles and cannot be simulated (example: ${preview})`);
  }

  const incoming = new Map<string, string[]>();
  for (const node of descriptor.nodes) {
    incoming.set(node.id, []);
  }
  for (const edge of descriptor.edges) {
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, []);
    }
    incoming.get(edge.to)!.push(edge.from);
  }
  for (const [, list] of incoming.entries()) {
    list.sort();
  }

  const { durations, warnings } = resolveDurations(descriptor, {
    durationAttribute: input.duration_attribute,
    fallbackDurationAttribute: input.fallback_duration_attribute,
    defaultDuration: input.default_duration,
  });

  const order = computeTopologicalOrder(descriptor, adjacency, indegree);
  const critical = computeCriticalPathInfo(order, adjacency, incoming, durations);

  return { descriptor, adjacency, indegree, incoming, durations, critical, warnings };
}

/** Resolve durations for each node while tracking fallback usage. */
function resolveDurations(
  descriptor: NormalisedGraph,
  options: {
    durationAttribute: string;
    fallbackDurationAttribute?: string;
    defaultDuration: number;
  },
): { durations: Map<string, number>; warnings: string[] } {
  const durations = new Map<string, number>();
  const warnings: string[] = [];

  for (const node of descriptor.nodes) {
    const resolved = pickDuration(node, options);
    durations.set(node.id, resolved.value);
    if (resolved.warning) {
      warnings.push(resolved.warning);
    }
  }

  return { durations, warnings };
}

function pickDuration(
  node: NormalisedNode,
  options: {
    durationAttribute: string;
    fallbackDurationAttribute?: string;
    defaultDuration: number;
  },
): { value: number; warning?: string } {
  const sources: Array<{ label: string; value: unknown }> = [
    { label: options.durationAttribute, value: node.attributes[options.durationAttribute] },
  ];

  if (options.fallbackDurationAttribute) {
    sources.push({
      label: options.fallbackDurationAttribute,
      value: node.attributes[options.fallbackDurationAttribute],
    });
  }

  sources.push({ label: "weight", value: node.attributes.weight });

  for (const source of sources) {
    if (typeof source.value === "number" && Number.isFinite(source.value) && source.value >= 0) {
      return { value: source.value };
    }
    if (typeof source.value === "string") {
      const parsed = Number(source.value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return { value: parsed };
      }
    }
  }

  return {
    value: options.defaultDuration,
    warning: `node '${node.id}' missing duration attribute, using default ${options.defaultDuration}`,
  };
}

/** Compute deterministic topological order (raises when encountering a cycle). */
function computeTopologicalOrder(
  descriptor: NormalisedGraph,
  adjacency: Map<string, string[]>,
  indegree: Map<string, number>,
): string[] {
  const indegreeCopy = new Map<string, number>();
  for (const [id, value] of indegree.entries()) {
    indegreeCopy.set(id, value);
  }

  const queue: string[] = descriptor.nodes
    .filter((node) => (indegreeCopy.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort();

  const order: string[] = [];
  const pushSorted = (value: string) => {
    let inserted = false;
    for (let index = 0; index < queue.length; index += 1) {
      if (value.localeCompare(queue[index]) < 0) {
        queue.splice(index, 0, value);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      queue.push(value);
    }
  };

  while (queue.length) {
    const current = queue.shift()!;
    order.push(current);
    for (const neighbour of adjacency.get(current) ?? []) {
      const remaining = (indegreeCopy.get(neighbour) ?? 0) - 1;
      indegreeCopy.set(neighbour, remaining);
      if (remaining === 0) {
        pushSorted(neighbour);
      }
    }
  }

  if (order.length !== descriptor.nodes.length) {
    throw new Error(
      `graph contains cycles or disconnected dependencies (processed ${order.length}/${descriptor.nodes.length} nodes)`,
    );
  }

  return order;
}

/** Compute critical path metrics using the resolved durations. */
function computeCriticalPathInfo(
  order: string[],
  adjacency: Map<string, string[]>,
  incoming: Map<string, string[]>,
  durations: Map<string, number>,
): CriticalPathInfo {
  const earliestStart = new Map<string, number>();
  const earliestFinish = new Map<string, number>();
  const predecessors = new Map<string, string | null>();

  for (const nodeId of order) {
    const deps = incoming.get(nodeId) ?? [];
    let maxFinish = 0;
    let picked: string | null = null;
    for (const dep of deps) {
      const finish = earliestFinish.get(dep) ?? 0;
      if (finish > maxFinish) {
        maxFinish = finish;
        picked = dep;
      }
    }
    earliestStart.set(nodeId, maxFinish);
    const duration = durations.get(nodeId) ?? 0;
    earliestFinish.set(nodeId, maxFinish + duration);
    predecessors.set(nodeId, picked);
  }

  let criticalNode = order[order.length - 1] ?? "";
  let longestDuration = 0;
  for (const nodeId of order) {
    const finish = earliestFinish.get(nodeId) ?? 0;
    if (finish >= longestDuration) {
      criticalNode = nodeId;
      longestDuration = finish;
    }
  }

  const path: string[] = [];
  let cursor: string | null = criticalNode;
  while (cursor) {
    path.push(cursor);
    cursor = predecessors.get(cursor) ?? null;
  }
  path.reverse();

  const latestFinish = new Map<string, number>();
  const latestStart = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const nodeId = order[index];
    const successors = adjacency.get(nodeId) ?? [];
    if (successors.length === 0) {
      latestFinish.set(nodeId, longestDuration);
    } else {
      let minStart = Number.POSITIVE_INFINITY;
      for (const successor of successors) {
        const successorLatestStart = latestStart.get(successor);
        if (typeof successorLatestStart === "number") {
          minStart = Math.min(minStart, successorLatestStart);
        } else {
          const fallback = (earliestFinish.get(successor) ?? 0) - (durations.get(successor) ?? 0);
          minStart = Math.min(minStart, fallback);
        }
      }
      if (!Number.isFinite(minStart)) {
        minStart = longestDuration;
      }
      latestFinish.set(nodeId, minStart);
    }
    const duration = durations.get(nodeId) ?? 0;
    latestStart.set(nodeId, (latestFinish.get(nodeId) ?? longestDuration) - duration);
  }

  const slack = new Map<string, number>();
  for (const nodeId of order) {
    const earliest = earliestStart.get(nodeId) ?? 0;
    const latest = latestStart.get(nodeId) ?? earliest;
    const value = latest - earliest;
    slack.set(nodeId, Number(Math.max(0, value).toFixed(6)));
  }

  return {
    earliestStart,
    earliestFinish,
    slack,
    criticalPath: path,
    duration: longestDuration,
  };
}

/** Execute the discrete event simulation with the provided options. */
function simulateGraph(
  context: SimulationContext,
  parallelism: number,
): SimulationOutput {
  const EPSILON = 1e-9;
  const readyQueue: ReadyEntry[] = [];
  const running: RunningEntry[] = [];
  const schedule: GraphSimulateScheduleEntry[] = [];
  const queue: GraphSimulateQueueRecord[] = [];

  const remainingDeps = new Map<string, number>();
  const dependencyReadyTime = new Map<string, number>();

  for (const node of context.descriptor.nodes) {
    const deps = context.incoming.get(node.id) ?? [];
    remainingDeps.set(node.id, deps.length);
    if (deps.length === 0) {
      readyQueue.push({
        nodeId: node.id,
        readyAt: 0,
        duration: context.durations.get(node.id) ?? 0,
        dependencies: [],
      });
    }
  }

  let currentTime = 0;
  let completed = 0;

  const comparator = (a: ReadyEntry, b: ReadyEntry) => {
    if (Math.abs(a.readyAt - b.readyAt) > EPSILON) {
      return a.readyAt - b.readyAt;
    }
    if (Math.abs(a.duration - b.duration) > EPSILON) {
      return b.duration - a.duration;
    }
    return a.nodeId.localeCompare(b.nodeId);
  };

  while (completed < context.descriptor.nodes.length) {
    readyQueue.sort(comparator);

    while (running.length < parallelism) {
      const index = readyQueue.findIndex((entry) => entry.readyAt <= currentTime + EPSILON);
      if (index === -1) {
        break;
      }
      const entry = readyQueue.splice(index, 1)[0];
      const start = Math.max(currentTime, entry.readyAt);
      const finish = start + entry.duration;
      running.push({
        nodeId: entry.nodeId,
        start,
        finish,
        readyAt: entry.readyAt,
        duration: entry.duration,
        dependencies: entry.dependencies,
      });
    }

    if (running.length === 0) {
      const nextReady = readyQueue[0]?.readyAt;
      if (typeof nextReady === "number") {
        currentTime = Math.max(currentTime, nextReady);
        continue;
      }
      throw new Error("simulation deadlocked: no runnable nodes and no future readiness");
    }

    let nextFinish = Number.POSITIVE_INFINITY;
    for (const task of running) {
      nextFinish = Math.min(nextFinish, task.finish);
    }
    currentTime = nextFinish;

    for (let index = running.length - 1; index >= 0; index -= 1) {
      const task = running[index];
      if (task.finish <= currentTime + EPSILON) {
        running.splice(index, 1);
        completed += 1;

        const slack = context.critical.slack.get(task.nodeId) ?? 0;
        const earliest = context.critical.earliestStart.get(task.nodeId) ?? task.readyAt;
        const waitingTime = Math.max(0, task.start - task.readyAt);
        schedule.push({
          node_id: task.nodeId,
          ready_at: task.readyAt,
          start: task.start,
          end: task.finish,
          duration: task.duration,
          earliest_start: earliest,
          slack,
          critical: Math.abs(slack) <= EPSILON,
          waiting_time: waitingTime,
          dependencies: [...task.dependencies],
        });
        if (waitingTime > EPSILON) {
          queue.push({
            node_id: task.nodeId,
            queued_at: task.readyAt,
            started_at: task.start,
            wait: waitingTime,
          });
        }

        for (const dependant of context.adjacency.get(task.nodeId) ?? []) {
          const remaining = (remainingDeps.get(dependant) ?? 0) - 1;
          remainingDeps.set(dependant, remaining);
          const readyTime = Math.max(dependencyReadyTime.get(dependant) ?? 0, task.finish);
          dependencyReadyTime.set(dependant, readyTime);
          if (remaining === 0) {
            readyQueue.push({
              nodeId: dependant,
              readyAt: readyTime,
              duration: context.durations.get(dependant) ?? 0,
              dependencies: [...(context.incoming.get(dependant) ?? [])],
            });
          }
        }
      }
    }

    if (running.length === 0 && readyQueue.length > 0) {
      currentTime = Math.max(currentTime, readyQueue[0].readyAt);
    }
  }

  const EPSILON_SORT = 1e-9;
  schedule.sort((a, b) => {
    if (Math.abs(a.start - b.start) > EPSILON_SORT) {
      return a.start - b.start;
    }
    return a.node_id.localeCompare(b.node_id);
  });
  queue.sort((a, b) => {
    if (Math.abs(a.queued_at - b.queued_at) > EPSILON_SORT) {
      return a.queued_at - b.queued_at;
    }
    return a.node_id.localeCompare(b.node_id);
  });

  const metrics = computeSimulationMetrics(schedule, queue, parallelism);
  const warnings: string[] = [];
  if (queue.length > 0) {
    warnings.push(
      `detected ${queue.length} queue event(s); consider increasing parallelism or rebalancing dependencies`,
    );
  }

  return { schedule, queue, metrics, warnings };
}

function computeSimulationMetrics(
  schedule: GraphSimulateScheduleEntry[],
  queue: GraphSimulateQueueRecord[],
  parallelism: number,
): GraphSimulateMetrics {
  if (schedule.length === 0) {
    return {
      parallelism,
      makespan: 0,
      total_duration: 0,
      max_concurrency: 0,
      average_concurrency: 0,
      utilisation: 0,
      queue_events: 0,
      total_wait_time: 0,
    };
  }

  const events: Array<{ time: number; delta: number }> = [];
  let totalDuration = 0;
  for (const entry of schedule) {
    events.push({ time: entry.start, delta: 1 });
    events.push({ time: entry.end, delta: -1 });
    totalDuration += entry.duration;
  }
  events.sort((a, b) => a.time - b.time);

  let concurrency = 0;
  let maxConcurrency = 0;
  let weightedSum = 0;
  let prevTime = events[0].time;
  let index = 0;
  const EPSILON = 1e-9;
  while (index < events.length) {
    const currentTime = events[index].time;
    if (currentTime > prevTime) {
      weightedSum += concurrency * (currentTime - prevTime);
      prevTime = currentTime;
    }

    let startDelta = 0;
    let endDelta = 0;
    while (index < events.length && Math.abs(events[index].time - currentTime) <= EPSILON) {
      const delta = events[index].delta;
      if (delta > 0) {
        startDelta += delta;
      } else {
        endDelta += delta;
      }
      index += 1;
    }

    concurrency += endDelta;
    if (concurrency < 0) {
      concurrency = 0;
    }
    concurrency += startDelta;
    if (concurrency > maxConcurrency) {
      maxConcurrency = concurrency;
    }
  }

  const firstStart = Math.min(...schedule.map((entry) => entry.start));
  const lastEnd = Math.max(...schedule.map((entry) => entry.end));
  const makespan = Math.max(0, lastEnd - firstStart);
  const averageConcurrency = makespan > 0 ? weightedSum / makespan : 0;
  const utilisation = makespan > 0 ? weightedSum / (makespan * parallelism) : 0;
  const totalWait = queue.reduce((sum, record) => sum + record.wait, 0);

  return {
    parallelism,
    makespan: Number(makespan.toFixed(6)),
    total_duration: Number(totalDuration.toFixed(6)),
    max_concurrency: maxConcurrency,
    average_concurrency: Number(averageConcurrency.toFixed(6)),
    utilisation: Number(utilisation.toFixed(6)),
    queue_events: queue.length,
    total_wait_time: Number(totalWait.toFixed(6)),
  };
}

/** Simulate the graph and expose schedule, metrics, and queue events. */
export function handleGraphSimulate(input: GraphSimulateInput): GraphSimulateResult {
  const opId = resolveOperationId(input.op_id, "graph_simulate_op");
  const context = buildSimulationContext(input);
  const simulation = simulateGraph(context, input.parallelism);
  const warnings = [...context.warnings, ...simulation.warnings];
  return {
    op_id: opId,
    graph: serialiseDescriptor(context.descriptor),
    schedule: simulation.schedule,
    queue: simulation.queue,
    metrics: simulation.metrics,
    warnings,
  };
}

/** Compute the scalar objective value for a given simulation candidate. */
function evaluateOptimizeObjective(
  objective: GraphOptimizeObjective,
  context: {
    descriptor: NormalisedGraph;
    simulation: SimulationOutput;
    parallelism: number;
  },
): { value: number; label: string; attribute?: string } {
  switch (objective.type) {
    case "makespan":
      return { value: context.simulation.metrics.makespan, label: "makespan" };
    case "cost": {
      const attribute = objective.attribute ?? "cost";
      const base = accumulateNodeAttribute(
        context.descriptor,
        attribute,
        objective.default_value ?? 0,
      );
      const penalty = (objective.parallel_penalty ?? 0) * context.parallelism;
      const value = Number((base + penalty).toFixed(6));
      return { value, label: "cost", attribute };
    }
    case "risk": {
      const attribute = objective.attribute ?? "risk";
      const base = accumulateNodeAttribute(
        context.descriptor,
        attribute,
        objective.default_value ?? 0,
      );
      const parallelPenalty = (objective.parallel_penalty ?? 0) * Math.max(0, context.parallelism - 1);
      const concurrencyPenalty =
        (objective.concurrency_penalty ?? 0) * context.simulation.metrics.max_concurrency;
      const value = Number((base + parallelPenalty + concurrencyPenalty).toFixed(6));
      return { value, label: "risk", attribute };
    }
  }
}

/** Explore optimisation levers on top of the baseline simulation. */
export function handleGraphOptimize(input: GraphOptimizeInput): GraphOptimizeResult {
  const opId = resolveOperationId(input.op_id, "graph_optimize_op");
  const context = buildSimulationContext({
    graph: input.graph,
    duration_attribute: input.duration_attribute,
    fallback_duration_attribute: input.fallback_duration_attribute,
    default_duration: input.default_duration,
  });

  const baselineOutput = simulateGraph(context, input.parallelism);
  const baselineWarnings = [...context.warnings, ...baselineOutput.warnings];
  const baselineOpId = `${opId}:baseline`;
  const baseline: GraphSimulateResult = {
    op_id: baselineOpId,
    graph: serialiseDescriptor(context.descriptor),
    schedule: baselineOutput.schedule,
    queue: baselineOutput.queue,
    metrics: baselineOutput.metrics,
    warnings: baselineWarnings,
  };
  const baselineObjective = evaluateOptimizeObjective(input.objective, {
    descriptor: context.descriptor,
    simulation: baselineOutput,
    parallelism: input.parallelism,
  });
  const objectiveValues = new Map<number, number>();
  objectiveValues.set(input.parallelism, baselineObjective.value);

  const candidateSet = new Set<number>();
  candidateSet.add(input.parallelism);
  const cap = Math.max(1, Math.min(input.max_parallelism, context.descriptor.nodes.length || input.max_parallelism));
  candidateSet.add(cap);
  if (input.explore_parallelism) {
    for (const value of input.explore_parallelism) {
      if (value >= 1 && value <= input.max_parallelism) {
        candidateSet.add(value);
      }
    }
  }

  const candidates = Array.from(candidateSet).sort((a, b) => a - b);
  const projections: GraphOptimizationProjection[] = [];
  const simulations = new Map<number, SimulationOutput>();
  simulations.set(input.parallelism, baselineOutput);

  for (const candidate of candidates) {
    let output = simulations.get(candidate);
    if (!output) {
      output = simulateGraph(context, candidate);
      simulations.set(candidate, output);
    }
    const evaluation = evaluateOptimizeObjective(input.objective, {
      descriptor: context.descriptor,
      simulation: output,
      parallelism: candidate,
    });
    objectiveValues.set(candidate, evaluation.value);
    projections.push({
      parallelism: candidate,
      makespan: output.metrics.makespan,
      utilisation: output.metrics.utilisation,
      total_wait_time: output.metrics.total_wait_time,
      average_concurrency: output.metrics.average_concurrency,
      objective_value: evaluation.value,
      objective_label: evaluation.attribute ?? evaluation.label,
    });
  }

  let bestCandidate = input.parallelism;
  let bestValue = baselineObjective.value;
  for (const projection of projections) {
    if (projection.parallelism === input.parallelism) {
      continue;
    }
    const candidateValue = objectiveValues.get(projection.parallelism)!;
    if (candidateValue + 1e-6 < bestValue) {
      bestValue = candidateValue;
      bestCandidate = projection.parallelism;
    }
  }

  const suggestions: GraphOptimizationSuggestion[] = [];
  if (bestCandidate !== input.parallelism) {
    const bestSimulation = simulations.get(bestCandidate)!;
    const projectedValue = objectiveValues.get(bestCandidate)!;
    const objectiveLabel = baselineObjective.attribute ?? baselineObjective.label;
    const improvement = Number((baselineObjective.value - projectedValue).toFixed(6));
    let description: string;
    if (input.objective.type === "makespan") {
      description = `Augmenter le parallélisme a ${bestCandidate} réduit le makespan de ${baseline.metrics.makespan.toFixed(2)} a ${bestSimulation.metrics.makespan.toFixed(2)}.`;
    } else if (input.objective.type === "cost") {
      description = `Augmenter le parallélisme a ${bestCandidate} réduit le coût total (${objectiveLabel}) de ${baselineObjective.value.toFixed(2)} a ${projectedValue.toFixed(2)}.`;
    } else {
      description = `Augmenter le parallélisme a ${bestCandidate} réduit le risque agrégé (${objectiveLabel}) de ${baselineObjective.value.toFixed(2)} a ${projectedValue.toFixed(2)}.`;
    }
    suggestions.push({
      type: "increase_parallelism",
      description,
      impact: {
        baseline_makespan: baseline.metrics.makespan,
        projected_makespan: bestSimulation.metrics.makespan,
        baseline_objective: baselineObjective.value,
        projected_objective: projectedValue,
        improvement,
        objective_label: objectiveLabel,
      },
      details: {
        baseline_queue_events: baseline.metrics.queue_events,
        projected_queue_events: bestSimulation.metrics.queue_events,
        projected_utilisation: bestSimulation.metrics.utilisation,
      },
    });
  }

  const criticalBottlenecks = baseline.schedule
    .filter((entry) => entry.critical)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((entry) => ({ node: entry.node_id, duration: entry.duration, slack: entry.slack }));
  if (criticalBottlenecks.length > 0) {
    suggestions.push({
      type: "critical_path_focus",
      description: `Les noeuds critiques ${criticalBottlenecks.map((item) => `'${item.node}'`).join(", ")} dominent la durée totale.`,
      impact: { baseline_makespan: baseline.metrics.makespan },
      details: { critical_nodes: criticalBottlenecks },
    });
  }

  if (baseline.queue.length > 0 && bestCandidate === input.parallelism) {
    const queuePreview = baseline.queue.slice(0, 5);
    suggestions.push({
      type: "rebalance_queue",
      description: "Certaines tâches attendent faute de ressources : reconsidérer les dépendances ou le parallélisme.",
      impact: { baseline_makespan: baseline.metrics.makespan },
      details: { queue: queuePreview },
    });
  }

  const slackByNode: Record<string, number> = {};
  for (const [nodeId, slack] of context.critical.slack.entries()) {
    slackByNode[nodeId] = Number(slack.toFixed(6));
  }

  const warnings = Array.from(new Set([...baseline.warnings]));

  return {
    op_id: opId,
    objective: {
      type: input.objective.type,
      label: baselineObjective.label,
      attribute: baselineObjective.attribute,
    },
    baseline,
    projections,
    suggestions,
    critical_path: {
      nodes: [...context.critical.criticalPath],
      duration: Number(context.critical.duration.toFixed(6)),
      slack_by_node: slackByNode,
    },
    warnings,
  };
}

/** Descriptor for a single optimisation objective used by `graph_optimize_moo`. */
const GraphOptimizeMooObjectiveSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("makespan"),
    label: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("cost"),
    label: z.string().min(1).optional(),
    attribute: z.string().min(1).default("cost"),
    default_value: z
      .number()
      .finite()
      .nonnegative("default_value must be non-negative")
      .default(0),
    parallel_penalty: z
      .number()
      .finite()
      .nonnegative("parallel_penalty must be non-negative")
      .default(0),
  }),
  z.object({
    type: z.literal("risk"),
    label: z.string().min(1).optional(),
    attribute: z.string().min(1).default("risk"),
    default_value: z
      .number()
      .finite()
      .nonnegative("default_value must be non-negative")
      .default(0),
    parallel_penalty: z
      .number()
      .finite()
      .nonnegative("parallel_penalty must be non-negative")
      .default(0),
    concurrency_penalty: z
      .number()
      .finite()
      .nonnegative("concurrency_penalty must be non-negative")
      .default(0),
  }),
]);

const GraphOptimizeMooInputShapeInternal = {
  graph: GraphDescriptorSchema,
  parallelism_candidates: z
    .array(
      z
        .number()
        .int("parallelism_candidates entries must be integers")
        .min(1, "parallelism must be at least 1")
        .max(64, "parallelism larger than 64 is not supported"),
    )
    .min(1, "at least one parallelism candidate must be provided"),
  objectives: z
    .array(GraphOptimizeMooObjectiveSchema)
    .min(2, "at least two objectives must be provided"),
  duration_attribute: z.string().min(1).default("duration"),
  fallback_duration_attribute: z.string().min(1).optional(),
  default_duration: z
    .number()
    .finite()
    .positive("default_duration must be strictly positive")
    .default(1),
  scalarization: z
    .object({
      method: z.literal("weighted_sum"),
      weights: z.record(z.string().min(1), z.number().finite().nonnegative()),
    })
    .optional(),
  op_id: z.string().trim().min(1).optional(),
} as const;

/** Input payload accepted by `graph_optimize_moo`. */
export const GraphOptimizeMooInputSchema = z
  .object(GraphOptimizeMooInputShapeInternal)
  .superRefine((input, ctx) => {
    const keys = new Set<string>();
    for (const objective of input.objectives) {
      const key = objective.label ?? objective.type;
      if (keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate objective label '${key}' detected`,
          path: ["objectives"],
        });
      }
      keys.add(key);
    }
    if (input.scalarization) {
      for (const objective of input.objectives) {
        const key = objective.label ?? objective.type;
        if (!(key in input.scalarization.weights)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `missing scalarization weight for objective '${key}'`,
            path: ["scalarization", "weights", key],
          });
        }
      }
    }
  });

export const GraphOptimizeMooInputShape = GraphOptimizeMooInputShapeInternal;

export type GraphOptimizeMooInput = z.infer<typeof GraphOptimizeMooInputSchema>;

export interface GraphOptimizeMooCandidate extends Record<string, unknown> {
  parallelism: number;
  objectives: Record<string, number>;
  metrics: GraphSimulateMetrics;
  warnings: string[];
  is_pareto: boolean;
}

export interface GraphOptimizeMooScalarization extends Record<string, unknown> {
  method: "weighted_sum";
  weights: Record<string, number>;
  ranking: Array<{ parallelism: number; score: number }>;
}

export interface GraphOptimizeMooResult extends Record<string, unknown> {
  op_id: string;
  objective_details: Array<{ key: string; type: string; label: string }>;
  candidates: GraphOptimizeMooCandidate[];
  pareto_front: GraphOptimizeMooCandidate[];
  scalarization?: GraphOptimizeMooScalarization;
  notes: string[];
}

/**
 * Explore the design space with several objective functions and surface the
 * Pareto frontier. Each objective is minimised; a solution is kept when no
 * other candidate strictly improves all tracked objectives at once.
 */
export function handleGraphOptimizeMoo(
  input: GraphOptimizeMooInput,
): GraphOptimizeMooResult {
  const opId = resolveOperationId(input.op_id, "graph_optimize_moo_op");
  const context = buildSimulationContext({
    graph: input.graph,
    duration_attribute: input.duration_attribute,
    fallback_duration_attribute: input.fallback_duration_attribute,
    default_duration: input.default_duration,
  });

  const objectives = normaliseMooObjectives(input.objectives);
  const uniqueParallelism = Array.from(new Set(input.parallelism_candidates)).sort((a, b) => a - b);
  const simulations = new Map<number, SimulationOutput>();
  const notes: string[] = [];

  if (uniqueParallelism.length !== input.parallelism_candidates.length) {
    notes.push("duplicate_parallelism_candidates_removed");
  }

  const candidates: GraphOptimizeMooCandidate[] = [];
  for (const parallelism of uniqueParallelism) {
    let simulation = simulations.get(parallelism);
    if (!simulation) {
      simulation = simulateGraph(context, parallelism);
      simulations.set(parallelism, simulation);
    }

    const objectiveValues = evaluateMooObjectives(objectives, {
      descriptor: context.descriptor,
      simulation,
      parallelism,
    });

    const combinedWarnings = Array.from(
      new Set([...context.warnings, ...simulation.warnings]),
    );

    candidates.push({
      parallelism,
      objectives: objectiveValues,
      metrics: simulation.metrics,
      warnings: combinedWarnings,
      is_pareto: false,
    });
  }

  const pareto = computeParetoFront(objectives, candidates);
  for (const candidate of candidates) {
    candidate.is_pareto = pareto.includes(candidate);
  }

  let scalarization: GraphOptimizeMooScalarization | undefined;
  if (input.scalarization) {
    const totalWeight = objectives.reduce(
      (sum, objective) => sum + (input.scalarization!.weights[objective.key] ?? 0),
      0,
    );
    if (totalWeight <= 0) {
      notes.push("scalarization_weights_sum_zero");
    } else {
      const normalisedWeights: Record<string, number> = {};
      for (const objective of objectives) {
        const raw = input.scalarization!.weights[objective.key] ?? 0;
        normalisedWeights[objective.key] = raw / totalWeight;
      }
      const ranking = candidates
        .map((candidate) => {
          let score = 0;
          for (const objective of objectives) {
            score += normalisedWeights[objective.key] * candidate.objectives[objective.key];
          }
          return {
            parallelism: candidate.parallelism,
            score: Number(score.toFixed(6)),
          };
        })
        .sort((a, b) => a.score - b.score || a.parallelism - b.parallelism);
      scalarization = {
        method: "weighted_sum",
        weights: normalisedWeights,
        ranking,
      };
    }
  }

  if (pareto.length === 0) {
    notes.push("no_pareto_candidate");
  }

  return {
    op_id: opId,
    objective_details: objectives.map((objective) => ({
      key: objective.key,
      type: objective.type,
      label: objective.label,
    })),
    candidates,
    pareto_front: pareto,
    scalarization,
    notes,
  };
}

/** Input payload accepted by `graph_causal_analyze`. */
export const GraphCausalAnalyzeInputSchema = z.object({
  graph: GraphDescriptorSchema,
  max_cycles: z
    .number()
    .int("max_cycles must be an integer")
    .positive("max_cycles must be strictly positive")
    .max(50, "max_cycles larger than 50 is not supported")
    .default(20),
  include_transitive_closure: z.boolean().default(true),
  compute_min_cut: z.boolean().default(true),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphCausalAnalyzeInputShape = GraphCausalAnalyzeInputSchema.shape;

export type GraphCausalAnalyzeInput = z.infer<typeof GraphCausalAnalyzeInputSchema>;

export interface GraphCausalFeedbackSuggestion extends Record<string, unknown> {
  remove: { from: string; to: string };
  score: number;
  reason: string;
}

export interface GraphCausalAnalyzeResult extends Record<string, unknown> {
  op_id: string;
  acyclic: boolean;
  entrypoints: string[];
  sinks: string[];
  topological_order: string[];
  ancestors: Record<string, string[]>;
  descendants: Record<string, string[]>;
  min_cut: { size: number; edges: Array<{ from: string; to: string }> } | null;
  cycles: string[][];
  feedback_arc_suggestions: GraphCausalFeedbackSuggestion[];
  notes: string[];
}

/**
 * Perform a causal inspection of the graph. When the structure is acyclic the
 * helper returns a deterministic topological ordering, ancestor/descendant
 * closures, and a minimal edge cut separating entrypoints from sinks. When
 * cycles are present it reports them and surfaces candidate edges to remove in
 * order to break the feedback loops.
 */
export function handleGraphCausalAnalyze(
  input: GraphCausalAnalyzeInput,
): GraphCausalAnalyzeResult {
  const opId = resolveOperationId(input.op_id, "graph_causal_analyze_op");
  const descriptor = normaliseDescriptor(input.graph);
  const { adjacency, indegree } = buildAdjacencyInfo(descriptor);
  const incoming = buildIncomingMap(descriptor);
  const entrypoints = Array.from(indegree.entries())
    .filter(([, value]) => value === 0)
    .map(([id]) => id)
    .sort();
  const sinks = descriptor.nodes
    .filter((node) => (adjacency.get(node.id) ?? []).length === 0)
    .map((node) => node.id)
    .sort();

  const cycleInfo = detectCyclesInternal(adjacency, input.max_cycles);
  const notes: string[] = [];

  if (cycleInfo.hasCycle) {
    notes.push(`cycles_detected (${cycleInfo.cycles.length})`);
  }

  let topologicalOrder: string[] = [];
  if (!cycleInfo.hasCycle) {
    topologicalOrder = computeTopologicalOrder(descriptor, adjacency, indegree);
  }

  const ancestors = input.include_transitive_closure
    ? cycleInfo.hasCycle
      ? computeAncestorsWithBfs(descriptor, incoming)
      : computeAncestorsFromOrder(topologicalOrder, incoming)
    : new Map<string, string[]>();

  const descendants = input.include_transitive_closure
    ? cycleInfo.hasCycle
      ? computeDescendantsWithBfs(descriptor, adjacency)
      : computeDescendantsFromOrder(topologicalOrder, adjacency)
    : new Map<string, string[]>();

  const minCut = !cycleInfo.hasCycle && input.compute_min_cut
    ? computeMinimumEdgeCut(descriptor, adjacency, indegree, entrypoints, sinks)
    : null;

  const feedback = cycleInfo.hasCycle
    ? computeFeedbackArcSuggestions(cycleInfo.cycles, descriptor)
    : [];

  if (cycleInfo.hasCycle && feedback.length === 0) {
    notes.push("no_feedback_arc_suggestion");
  }
  if (!cycleInfo.hasCycle && entrypoints.length === 0) {
    notes.push("no_entrypoint_detected");
  }
  if (!cycleInfo.hasCycle && sinks.length === 0) {
    notes.push("no_sink_detected");
  }

  return {
    op_id: opId,
    acyclic: !cycleInfo.hasCycle,
    entrypoints,
    sinks,
    topological_order: topologicalOrder,
    ancestors: mapToSortedRecord(ancestors),
    descendants: mapToSortedRecord(descendants),
    min_cut: minCut,
    cycles: cycleInfo.cycles.map((cycle) => [...cycle]),
    feedback_arc_suggestions: feedback,
    notes,
  };
}

interface NormalisedMooObjective {
  key: string;
  type: "makespan" | "cost" | "risk";
  label: string;
  attribute?: string;
  defaultValue?: number;
  parallelPenalty?: number;
  concurrencyPenalty?: number;
}

function normaliseMooObjectives(
  objectives: Array<z.infer<typeof GraphOptimizeMooObjectiveSchema>>,
): NormalisedMooObjective[] {
  return objectives.map((objective) => {
    switch (objective.type) {
      case "makespan":
        return {
          key: objective.label ?? "makespan",
          type: "makespan",
          label: objective.label ?? "makespan",
        } satisfies NormalisedMooObjective;
      case "cost":
        return {
          key: objective.label ?? "cost",
          type: "cost",
          label: objective.label ?? "cost",
          attribute: objective.attribute,
          defaultValue: objective.default_value,
          parallelPenalty: objective.parallel_penalty,
        } satisfies NormalisedMooObjective;
      case "risk":
        return {
          key: objective.label ?? "risk",
          type: "risk",
          label: objective.label ?? "risk",
          attribute: objective.attribute,
          defaultValue: objective.default_value,
          parallelPenalty: objective.parallel_penalty,
          concurrencyPenalty: objective.concurrency_penalty,
        } satisfies NormalisedMooObjective;
    }
  });
}

function evaluateMooObjectives(
  objectives: NormalisedMooObjective[],
  context: {
    descriptor: NormalisedGraph;
    simulation: SimulationOutput;
    parallelism: number;
  },
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const objective of objectives) {
    switch (objective.type) {
      case "makespan":
        values[objective.key] = context.simulation.metrics.makespan;
        break;
      case "cost": {
        const base = accumulateNodeAttribute(
          context.descriptor,
          objective.attribute!,
          objective.defaultValue ?? 0,
        );
        const penalty = (objective.parallelPenalty ?? 0) * context.parallelism;
        values[objective.key] = Number((base + penalty).toFixed(6));
        break;
      }
      case "risk": {
        const base = accumulateNodeAttribute(
          context.descriptor,
          objective.attribute!,
          objective.defaultValue ?? 0,
        );
        const parallelPenalty = (objective.parallelPenalty ?? 0) * Math.max(0, context.parallelism - 1);
        const concurrencyPenalty =
          (objective.concurrencyPenalty ?? 0) * context.simulation.metrics.max_concurrency;
        values[objective.key] = Number((base + parallelPenalty + concurrencyPenalty).toFixed(6));
        break;
      }
    }
  }
  return values;
}

function computeParetoFront(
  objectives: NormalisedMooObjective[],
  candidates: GraphOptimizeMooCandidate[],
): GraphOptimizeMooCandidate[] {
  const front: GraphOptimizeMooCandidate[] = [];
  for (const candidate of candidates) {
    let dominated = false;
    for (const other of candidates) {
      if (other === candidate) {
        continue;
      }
      if (dominates(other, candidate, objectives)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      front.push(candidate);
    }
  }
  return front;
}

function dominates(
  candidate: GraphOptimizeMooCandidate,
  other: GraphOptimizeMooCandidate,
  objectives: NormalisedMooObjective[],
): boolean {
  let strictlyBetter = false;
  for (const objective of objectives) {
    const a = candidate.objectives[objective.key];
    const b = other.objectives[objective.key];
    if (a > b + 1e-9) {
      return false;
    }
    if (a + 1e-9 < b) {
      strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

function accumulateNodeAttribute(
  descriptor: NormalisedGraph,
  attribute: string,
  defaultValue: number,
): number {
  let total = 0;
  for (const node of descriptor.nodes) {
    const value = coerceNonNegativeNumber(node.attributes[attribute]);
    total += typeof value === "number" ? value : defaultValue;
  }
  return Number(total.toFixed(6));
}

function coerceNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function buildIncomingMap(
  descriptor: NormalisedGraph,
): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const node of descriptor.nodes) {
    incoming.set(node.id, []);
  }
  for (const edge of descriptor.edges) {
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, []);
    }
    incoming.get(edge.to)!.push(edge.from);
  }
  for (const list of incoming.values()) {
    list.sort();
  }
  return incoming;
}

function computeAncestorsFromOrder(
  order: string[],
  incoming: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const memo = new Map<string, Set<string>>();
  for (const nodeId of order) {
    const parents = incoming.get(nodeId) ?? [];
    const aggregate = new Set<string>();
    for (const parent of parents) {
      aggregate.add(parent);
      const parentSet = memo.get(parent);
      if (parentSet) {
        for (const ancestor of parentSet) {
          aggregate.add(ancestor);
        }
      }
    }
    const sorted = Array.from(aggregate).sort();
    memo.set(nodeId, aggregate);
    result.set(nodeId, sorted);
  }
  return result;
}

function computeDescendantsFromOrder(
  order: string[],
  adjacency: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const memo = new Map<string, Set<string>>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const nodeId = order[index];
    const children = adjacency.get(nodeId) ?? [];
    const aggregate = new Set<string>();
    for (const child of children) {
      aggregate.add(child);
      const childSet = memo.get(child);
      if (childSet) {
        for (const descendant of childSet) {
          aggregate.add(descendant);
        }
      }
    }
    const sorted = Array.from(aggregate).sort();
    memo.set(nodeId, aggregate);
    result.set(nodeId, sorted);
  }
  return result;
}

function computeAncestorsWithBfs(
  descriptor: NormalisedGraph,
  incoming: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const node of descriptor.nodes) {
    const visited = new Set<string>();
    const queue = [...(incoming.get(node.id) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const parent of incoming.get(current) ?? []) {
        if (!visited.has(parent)) {
          queue.push(parent);
        }
      }
    }
    result.set(node.id, Array.from(visited).sort());
  }
  return result;
}

function computeDescendantsWithBfs(
  descriptor: NormalisedGraph,
  adjacency: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const node of descriptor.nodes) {
    const visited = new Set<string>();
    const queue = [...(adjacency.get(node.id) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }
    result.set(node.id, Array.from(visited).sort());
  }
  return result;
}

function mapToSortedRecord(
  map: Map<string, string[]>,
): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  for (const [key, value] of map.entries()) {
    record[key] = [...value];
  }
  return record;
}

function computeMinimumEdgeCut(
  descriptor: NormalisedGraph,
  _adjacency: Map<string, string[]>,
  _indegree: Map<string, number>,
  entrypoints: string[],
  sinks: string[],
): { size: number; edges: Array<{ from: string; to: string }> } | null {
  if (entrypoints.length === 0 || sinks.length === 0) {
    return null;
  }

  const nodes = descriptor.nodes.map((node) => node.id);
  const index = new Map<string, number>();
  nodes.forEach((id, idx) => index.set(id, idx));
  const source = nodes.length;
  const target = nodes.length + 1;

  const capacity = new Map<number, Map<number, number>>();
  const neighbours = new Map<number, Set<number>>();

  const addEdge = (from: number, to: number, cap: number) => {
    if (!capacity.has(from)) {
      capacity.set(from, new Map());
    }
    if (!capacity.has(to)) {
      capacity.set(to, new Map());
    }
    const current = capacity.get(from)!.get(to) ?? 0;
    capacity.get(from)!.set(to, current + cap);
    if (!capacity.get(to)!.has(from)) {
      capacity.get(to)!.set(from, 0);
    }
    if (!neighbours.has(from)) {
      neighbours.set(from, new Set());
    }
    if (!neighbours.has(to)) {
      neighbours.set(to, new Set());
    }
    neighbours.get(from)!.add(to);
    neighbours.get(to)!.add(from);
  };

  const bigCapacity = nodes.length || 1;
  for (const entry of entrypoints) {
    const idx = index.get(entry);
    if (idx !== undefined) {
      addEdge(source, idx, bigCapacity);
    }
  }
  for (const sink of sinks) {
    const idx = index.get(sink);
    if (idx !== undefined) {
      addEdge(idx, target, bigCapacity);
    }
  }
  for (const edge of descriptor.edges) {
    const fromIdx = index.get(edge.from);
    const toIdx = index.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) {
      continue;
    }
    addEdge(fromIdx, toIdx, 1);
  }

  const bfs = (): { parent: Map<number, number>; bottleneck: number } | null => {
    const parent = new Map<number, number>();
    const visited = new Set<number>();
    const queue: Array<{ node: number; flow: number }> = [{ node: source, flow: Number.POSITIVE_INFINITY }];
    visited.add(source);
    while (queue.length > 0) {
      const { node, flow } = queue.shift()!;
      for (const neighbour of neighbours.get(node) ?? []) {
        if (visited.has(neighbour)) {
          continue;
        }
        const residual = capacity.get(node)?.get(neighbour) ?? 0;
        if (residual <= 0) {
          continue;
        }
        parent.set(neighbour, node);
        const nextFlow = Math.min(flow, residual);
        if (neighbour === target) {
          return { parent, bottleneck: nextFlow };
        }
        visited.add(neighbour);
        queue.push({ node: neighbour, flow: nextFlow });
      }
    }
    return null;
  };

  let maxFlow = 0;
  while (true) {
    const path = bfs();
    if (!path) {
      break;
    }
    let current = target;
    while (current !== source) {
      const prev = path.parent.get(current)!;
      const residual = capacity.get(prev)!.get(current)!;
      capacity.get(prev)!.set(current, residual - path.bottleneck);
      const reverseResidual = capacity.get(current)!.get(prev)!;
      capacity.get(current)!.set(prev, reverseResidual + path.bottleneck);
      current = prev;
    }
    maxFlow += path.bottleneck;
    if (maxFlow > nodes.length) {
      break;
    }
  }

  const reachable = new Set<number>();
  const stack: number[] = [source];
  reachable.add(source);
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const neighbour of neighbours.get(node) ?? []) {
      if (reachable.has(neighbour)) {
        continue;
      }
      const residual = capacity.get(node)?.get(neighbour) ?? 0;
      if (residual > 0) {
        reachable.add(neighbour);
        stack.push(neighbour);
      }
    }
  }

  const cutEdges: Array<{ from: string; to: string }> = [];
  for (const edge of descriptor.edges) {
    const fromIdx = index.get(edge.from);
    const toIdx = index.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) {
      continue;
    }
    if (reachable.has(fromIdx) && !reachable.has(toIdx)) {
      cutEdges.push({ from: edge.from, to: edge.to });
    }
  }

  cutEdges.sort((a, b) => {
    if (a.from === b.from) {
      return a.to.localeCompare(b.to);
    }
    return a.from.localeCompare(b.from);
  });

  return { size: cutEdges.length, edges: cutEdges };
}

function computeFeedbackArcSuggestions(
  cycles: string[][],
  descriptor: NormalisedGraph,
): GraphCausalFeedbackSuggestion[] {
  const counter = new Map<string, { from: string; to: string; count: number }>();
  for (const cycle of cycles) {
    if (cycle.length < 2) {
      continue;
    }
    for (let index = 0; index < cycle.length - 1; index += 1) {
      const from = cycle[index];
      const to = cycle[index + 1];
      const key = `${from}->${to}`;
      const entry = counter.get(key) ?? { from, to, count: 0 };
      entry.count += 1;
      counter.set(key, entry);
    }
  }

  const weightLookup = new Map<string, number>();
  for (const edge of descriptor.edges) {
    const key = `${edge.from}->${edge.to}`;
    if (typeof edge.weight === "number") {
      weightLookup.set(key, edge.weight);
    } else if (typeof edge.attributes.weight === "number") {
      weightLookup.set(key, Number(edge.attributes.weight));
    }
  }

  const suggestions = Array.from(counter.values())
    .map((entry) => {
      const weight = weightLookup.get(`${entry.from}->${entry.to}`) ?? 1;
      return {
        remove: { from: entry.from, to: entry.to },
        score: entry.count,
        reason:
          entry.count > 1
            ? `edge participates in ${entry.count} cycles (weight=${weight})`
            : `edge closes a cycle (weight=${weight})`,
      } satisfies GraphCausalFeedbackSuggestion;
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.remove.from === b.remove.from) {
        return a.remove.to.localeCompare(b.remove.to);
      }
      return a.remove.from.localeCompare(b.remove.from);
    });

  return suggestions.slice(0, 10);
}
