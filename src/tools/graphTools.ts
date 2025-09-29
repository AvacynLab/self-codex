import { z } from "zod";

interface GraphForgeModelInstance {
  listNodes(): Array<{ id: string }>;
  listEdges(): Array<{ from: string; to: string; attributes: Record<string, string | number | boolean> }>;
  getNode(id: string): { id: string } | undefined;
  getOutgoing(id: string): Array<{ from: string; to: string; attributes: Record<string, string | number | boolean> }>;
}

interface GraphForgeEdgeCostDescriptor {
  readonly attribute: string;
  readonly defaultValue?: number;
  readonly scale?: number;
}

type GraphForgeModule = {
  readonly GraphModel: new (
    name: string,
    nodes: Array<{ id: string; attributes: Record<string, string | number | boolean> }>,
    edges: Array<{ from: string; to: string; attributes: Record<string, string | number | boolean> }>,
    directives: Map<string, string | number | boolean>,
  ) => GraphForgeModelInstance;
  readonly kShortestPaths: (
    graph: GraphForgeModelInstance,
    start: string,
    goal: string,
    k: number,
    options?: {
      readonly weightAttribute?: string;
      readonly costFunction?: GraphForgeEdgeCostDescriptor | string | ((edge: unknown, graph: unknown) => number);
      readonly maxDeviation?: number;
    },
  ) => Array<{ distance: number; path: string[]; visitedOrder: string[] }>;
  readonly shortestPath: (
    graph: GraphForgeModelInstance,
    start: string,
    goal: string,
    options?: {
      readonly weightAttribute?: string;
      readonly costFunction?: GraphForgeEdgeCostDescriptor | string | ((edge: unknown, graph: unknown) => number);
    },
  ) => { distance: number; path: string[]; visitedOrder: string[] };
  readonly betweennessCentrality: (
    graph: GraphForgeModelInstance,
    options?: {
      readonly weighted?: boolean;
      readonly weightAttribute?: string;
      readonly costFunction?: GraphForgeEdgeCostDescriptor | string | ((edge: unknown, graph: unknown) => number);
      readonly normalise?: boolean;
    },
  ) => Array<{ node: string; score: number }>;
};

const graphForgeModuleUrl = new URL("../../graph-forge/dist/index.js", import.meta.url);
const {
  GraphModel,
  betweennessCentrality,
  kShortestPaths,
  shortestPath,
} = (await import(graphForgeModuleUrl.href)) as GraphForgeModule;


/** Allowed attribute value stored on nodes/edges. */
export const GraphAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

/** Record of safe attributes persisted on nodes/edges. */
export const GraphAttributeRecordSchema = z.record(GraphAttributeValueSchema);

/** Descriptor for a node accepted by the graph tools. */
export const GraphNodeSchema = z.object({
  id: z
    .string()
    .min(1, "node id must be provided"),
  label: z.string().optional(),
  attributes: GraphAttributeRecordSchema.optional(),
});

/** Descriptor for an edge accepted by the graph tools. */
export const GraphEdgeSchema = z.object({
  from: z
    .string()
    .min(1, "edge source must be provided"),
  to: z
    .string()
    .min(1, "edge target must be provided"),
  label: z.string().optional(),
  weight: z.number().finite().nonnegative().optional(),
  attributes: GraphAttributeRecordSchema.optional(),
});

/** Graph payload shared between every graph-centric tool. */
export const GraphDescriptorSchema = z.object({
  name: z.string().min(1).default("workflow"),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  metadata: GraphAttributeRecordSchema.optional(),
});

/**
 * Internal representation used once the payload has been validated by the
 * schemata above. Every node keeps its insertion order to ensure deterministic
 * summaries and serialisations.
 */
interface NormalisedGraphDescriptor {
  name: string;
  nodes: NormalisedNode[];
  edges: NormalisedEdge[];
  metadata: Record<string, string | number | boolean>;
}

interface NormalisedNode {
  id: string;
  label?: string;
  attributes: Record<string, string | number | boolean>;
}

interface NormalisedEdge {
  from: string;
  to: string;
  label?: string;
  weight?: number;
  attributes: Record<string, string | number | boolean>;
}

/** Blueprint describing a single task when generating a graph. */
const TaskDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  duration: z.number().finite().positive().optional(),
  weight: z.number().finite().nonnegative().optional(),
  metadata: GraphAttributeRecordSchema.optional(),
});

/**
 * Textual representation accepted by the generator. Each non-empty line
 * produces one task using the following grammar (whitespace tolerant):
 *
 * ```text
 * <task_id> [":" <label>] ["->" <dep>["," <dep> ...]]
 * ```
 *
 * When the dependency section is omitted the generator will automatically
 * connect the task to the previous line, effectively yielding a simple chain.
 */
const TaskTextSchema = z
  .string()
  .trim()
  .min(1, "tasks text must not be empty");

/**
 * Union describing every acceptable representation for the `tasks` field of the
 * generator tool.
 */
const TaskSourceSchema = z.union([
  z.array(TaskDescriptorSchema),
  z.object({ tasks: z.array(TaskDescriptorSchema) }),
  TaskTextSchema,
]);

const PresetSchema = z.enum([
  "lint_test_build_package",
  "analysis_ci_pipeline",
]);

/** Input payload accepted by `graph_generate`. */
export const GraphGenerateInputSchema = z.object({
  name: z.string().min(1).default("workflow"),
  preset: PresetSchema.optional(),
  tasks: TaskSourceSchema.optional(),
  default_weight: z.number().finite().positive().optional(),
});

export const GraphGenerateInputShape = GraphGenerateInputSchema.shape;

export type GraphGenerateInput = z.infer<typeof GraphGenerateInputSchema>;

export interface GraphNodePayload extends Record<string, unknown> {
  id: string;
  label?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface GraphEdgePayload extends Record<string, unknown> {
  from: string;
  to: string;
  label?: string;
  weight?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface GraphDescriptorPayload extends Record<string, unknown> {
  name: string;
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
  metadata?: Record<string, string | number | boolean>;
}

export interface GraphGenerateResult extends Record<string, unknown> {
  graph: GraphDescriptorPayload;
  task_count: number;
  edge_count: number;
  notes: string[];
}

interface TaskDefinition {
  id: string;
  label?: string;
  dependsOn: string[];
  duration?: number;
  weight?: number;
  metadata?: Record<string, string | number | boolean>;
  synthetic?: boolean;
}

const PRESET_LIBRARY: Record<string, TaskDefinition[]> = {
  lint_test_build_package: [
    { id: "lint", label: "Lint", dependsOn: [], duration: 3, weight: 1 },
    { id: "test", label: "Unit tests", dependsOn: ["lint"], duration: 10, weight: 5 },
    { id: "build", label: "Build", dependsOn: ["test"], duration: 8, weight: 3 },
    { id: "package", label: "Package", dependsOn: ["build"], duration: 2, weight: 1 },
  ],
  analysis_ci_pipeline: [
    { id: "lint", label: "Lint", dependsOn: [], duration: 2, weight: 1 },
    { id: "typecheck", label: "Type-check", dependsOn: ["lint"], duration: 4, weight: 2 },
    { id: "test", label: "Tests", dependsOn: ["typecheck"], duration: 12, weight: 6 },
    { id: "report", label: "Report", dependsOn: ["test"], duration: 3, weight: 1 },
  ],
};

/**
 * Generate a labelled dependency graph from textual or structured task
 * descriptions.
 */
export function handleGraphGenerate(
  input: GraphGenerateInput,
): GraphGenerateResult {
  const tasks = normaliseTasks(input);
  const defaultWeight = input.default_weight ?? 1;

  const nodes = new Map<string, TaskDefinition>();
  const order: string[] = [];

  for (const task of tasks) {
    const existing = nodes.get(task.id);
    if (existing) {
      nodes.set(task.id, {
        ...existing,
        label: task.label ?? existing.label,
        dependsOn: dedupe([...existing.dependsOn, ...task.dependsOn]),
        duration: task.duration ?? existing.duration,
        weight: task.weight ?? existing.weight,
        metadata: { ...existing.metadata, ...task.metadata },
        synthetic: existing.synthetic && task.synthetic,
      });
    } else {
      nodes.set(task.id, task);
      order.push(task.id);
    }

    for (const dep of task.dependsOn) {
      if (!nodes.has(dep)) {
        nodes.set(dep, {
          id: dep,
          label: dep,
          dependsOn: [],
          synthetic: true,
        });
        order.push(dep);
      }
    }
  }

  const descriptor: NormalisedGraphDescriptor = {
    name: input.name,
    nodes: [],
    edges: [],
    metadata: {},
  };

  const seen = new Set<string>();
  for (const id of order) {
    const task = nodes.get(id)!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const attributes: Record<string, string | number | boolean> = {
      kind: "task",
    };
    if (task.label) {
      attributes.label = task.label;
    }
    if (typeof task.duration === "number") {
      attributes.duration = task.duration;
    }
    if (typeof task.weight === "number") {
      attributes.weight = task.weight;
    }
    if (task.synthetic) {
      attributes.synthetic = true;
    }
    if (task.metadata) {
      for (const [key, value] of Object.entries(task.metadata)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          attributes[key] = value;
        }
      }
    }
    descriptor.nodes.push({ id: task.id, label: task.label, attributes });
  }

  const edgeSet = new Set<string>();
  for (const task of nodes.values()) {
    for (const dependency of task.dependsOn) {
      const key = `${dependency}->${task.id}`;
      if (edgeSet.has(key)) {
        continue;
      }
      edgeSet.add(key);
      const weight = task.weight ?? defaultWeight;
      const attributes: Record<string, string | number | boolean> = {
        kind: "dependency",
        weight,
      };
      descriptor.edges.push({
        from: dependency,
        to: task.id,
        weight,
        attributes,
      });
    }
  }

  return {
    graph: serialiseDescriptor(descriptor),
    task_count: tasks.filter((task) => !task.synthetic).length,
    edge_count: descriptor.edges.length,
    notes: tasks.some((task) => task.synthetic === true)
      ? ["synthetic nodes were added for undeclared dependencies"]
      : [],
  };
}

/** Input payload accepted by `graph_mutate`. */
export const GraphMutateInputSchema = z.object({
  graph: GraphDescriptorSchema,
  operations: z
    .array(
      z.discriminatedUnion("op", [
        z.object({ op: z.literal("add_node"), node: GraphNodeSchema }),
        z.object({ op: z.literal("remove_node"), id: z.string().min(1) }),
        z.object({ op: z.literal("rename_node"), id: z.string().min(1), new_id: z.string().min(1) }),
        z.object({ op: z.literal("add_edge"), edge: GraphEdgeSchema }),
        z.object({ op: z.literal("remove_edge"), from: z.string().min(1), to: z.string().min(1) }),
        z.object({ op: z.literal("set_node_attribute"), id: z.string().min(1), key: z.string().min(1), value: GraphAttributeValueSchema.nullable() }),
        z.object({ op: z.literal("set_edge_attribute"), from: z.string().min(1), to: z.string().min(1), key: z.string().min(1), value: GraphAttributeValueSchema.nullable() }),
      ]),
    )
    .min(1, "at least one operation must be provided"),
});

export const GraphMutateInputShape = GraphMutateInputSchema.shape;

export type GraphMutateInput = z.infer<typeof GraphMutateInputSchema>;

export interface GraphMutationRecord {
  op: string;
  description: string;
  changed: boolean;
}

export interface GraphMutateResult extends Record<string, unknown> {
  graph: GraphDescriptorPayload;
  applied: GraphMutationRecord[];
}

/** Apply idempotent graph operations, returning the mutated graph. */
export function handleGraphMutate(input: GraphMutateInput): GraphMutateResult {
  const descriptor = normaliseDescriptor(input.graph);
  const applied: GraphMutationRecord[] = [];

  for (const operation of input.operations) {
    switch (operation.op) {
      case "add_node":
        applied.push(applyAddNode(descriptor, operation.node));
        break;
      case "remove_node":
        applied.push(applyRemoveNode(descriptor, operation.id));
        break;
      case "rename_node":
        applied.push(applyRenameNode(descriptor, operation.id, operation.new_id));
        break;
      case "add_edge":
        applied.push(applyAddEdge(descriptor, operation.edge));
        break;
      case "remove_edge":
        applied.push(applyRemoveEdge(descriptor, operation.from, operation.to));
        break;
      case "set_node_attribute":
        applied.push(applySetNodeAttribute(descriptor, operation.id, operation.key, operation.value));
        break;
      case "set_edge_attribute":
        applied.push(applySetEdgeAttribute(descriptor, operation.from, operation.to, operation.key, operation.value));
        break;
    }
  }

  return { graph: serialiseDescriptor(descriptor), applied };
}

/** Input payload accepted by `graph_validate`. */
export const GraphValidateInputSchema = z.object({
  graph: GraphDescriptorSchema,
  strict_weights: z.boolean().optional(),
  cycle_limit: z.number().int().positive().max(100).default(20),
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
});

export const GraphSummarizeInputShape = GraphSummarizeInputSchema.shape;

export type GraphSummarizeInput = z.infer<typeof GraphSummarizeInputSchema>;

export interface GraphSummarizeResult extends Record<string, unknown> {
  graph: GraphDescriptorPayload;
  layers: { index: number; nodes: string[] }[];
  metrics: {
    node_count: number;
    edge_count: number;
    average_in_degree: number;
    average_out_degree: number;
    density: number;
  };
  critical_nodes: { node: string; score: number }[];
  notes: string[];
}

/** Provide a human readable summary for the provided graph. */
export function handleGraphSummarize(input: GraphSummarizeInput): GraphSummarizeResult {
  const descriptor = normaliseDescriptor(input.graph);
  const { adjacency, indegree, outdegree } = buildAdjacencyInfo(descriptor);

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
    graph: serialiseDescriptor(descriptor),
    layers: layers.map((nodes, index) => ({ index, nodes })),
    metrics: {
      node_count: nodeCount,
      edge_count: edgeCount,
      average_in_degree: Number(averageIn.toFixed(3)),
      average_out_degree: Number(averageOut.toFixed(3)),
      density: Number(density.toFixed(5)),
    },
    critical_nodes,
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
  const descriptor = normaliseDescriptor(input.graph);
  assertNodeExists(descriptor, input.from, "start");
  assertNodeExists(descriptor, input.to, "goal");

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
});

export const GraphPathsConstrainedInputShape = GraphPathsConstrainedInputSchema.shape;

export type GraphPathsConstrainedInput = z.infer<typeof GraphPathsConstrainedInputSchema>;

export interface GraphPathsConstrainedResult extends Record<string, unknown> {
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
  const descriptor = normaliseDescriptor(input.graph);
  assertNodeExists(descriptor, input.from, "start");
  assertNodeExists(descriptor, input.to, "goal");

  const avoidNodes = new Set(input.avoid_nodes);
  const avoidEdges = new Set(input.avoid_edges.map((edge) => `${edge.from}->${edge.to}`));

  const filteredNodes = descriptor.nodes.filter((node) => !avoidNodes.has(node.id));
  const filteredEdges = descriptor.edges.filter((edge) => {
    if (avoidNodes.has(edge.from) || avoidNodes.has(edge.to)) {
      return false;
    }
    return !avoidEdges.has(`${edge.from}->${edge.to}`);
  });

  const removedNodeCount = descriptor.nodes.length - filteredNodes.length;
  const removedEdgeCount = descriptor.edges.length - filteredEdges.length;

  const violations: string[] = [];
  if (avoidNodes.has(input.from)) {
    violations.push(`start node '${input.from}' is excluded by avoid_nodes`);
  }
  if (avoidNodes.has(input.to)) {
    violations.push(`goal node '${input.to}' is excluded by avoid_nodes`);
  }
  if (violations.length > 0) {
    return {
      status: "unreachable",
      reason: "START_OR_GOAL_EXCLUDED",
      path: [],
      cost: null,
      visited: [],
      weight_attribute: input.weight_attribute,
      cost_attribute: typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null,
      filtered: { nodes: removedNodeCount, edges: removedEdgeCount },
      violations,
      notes: ["start_or_goal_excluded"],
    };
  }

  const filteredDescriptor: NormalisedGraphDescriptor = {
    name: descriptor.name,
    nodes: filteredNodes,
    edges: filteredEdges,
    metadata: descriptor.metadata,
  };

  const graph = descriptorToGraphModel(filteredDescriptor);
  const costConfig = normaliseCostConfig(input.cost);
  const result = shortestPath(graph, input.from, input.to, {
    weightAttribute: input.weight_attribute,
    costFunction: costConfig,
  });

  if (!result.path.length) {
    return {
      status: "unreachable",
      reason: "NO_PATH",
      path: [],
      cost: null,
      visited: result.visitedOrder,
      weight_attribute: input.weight_attribute,
      cost_attribute: typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null,
      filtered: { nodes: removedNodeCount, edges: removedEdgeCount },
      violations,
      notes: removedNodeCount + removedEdgeCount > 0 ? ["constraints_pruned_graph"] : [],
    };
  }

  const totalCost = Number(result.distance.toFixed(6));
  if (typeof input.max_cost === "number" && totalCost > input.max_cost) {
    return {
      status: "cost_exceeded",
      reason: "MAX_COST_EXCEEDED",
      path: [...result.path],
      cost: totalCost,
      visited: result.visitedOrder,
      weight_attribute: input.weight_attribute,
      cost_attribute: typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null,
      filtered: { nodes: removedNodeCount, edges: removedEdgeCount },
      violations,
      max_cost: input.max_cost,
      notes: ["cost_budget_exceeded"],
    };
  }

  return {
    status: "found",
    reason: null,
    path: [...result.path],
    cost: totalCost,
    visited: result.visitedOrder,
    weight_attribute: input.weight_attribute,
    cost_attribute: typeof input.cost === "string" ? input.cost : input.cost?.attribute ?? null,
    filtered: { nodes: removedNodeCount, edges: removedEdgeCount },
    violations,
    notes: removedNodeCount + removedEdgeCount > 0 ? ["constraints_pruned_graph"] : [],
  };
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
});

export const GraphCentralityBetweennessInputShape = GraphCentralityBetweennessInputSchema.shape;

export type GraphCentralityBetweennessInput = z.infer<typeof GraphCentralityBetweennessInputSchema>;

export interface GraphCentralityBetweennessResult extends Record<string, unknown> {
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
  const descriptor = normaliseDescriptor(input.graph);
  const graph = descriptorToGraphModel(descriptor);
  const costConfig = normaliseCostConfig(input.cost);

  const scores = betweennessCentrality(graph, {
    weighted: input.weighted,
    weightAttribute: input.weight_attribute,
    costFunction: costConfig,
    normalise: input.normalise,
  });

  const sorted: Array<{ node: string; score: number }> = scores
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

  const top = sorted.slice(0, Math.min(input.top_k, sorted.length));
  const statistics = computeScoreStatistics(sorted);
  const notes = sorted.length === 0 ? ["graph_has_no_nodes"] : [];

  return {
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

function normaliseTasks(input: GraphGenerateInput): TaskDefinition[] {
  const tasks: TaskDefinition[] = [];
  if (input.preset) {
    tasks.push(...(PRESET_LIBRARY[input.preset] ?? []));
  }
  if (!input.tasks) {
    if (tasks.length === 0) {
      throw new Error("either preset or tasks must be provided");
    }
    return tasks;
  }
  const parsed = parseTaskSource(input.tasks);
  tasks.push(...parsed);
  return tasks;
}

function parseTaskSource(source: z.infer<typeof TaskSourceSchema>): TaskDefinition[] {
  if (Array.isArray(source)) {
    return source.map((task) => ({
      id: task.id,
      label: task.label,
      dependsOn: dedupe(task.depends_on ?? []),
      duration: task.duration,
      weight: task.weight,
      metadata: task.metadata,
    }));
  }
  if (typeof source === "string") {
    return parseTextTasks(source);
  }
  return parseTaskSource(source.tasks);
}

function parseTextTasks(source: string): TaskDefinition[] {
  const tasks: TaskDefinition[] = [];
  const seen = new Set<string>();
  let previous: string | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [left, right] = line.split("->").map((part) => part.trim());
    const dependencies = right
      ? right
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
      : [];

    let idSegment = left;
    let label: string | undefined;
    const colonIndex = left.indexOf(":");
    if (colonIndex >= 0) {
      idSegment = left.slice(0, colonIndex).trim();
      label = left.slice(colonIndex + 1).trim();
    }
    const id = idSegment;
    if (!id) {
      throw new Error(`unable to parse task identifier from line '${line}'`);
    }

    const dependsOn = dependencies.length > 0 ? dependencies : previous ? [previous] : [];
    tasks.push({ id, label, dependsOn });
    previous = id;
    seen.add(id);
  }

  if (tasks.length === 0) {
    throw new Error("no tasks could be parsed from the provided text");
  }

  return tasks;
}

function normaliseDescriptor(graph: z.infer<typeof GraphDescriptorSchema>): NormalisedGraphDescriptor {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    attributes: filterAttributes({
      ...node.attributes,
      ...(node.label ? { label: node.label } : {}),
    }),
  }));
  const edges = graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    weight: edge.weight,
    attributes: filterAttributes({
      ...edge.attributes,
      ...(edge.label ? { label: edge.label } : {}),
      ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
    }),
  }));
  const metadata = filterAttributes(graph.metadata ?? {});
  return { name: graph.name, nodes, edges, metadata };
}

function serialiseDescriptor(descriptor: NormalisedGraphDescriptor): GraphDescriptorPayload {
  return {
    name: descriptor.name,
    nodes: descriptor.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      attributes: { ...node.attributes },
    })),
    edges: descriptor.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      weight: edge.weight,
      attributes: { ...edge.attributes },
    })),
    metadata: { ...descriptor.metadata },
  };
}

function filterAttributes(values: Record<string, unknown>): Record<string, string | number | boolean> {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      filtered[key] = value;
    }
  }
  return filtered;
}

function descriptorToGraphModel(descriptor: NormalisedGraphDescriptor): GraphForgeModelInstance {
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

function normaliseCostConfig(
  config: EdgeCostConfig | undefined,
): GraphForgeEdgeCostDescriptor | string | undefined {
  if (!config) {
    return undefined;
  }
  if (typeof config === "string") {
    return config;
  }
  const descriptor: GraphForgeEdgeCostDescriptor = {
    attribute: config.attribute,
    defaultValue: config.default_value,
    scale: config.scale,
  };
  return descriptor;
}

function assertNodeExists(
  descriptor: NormalisedGraphDescriptor,
  id: string,
  role: "start" | "goal",
): void {
  if (!descriptor.nodes.some((node) => node.id === id)) {
    throw new Error(`${role} node '${id}' is not present in the graph`);
  }
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

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function applyAddNode(descriptor: NormalisedGraphDescriptor, node: z.infer<typeof GraphNodeSchema>): GraphMutationRecord {
  const existing = descriptor.nodes.find((entry) => entry.id === node.id);
  if (existing) {
    const mergedAttributes = { ...existing.attributes, ...filterAttributes(node.attributes ?? {}) };
    if (node.label) {
      mergedAttributes.label = node.label;
    }
    existing.label = node.label ?? existing.label;
    existing.attributes = mergedAttributes;
    return { op: "add_node", description: `node '${node.id}' already existed`, changed: false };
  }
  descriptor.nodes.push({
    id: node.id,
    label: node.label,
    attributes: filterAttributes({ ...node.attributes, ...(node.label ? { label: node.label } : {}) }),
  });
  return { op: "add_node", description: `node '${node.id}' created`, changed: true };
}

function applyRemoveNode(descriptor: NormalisedGraphDescriptor, id: string): GraphMutationRecord {
  const initialNodeCount = descriptor.nodes.length;
  descriptor.nodes = descriptor.nodes.filter((node) => node.id !== id);
  if (descriptor.nodes.length === initialNodeCount) {
    return { op: "remove_node", description: `node '${id}' missing`, changed: false };
  }
  const initialEdgeCount = descriptor.edges.length;
  descriptor.edges = descriptor.edges.filter((edge) => edge.from !== id && edge.to !== id);
  const removedEdges = initialEdgeCount - descriptor.edges.length;
  const details = removedEdges > 0 ? ` and ${removedEdges} related edges` : "";
  return { op: "remove_node", description: `node '${id}' removed${details}`, changed: true };
}

function applyRenameNode(
  descriptor: NormalisedGraphDescriptor,
  id: string,
  newId: string,
): GraphMutationRecord {
  if (id === newId) {
    return { op: "rename_node", description: "identical identifiers", changed: false };
  }
  const node = descriptor.nodes.find((entry) => entry.id === id);
  if (!node) {
    return { op: "rename_node", description: `node '${id}' missing`, changed: false };
  }
  if (descriptor.nodes.some((entry) => entry.id === newId)) {
    return { op: "rename_node", description: `target id '${newId}' already used`, changed: false };
  }
  node.id = newId;
  node.attributes = { ...node.attributes };
  node.attributes.label = node.label ?? node.attributes.label ?? newId;
  for (const edge of descriptor.edges) {
    if (edge.from === id) {
      edge.from = newId;
    }
    if (edge.to === id) {
      edge.to = newId;
    }
  }
  return { op: "rename_node", description: `node '${id}' renamed to '${newId}'`, changed: true };
}

function applyAddEdge(
  descriptor: NormalisedGraphDescriptor,
  edge: z.infer<typeof GraphEdgeSchema>,
): GraphMutationRecord {
  const exists = descriptor.edges.find((entry) => entry.from === edge.from && entry.to === edge.to);
  if (exists) {
    exists.weight = typeof edge.weight === "number" ? edge.weight : exists.weight;
    exists.attributes = {
      ...exists.attributes,
      ...filterAttributes(edge.attributes ?? {}),
      ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
    };
    if (edge.label) {
      exists.label = edge.label;
      exists.attributes.label = edge.label;
    }
    return { op: "add_edge", description: `edge '${edge.from}' -> '${edge.to}' already existed`, changed: false };
  }
  descriptor.edges.push({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    weight: edge.weight,
    attributes: filterAttributes({
      ...edge.attributes,
      ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
      ...(edge.label ? { label: edge.label } : {}),
    }),
  });
  return { op: "add_edge", description: `edge '${edge.from}' -> '${edge.to}' created`, changed: true };
}

function applyRemoveEdge(
  descriptor: NormalisedGraphDescriptor,
  from: string,
  to: string,
): GraphMutationRecord {
  const initial = descriptor.edges.length;
  descriptor.edges = descriptor.edges.filter((edge) => !(edge.from === from && edge.to === to));
  if (descriptor.edges.length === initial) {
    return { op: "remove_edge", description: `edge '${from}' -> '${to}' missing`, changed: false };
  }
  return { op: "remove_edge", description: `edge '${from}' -> '${to}' removed`, changed: true };
}

function applySetNodeAttribute(
  descriptor: NormalisedGraphDescriptor,
  id: string,
  key: string,
  value: string | number | boolean | null,
): GraphMutationRecord {
  const node = descriptor.nodes.find((entry) => entry.id === id);
  if (!node) {
    return { op: "set_node_attribute", description: `node '${id}' missing`, changed: false };
  }
  if (value === null) {
    if (key in node.attributes) {
      delete node.attributes[key];
      return { op: "set_node_attribute", description: `attribute '${key}' removed from '${id}'`, changed: true };
    }
    return { op: "set_node_attribute", description: `attribute '${key}' absent on '${id}'`, changed: false };
  }
  node.attributes[key] = value;
  return { op: "set_node_attribute", description: `attribute '${key}' set on '${id}'`, changed: true };
}

function applySetEdgeAttribute(
  descriptor: NormalisedGraphDescriptor,
  from: string,
  to: string,
  key: string,
  value: string | number | boolean | null,
): GraphMutationRecord {
  const edge = descriptor.edges.find((entry) => entry.from === from && entry.to === to);
  if (!edge) {
    return { op: "set_edge_attribute", description: `edge '${from}' -> '${to}' missing`, changed: false };
  }
  if (value === null) {
    if (key in edge.attributes) {
      delete edge.attributes[key];
      return { op: "set_edge_attribute", description: `attribute '${key}' removed from edge`, changed: true };
    }
    return { op: "set_edge_attribute", description: `attribute '${key}' absent on edge`, changed: false };
  }
  edge.attributes[key] = value;
  if (key === "weight" && typeof value === "number") {
    edge.weight = value;
  }
  if (key === "label" && typeof value === "string") {
    edge.label = value;
  }
  return { op: "set_edge_attribute", description: `attribute '${key}' set on edge`, changed: true };
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

function buildAdjacencyInfo(descriptor: NormalisedGraphDescriptor): AdjacencyInfo {
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

function buildWeightedAdjacency(descriptor: NormalisedGraphDescriptor): Map<string, WeightedEdge[]> {
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

function normaliseEdgeWeight(edge: NormalisedEdge): number {
  const direct = typeof edge.weight === "number" ? edge.weight : undefined;
  const attributeWeight = Number(edge.attributes.weight ?? NaN);
  const weight = Number.isFinite(direct) ? direct! : Number.isFinite(attributeWeight) ? attributeWeight : 1;
  return weight < 0 ? 0 : weight;
}

function computeBetweennessScores(descriptor: NormalisedGraphDescriptor): { node: string; score: number }[] {
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
};

/** Input payload accepted by `graph_critical_path`. */
export const GraphCriticalPathInputSchema = z.object(GraphCriticalPathInputShapeInternal);

export const GraphCriticalPathInputShape = GraphCriticalPathInputShapeInternal;

export type GraphCriticalPathInput = z.infer<typeof GraphCriticalPathInputSchema>;

export interface GraphCriticalPathResult extends Record<string, unknown> {
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
    duration: Number(context.critical.duration.toFixed(6)),
    critical_path: [...context.critical.criticalPath],
    earliest_start: earliestStart,
    earliest_finish: earliestFinish,
    slack_by_node: slackByNode,
    warnings: [...context.warnings],
  };
}

/** Input payload accepted by `graph_optimize`. */
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

export interface GraphOptimizationProjection extends Record<string, unknown> {
  parallelism: number;
  makespan: number;
  utilisation: number;
  total_wait_time: number;
  average_concurrency: number;
}

export interface GraphOptimizationSuggestion extends Record<string, unknown> {
  type: "increase_parallelism" | "critical_path_focus" | "rebalance_queue";
  description: string;
  impact: {
    baseline_makespan?: number;
    projected_makespan?: number;
    improvement?: number;
  };
  details?: Record<string, unknown>;
}

export interface GraphOptimizeResult extends Record<string, unknown> {
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
  descriptor: NormalisedGraphDescriptor;
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
  for (const [id, list] of incoming.entries()) {
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
  descriptor: NormalisedGraphDescriptor,
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
  descriptor: NormalisedGraphDescriptor,
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
  const context = buildSimulationContext(input);
  const simulation = simulateGraph(context, input.parallelism);
  const warnings = [...context.warnings, ...simulation.warnings];
  return {
    graph: serialiseDescriptor(context.descriptor),
    schedule: simulation.schedule,
    queue: simulation.queue,
    metrics: simulation.metrics,
    warnings,
  };
}

/** Explore optimisation levers on top of the baseline simulation. */
export function handleGraphOptimize(input: GraphOptimizeInput): GraphOptimizeResult {
  const context = buildSimulationContext({
    graph: input.graph,
    duration_attribute: input.duration_attribute,
    fallback_duration_attribute: input.fallback_duration_attribute,
    default_duration: input.default_duration,
  });

  const baselineOutput = simulateGraph(context, input.parallelism);
  const baselineWarnings = [...context.warnings, ...baselineOutput.warnings];
  const baseline: GraphSimulateResult = {
    graph: serialiseDescriptor(context.descriptor),
    schedule: baselineOutput.schedule,
    queue: baselineOutput.queue,
    metrics: baselineOutput.metrics,
    warnings: baselineWarnings,
  };

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
    projections.push({
      parallelism: candidate,
      makespan: output.metrics.makespan,
      utilisation: output.metrics.utilisation,
      total_wait_time: output.metrics.total_wait_time,
      average_concurrency: output.metrics.average_concurrency,
    });
  }

  let bestCandidate = input.parallelism;
  let bestMakespan = baseline.metrics.makespan;
  for (const projection of projections) {
    if (projection.parallelism === input.parallelism) {
      continue;
    }
    if (projection.makespan + 1e-6 < bestMakespan) {
      bestMakespan = projection.makespan;
      bestCandidate = projection.parallelism;
    }
  }

  const suggestions: GraphOptimizationSuggestion[] = [];
  if (bestCandidate !== input.parallelism) {
    const bestSimulation = simulations.get(bestCandidate)!;
    suggestions.push({
      type: "increase_parallelism",
      description: `Augmenter le parallélisme a ${bestCandidate} réduit le makespan de ${baseline.metrics.makespan.toFixed(2)} a ${bestMakespan.toFixed(2)}.`,
      impact: {
        baseline_makespan: baseline.metrics.makespan,
        projected_makespan: bestMakespan,
        improvement: Number((baseline.metrics.makespan - bestMakespan).toFixed(6)),
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
