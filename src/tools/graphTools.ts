import { createHash } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { z } from "zod";

import { applyAdaptiveRewrites, type AdaptiveEvaluationResult } from "../graph/adaptive.js";
import { GraphComputationCache } from "../graph/cache.js";
import { buildGraphAttributeIndex } from "../graph/index.js";
import { partitionGraph, type GraphPartitionObjective } from "../graph/partition.js";
import {
  projectHyperGraph,
  type HyperEdge,
  type HyperGraph,
} from "../graph/hypergraph.js";
import {
  applyAll,
  createInlineSubgraphRule,
  createRerouteAvoidRule,
  createSplitParallelRule,
  type RewriteHistoryEntry,
  type RewriteRule,
} from "../graph/rewrite.js";
import type { NormalisedGraph, GraphAttributeValue } from "../graph/types.js";
import type { KnowledgeGraph } from "../knowledge/knowledgeGraph.js";
import { resolveOperationId } from "./operationIds.js";

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

interface GraphForgeConstrainedResult {
  readonly status: "found" | "start_or_goal_excluded" | "unreachable" | "max_cost_exceeded";
  readonly distance: number;
  readonly path: string[];
  readonly visitedOrder: string[];
  readonly filteredNodes: string[];
  readonly filteredEdges: Array<{ from: string; to: string }>;
  readonly violations: string[];
  readonly notes: string[];
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
  readonly constrainedShortestPath: (
    graph: GraphForgeModelInstance,
    start: string,
    goal: string,
    options?: {
      readonly weightAttribute?: string;
      readonly costFunction?: GraphForgeEdgeCostDescriptor | string | ((edge: unknown, graph: unknown) => number);
      readonly avoidNodes?: Iterable<string>;
      readonly avoidEdges?: Iterable<{ from: string; to: string }>;
      readonly maxCost?: number;
    },
  ) => GraphForgeConstrainedResult;
};

const computationCache = new GraphComputationCache(128);

const graphForgeModuleUrl = new URL("../../graph-forge/dist/index.js", import.meta.url);
const {
  GraphModel,
  betweennessCentrality,
  kShortestPaths,
  shortestPath,
  constrainedShortestPath,
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
  graph_id: z.string().min(1).optional(),
  graph_version: z.number().int().positive().optional(),
});

/** Identifier of rewrite rules that can be triggered via mutation operations. */
const GraphRewriteRuleIdSchema = z.enum(["split_parallel", "inline_subgraph", "reroute_avoid"]);

/** Schema describing a hyper-edge before projection. */
const GraphHyperEdgeSchema = z
  .object({
    id: z.string().min(1, "hyper_edge id must not be empty"),
    sources: z.array(z.string().min(1)).min(1, "hyper_edge must declare sources"),
    targets: z.array(z.string().min(1)).min(1, "hyper_edge must declare targets"),
    label: z.string().optional(),
    weight: z.number().finite().nonnegative().optional(),
    attributes: GraphAttributeRecordSchema.optional(),
  })
  .strict();

/** Schema accepted by the hyper-graph export tool. */
export const GraphHyperExportInputSchema = z
  .object({
    id: z.string().min(1, "hyper_graph id must not be empty"),
    nodes: z.array(GraphNodeSchema).min(1, "hyper_graph must declare nodes"),
    hyper_edges: z
      .array(GraphHyperEdgeSchema)
      .min(1, "hyper_graph must declare hyper_edges"),
    metadata: GraphAttributeRecordSchema.optional(),
    graph_version: z.number().int().positive().optional(),
    op_id: z.string().trim().min(1).optional(),
  })
  .strict();

export type GraphHyperExportInput = z.infer<typeof GraphHyperExportInputSchema>;
export const GraphHyperExportInputShape = GraphHyperExportInputSchema.shape;

/**
 * Internal representation used once the payload has been validated by the
 * schemata above. Every node keeps its insertion order to ensure deterministic
 * summaries and serialisations.
 */
type NormalisedNode = NormalisedGraph["nodes"][number];
type NormalisedEdge = NormalisedGraph["edges"][number];

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
  op_id: z.string().trim().min(1).optional(),
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
  graph_id?: string;
  graph_version?: number;
}

export interface GraphGenerateResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  task_count: number;
  edge_count: number;
  notes: string[];
}

export interface GraphHyperExportResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  stats: {
    nodes: number;
    hyper_edges: number;
    edges: number;
  };
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
export interface GraphGenerationContext {
  /** Optional knowledge graph powering plan pattern suggestions. */
  knowledgeGraph?: KnowledgeGraph | null;
  /** Explicit flag used to disable knowledge-based suggestions. */
  knowledgeEnabled?: boolean;
}

interface DerivedTasksResult {
  tasks: TaskDefinition[];
  notes: string[];
}

export function handleGraphGenerate(
  input: GraphGenerateInput,
  context?: GraphGenerationContext,
): GraphGenerateResult {
  const opId = resolveOperationId(input.op_id, "graph_generate_op");
  const defaultWeight = input.default_weight ?? 1;
  const { tasks, notes: knowledgeNotes } = deriveTasks(input, context);

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

  const descriptor: NormalisedGraph = {
    name: input.name,
    graphId: "",
    graphVersion: 1,
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

  ensureGraphIdentity(descriptor);

  const notes: string[] = [];
  if (knowledgeNotes.length > 0) {
    notes.push(...knowledgeNotes);
  }
  if (tasks.some((task) => task.synthetic === true)) {
    notes.push("synthetic nodes were added for undeclared dependencies");
  }

  return {
    op_id: opId,
    graph: serialiseDescriptor(descriptor),
    task_count: tasks.filter((task) => !task.synthetic).length,
    edge_count: descriptor.edges.length,
    notes,
  };
}

/** Input payload accepted by `graph_mutate`. */
const GraphPatchMetadataOperationSchema = z
  .object({
    op: z.literal("patch_metadata"),
    set: GraphAttributeRecordSchema.optional(),
    unset: z.array(z.string().min(1)).optional(),
  })
  .strict();

const GraphRewriteOperationSchema = z
  .object({
    op: z.literal("rewrite"),
    rule: GraphRewriteRuleIdSchema,
    params: z
      .object({
        split_parallel_targets: z.array(z.string().min(1)).optional(),
        reroute_avoid_node_ids: z.array(z.string().min(1)).optional(),
        reroute_avoid_labels: z.array(z.string().min(1)).optional(),
        stop_on_no_change: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const GraphMutationOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: GraphNodeSchema }),
  z.object({ op: z.literal("remove_node"), id: z.string().min(1) }),
  z.object({ op: z.literal("rename_node"), id: z.string().min(1), new_id: z.string().min(1) }),
  z.object({ op: z.literal("add_edge"), edge: GraphEdgeSchema }),
  z.object({ op: z.literal("remove_edge"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ op: z.literal("set_node_attribute"), id: z.string().min(1), key: z.string().min(1), value: GraphAttributeValueSchema.nullable() }),
  z.object({ op: z.literal("set_edge_attribute"), from: z.string().min(1), to: z.string().min(1), key: z.string().min(1), value: GraphAttributeValueSchema.nullable() }),
  GraphPatchMetadataOperationSchema,
  GraphRewriteOperationSchema,
]);

export const GraphMutateInputSchema = z.object({
  graph: GraphDescriptorSchema,
  operations: z
    .array(GraphMutationOperationSchema)
    .min(1, "at least one operation must be provided"),
  op_id: z.string().trim().min(1).optional(),
});

export const GraphMutateInputShape = GraphMutateInputSchema.shape;

export type GraphMutateInput = z.infer<typeof GraphMutateInputSchema>;

export interface GraphMutationRecord {
  op: string;
  description: string;
  changed: boolean;
}

export interface GraphMutateResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  applied: GraphMutationRecord[];
}

/**
 * Convert a serialised graph payload (typically exchanged with tools) into the
 * internal normalised representation leveraged by the transaction manager.
 *
 * The helper intentionally reuses the same normalisation routine as the graph
 * tools to preserve ordering guarantees and ensure cache keys remain stable.
 */
export function normaliseGraphPayload(payload: GraphDescriptorPayload): NormalisedGraph {
  return normaliseDescriptor(payload as z.infer<typeof GraphDescriptorSchema>);
}

/**
 * Serialise a normalised graph so it can be returned to clients or chained into
 * other tooling primitives without exposing the internal structure.
 */
export function serialiseNormalisedGraph(descriptor: NormalisedGraph): GraphDescriptorPayload {
  return serialiseDescriptor(descriptor);
}

/**
 * Project a hyper-graph into a regular directed graph while preserving context
 * through metadata. The helper keeps statistics handy for downstream tooling
 * and tests so that auditing coverage remains simple.
 */
export function handleGraphHyperExport(input: GraphHyperExportInput): GraphHyperExportResult {
  const opId = resolveOperationId(input.op_id, "graph_hyper_export_op");
  const hyperGraph: HyperGraph = {
    id: input.id,
    nodes: input.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      attributes: node.attributes ?? {},
    })),
    hyperEdges: input.hyper_edges.map((edge) => ({
      id: edge.id,
      sources: [...edge.sources],
      targets: [...edge.targets],
      label: edge.label,
      weight: edge.weight,
      attributes: edge.attributes ?? {},
    } satisfies HyperEdge)),
    metadata: input.metadata,
  } satisfies HyperGraph;

  const projected = projectHyperGraph(hyperGraph, {
    graphVersion: input.graph_version,
  });

  return {
    op_id: opId,
    graph: serialiseNormalisedGraph(projected),
    stats: {
      nodes: projected.nodes.length,
      hyper_edges: input.hyper_edges.length,
      edges: projected.edges.length,
    },
  };
}

/** Apply idempotent graph operations, returning the mutated graph. */
export function handleGraphMutate(input: GraphMutateInput): GraphMutateResult {
  const opId = resolveOperationId(input.op_id, "graph_mutate_op");
  const descriptor = normaliseDescriptor(input.graph);
  const initialPayload = serialiseDescriptor(descriptor);
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
      case "patch_metadata":
        applied.push(applyPatchMetadata(descriptor, operation.set ?? {}, operation.unset ?? []));
        break;
      case "rewrite":
        applied.push(applyRewriteOperation(descriptor, operation.rule, operation.params));
        break;
    }
  }
  const mutatedPayloadBeforeIdentity = serialiseDescriptor(descriptor);
  const netChanged = !graphPayloadEquals(initialPayload, mutatedPayloadBeforeIdentity);

  ensureGraphIdentity(descriptor, {
    preferId: input.graph.graph_id ?? descriptor.graphId,
    preferVersion: input.graph.graph_version ?? descriptor.graphVersion,
    mutated: netChanged,
  });
  if (netChanged) {
    computationCache.invalidateGraph(descriptor.graphId);
  }

  return { op_id: opId, graph: serialiseDescriptor(descriptor), applied };
}

const GraphRewriteManualOptionsSchema = z
  .object({
    stop_on_no_change: z.boolean().optional(),
    split_parallel_targets: z.array(z.string().min(1)).optional(),
    reroute_avoid_node_ids: z.array(z.string().min(1)).optional(),
    reroute_avoid_labels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const GraphRewriteAdaptiveOptionsSchema = z
  .object({
    stop_on_no_change: z.boolean().optional(),
    avoid_labels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const GraphRewriteInsightMetricsSchema = z
  .object({
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    total_duration_ms: z.number().nonnegative(),
    total_reward: z.number(),
    last_updated_at: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    success_rate: z.number().min(0).max(1),
    average_duration_ms: z.number().nonnegative(),
  })
  .strict();

const GraphRewriteInsightSchema = z
  .object({
    edge_key: z.string().min(1),
    reinforcement: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    recommendation: z.enum(["boost", "keep", "prune"]),
    metrics: GraphRewriteInsightMetricsSchema.optional(),
  })
  .strict();

const GraphRewriteAdaptiveEvaluationSchema = z
  .object({
    edges_to_boost: z.array(z.string().min(1)).default([]),
    edges_to_prune: z.array(z.string().min(1)).default([]),
    insights: z.array(GraphRewriteInsightSchema).default([]),
  })
  .strict();

const GraphRewriteApplyManualSchema = z
  .object({
    graph: GraphDescriptorSchema,
    mode: z.literal("manual"),
    rules: z.array(GraphRewriteRuleIdSchema).min(1, "at least one rewrite rule must be selected"),
    options: GraphRewriteManualOptionsSchema.optional(),
    op_id: z.string().trim().min(1).optional(),
  })
  .strict();

const GraphRewriteApplyAdaptiveSchema = z
  .object({
    graph: GraphDescriptorSchema,
    mode: z.literal("adaptive"),
    evaluation: GraphRewriteAdaptiveEvaluationSchema,
    options: GraphRewriteAdaptiveOptionsSchema.optional(),
    op_id: z.string().trim().min(1).optional(),
  })
  .strict();

/** Input payload accepted by `graph_rewrite_apply`. */
export const GraphRewriteApplyInputSchema = z.discriminatedUnion("mode", [
  GraphRewriteApplyManualSchema,
  GraphRewriteApplyAdaptiveSchema,
]);

export const GraphRewriteApplyInputShape = {
  graph: GraphDescriptorSchema,
  mode: z.enum(["manual", "adaptive"]),
  rules: z.array(GraphRewriteRuleIdSchema).optional(),
  options: z
    .object({
      stop_on_no_change: z.boolean().optional(),
      split_parallel_targets: z.array(z.string().min(1)).optional(),
      reroute_avoid_node_ids: z.array(z.string().min(1)).optional(),
      reroute_avoid_labels: z.array(z.string().min(1)).optional(),
      avoid_labels: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  evaluation: GraphRewriteAdaptiveEvaluationSchema.optional(),
  op_id: z.string().optional(),
} as const;

export type GraphRewriteApplyInput = z.infer<typeof GraphRewriteApplyInputSchema>;

export interface GraphRewriteApplyResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  history: RewriteHistoryEntry[];
  total_applied: number;
  changed: boolean;
  stop_on_no_change: boolean;
  mode: "manual" | "adaptive";
  rules_invoked: string[];
}

/**
 * Apply graph rewrite rules either manually selected by the caller or derived
 * from an adaptive reinforcement evaluation. The helper maintains graph
 * identity so the transaction manager can reason about optimistic concurrency.
 */
export function handleGraphRewriteApply(input: GraphRewriteApplyInput): GraphRewriteApplyResult {
  const opId = resolveOperationId(input.op_id, "graph_rewrite_apply_op");
  const descriptor = normaliseDescriptor(input.graph);
  const baseVersion = descriptor.graphVersion;

  let rewrittenGraph: NormalisedGraph;
  let history: RewriteHistoryEntry[];
  let rulesInvoked: string[];
  let stopOnNoChange: boolean;

  if (input.mode === "manual") {
    const manualOptions = input.options;
    const ruleSet = new Set(input.rules);
    const rules: RewriteRule[] = [];
    rulesInvoked = [];

    if (ruleSet.has("split_parallel")) {
      const targets = normaliseEdgeTargets(manualOptions?.split_parallel_targets);
      rules.push(createSplitParallelRule(targets));
      rulesInvoked.push("split-parallel");
    }

    if (ruleSet.has("inline_subgraph")) {
      rules.push(createInlineSubgraphRule());
      rulesInvoked.push("inline-subgraph");
    }

    if (ruleSet.has("reroute_avoid")) {
      const avoidNodeIds = normaliseStringSet(manualOptions?.reroute_avoid_node_ids);
      const avoidLabels = normaliseStringSet(manualOptions?.reroute_avoid_labels);
      rules.push(
        createRerouteAvoidRule({
          avoidNodeIds,
          avoidLabels,
        }),
      );
      rulesInvoked.push("reroute-avoid");
    }

    if (rules.length === 0) {
      throw new Error("no rewrite rules resolved after validating the input");
    }

    stopOnNoChange = manualOptions?.stop_on_no_change ?? true;
    const { graph: rewritten, history: rewriteHistory } = applyAll(
      descriptor,
      rules,
      stopOnNoChange,
    );
    rewrittenGraph = rewritten;
    history = rewriteHistory;
  } else {
    const adaptiveOptions = input.options;
    const evaluation = mapAdaptiveEvaluation(input.evaluation);
    stopOnNoChange = adaptiveOptions?.stop_on_no_change ?? true;
    const avoidLabels = dedupeStringList(adaptiveOptions?.avoid_labels);
    const { graph: rewritten, history: rewriteHistory } = applyAdaptiveRewrites(
      descriptor,
      evaluation,
      {
        stopOnNoChange,
        avoidLabels: avoidLabels ?? undefined,
      },
    );
    rewrittenGraph = rewritten;
    history = rewriteHistory;
    rulesInvoked = Array.from(new Set(history.map((entry) => entry.rule)));
  }

  const totalApplied = history.reduce((sum, entry) => sum + entry.applied, 0);
  const changed = totalApplied > 0;

  rewrittenGraph.graphVersion = baseVersion;
  ensureGraphIdentity(rewrittenGraph, {
    preferId: input.graph.graph_id ?? null,
    preferVersion: baseVersion,
    mutated: changed,
  });

  if (changed) {
    computationCache.invalidateGraph(rewrittenGraph.graphId);
  }

  return {
    op_id: opId,
    graph: serialiseDescriptor(rewrittenGraph),
    history,
    total_applied: totalApplied,
    changed,
    stop_on_no_change: stopOnNoChange,
    mode: input.mode,
    rules_invoked: rulesInvoked,
  };
}

/**
 * Convert human-friendly edge descriptors into the canonical `from→to`
 * representation expected by the rewrite rules. The helper validates the
 * format so the caller receives actionable feedback when a target is malformed.
 */
function normaliseEdgeTargets(raw?: string[]): Set<string> | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const targets = new Set<string>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const canonical = trimmed.replace(/->/g, "→");
    const parts = canonical.split("→");
    if (parts.length !== 2) {
      throw new Error(
        "split_parallel_targets entries must follow '<from>→<to>' or '<from>-><to>'",
      );
    }
    const from = parts[0]?.trim();
    const to = parts[1]?.trim();
    if (!from || !to) {
      throw new Error(
        "split_parallel_targets entries must provide both source and target identifiers",
      );
    }
    targets.add(`${from}→${to}`);
  }
  return targets.size > 0 ? targets : undefined;
}

/** Build a sanitised set from a list of strings, trimming blanks and duplicates. */
function normaliseStringSet(raw?: string[]): Set<string> | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const values = new Set<string>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    values.add(trimmed);
  }
  return values.size > 0 ? values : undefined;
}

/** Deduplicate and trim an optional list of strings, returning null when empty. */
function dedupeStringList(raw?: string[]): string[] | null {
  const set = normaliseStringSet(raw);
  if (!set) {
    return null;
  }
  return Array.from(set);
}

/**
 * Map the caller-provided adaptive evaluation payload to the strongly-typed
 * structure consumed by the adaptive rewrite helper.
 */
function mapAdaptiveEvaluation(
  evaluation: z.infer<typeof GraphRewriteAdaptiveEvaluationSchema>,
): AdaptiveEvaluationResult {
  const insights = evaluation.insights.map((insight) => ({
    edgeKey: insight.edge_key,
    reinforcement: insight.reinforcement,
    confidence: insight.confidence,
    recommendation: insight.recommendation,
    metrics: insight.metrics
      ? {
          successes: insight.metrics.successes,
          failures: insight.metrics.failures,
          totalDurationMs: insight.metrics.total_duration_ms,
          totalReward: insight.metrics.total_reward,
          lastUpdatedAt: insight.metrics.last_updated_at,
          attempts: insight.metrics.attempts,
          successRate: insight.metrics.success_rate,
          averageDurationMs: insight.metrics.average_duration_ms,
        }
      : {
          successes: 0,
          failures: 0,
          totalDurationMs: 0,
          totalReward: 0,
          lastUpdatedAt: 0,
          attempts: 0,
          successRate: 0,
          averageDurationMs: 0,
        },
  }));

  return {
    insights,
    edgesToBoost: evaluation.edges_to_boost,
    edgesToPrune: evaluation.edges_to_prune,
  };
}

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

function deriveTasks(input: GraphGenerateInput, context?: GraphGenerationContext): DerivedTasksResult {
  const manual = normaliseTasksFromInput(input);
  if (manual) {
    return { tasks: manual, notes: [] };
  }

  const knowledgeEnabled = context?.knowledgeEnabled ?? true;
  const knowledgeGraph = knowledgeEnabled ? context?.knowledgeGraph ?? undefined : undefined;

  if (knowledgeGraph) {
    const pattern = knowledgeGraph.buildPlanPattern(input.name);
    if (pattern && pattern.tasks.length > 0) {
      const tasks = pattern.tasks.map((task) => {
        const metadata: Record<string, string | number | boolean> = {};
        if (task.source) {
          metadata.knowledge_source = task.source;
        }
        if (Number.isFinite(task.confidence)) {
          metadata.knowledge_confidence = Number(task.confidence.toFixed(3));
        }
        return {
          id: task.id,
          label: task.label,
          dependsOn: task.dependsOn,
          duration: task.duration,
          weight: task.weight,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        } satisfies TaskDefinition;
      });
      const avg = pattern.averageConfidence;
      const baseNote = `knowledge pattern '${pattern.plan}' applied (${pattern.tasks.length} tasks${
        avg !== null ? `, avg_confidence=${avg.toFixed(2)}` : ""
      })`;
      const notes = pattern.sourceCount > 0 ? [baseNote, `knowledge sources=${pattern.sourceCount}`] : [baseNote];
      return { tasks, notes };
    }
  }

  throw new Error("either preset or tasks must be provided");
}

function normaliseTasksFromInput(input: GraphGenerateInput): TaskDefinition[] | null {
  const tasks: TaskDefinition[] = [];
  if (input.preset) {
    tasks.push(...(PRESET_LIBRARY[input.preset] ?? []));
  }
  if (!input.tasks) {
    return tasks.length > 0 ? tasks : null;
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

function sortAttributes(values: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    sorted[key] = value;
  }
  return sorted;
}

function computeGraphFingerprint(descriptor: NormalisedGraph): string {
  const hash = createHash("sha1");
  const payload = {
    name: descriptor.name,
    nodes: descriptor.nodes
      .map((node) => ({
        id: node.id,
        label: node.label ?? null,
        attributes: sortAttributes(node.attributes),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: descriptor.edges
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label ?? null,
        weight: typeof edge.weight === "number" ? Number(edge.weight.toFixed(8)) : null,
        attributes: sortAttributes(edge.attributes),
      }))
      .sort((a, b) => {
        if (a.from === b.from) {
          return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
        }
        return a.from < b.from ? -1 : 1;
      }),
    metadata: sortAttributes(descriptor.metadata),
  };
  hash.update(JSON.stringify(payload));
  return hash.digest("hex").slice(0, 16);
}

function ensureGraphIdentity(
  descriptor: NormalisedGraph,
  options: { preferId?: string | null; preferVersion?: number | null; mutated?: boolean } = {},
): void {
  const preferredId = options.preferId ?? descriptor.graphId;
  if (preferredId && preferredId.trim().length > 0) {
    descriptor.graphId = preferredId;
  } else {
    const fingerprint = computeGraphFingerprint({ ...descriptor, graphId: "", graphVersion: 1 });
    descriptor.graphId = `graph-${fingerprint}`;
  }

  const preferredVersion = options.preferVersion ?? descriptor.graphVersion;
  if (options.mutated && typeof preferredVersion === "number" && Number.isFinite(preferredVersion)) {
    descriptor.graphVersion = Math.max(1, Math.floor(preferredVersion) + 1);
  } else if (typeof preferredVersion === "number" && Number.isFinite(preferredVersion) && preferredVersion >= 1) {
    descriptor.graphVersion = Math.floor(preferredVersion);
  } else if (!(typeof descriptor.graphVersion === "number" && Number.isFinite(descriptor.graphVersion) && descriptor.graphVersion >= 1)) {
    descriptor.graphVersion = 1;
  }
}

function withCachedComputation<T>(
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

function normaliseDescriptor(graph: z.infer<typeof GraphDescriptorSchema>): NormalisedGraph {
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
  const descriptor: NormalisedGraph = {
    name: graph.name,
    graphId: graph.graph_id ?? "",
    graphVersion: graph.graph_version ?? 1,
    nodes,
    edges,
    metadata,
  };
  ensureGraphIdentity(descriptor, { preferId: graph.graph_id ?? null, preferVersion: graph.graph_version ?? null });
  return descriptor;
}

export { normaliseDescriptor as normaliseGraphDescriptor };

function serialiseDescriptor(descriptor: NormalisedGraph): GraphDescriptorPayload {
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
    graph_id: descriptor.graphId,
    graph_version: descriptor.graphVersion,
  };
}

/**
 * Normalises an attribute record so structural comparisons ignore insertion
 * order. Only primitive attribute values are kept because higher-level types
 * are filtered earlier in the toolchain.
 */
function normaliseAttributesForEquality(
  attributes: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  if (!attributes) {
    return {};
  }

  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      filtered[key] = value;
    }
  }
  return sortAttributes(filtered);
}

/** Performs a shallow equality check on two sorted attribute dictionaries. */
function shallowRecordEquals(
  left: Record<string, string | number | boolean>,
  right: Record<string, string | number | boolean>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in right)) {
      return false;
    }
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Detects whether two graph payloads are structurally equivalent. The
 * comparison is order-insensitive for nodes, edges and attribute entries so it
 * matches the logical graph state instead of superficial JSON string output.
 */
function graphPayloadEquals(a: GraphDescriptorPayload, b: GraphDescriptorPayload): boolean {
  if ((a.name ?? "") !== (b.name ?? "")) {
    return false;
  }

  if (
    !shallowRecordEquals(
      normaliseAttributesForEquality(a.metadata),
      normaliseAttributesForEquality(b.metadata),
    )
  ) {
    return false;
  }

  if (a.nodes.length !== b.nodes.length) {
    return false;
  }

  const nodesById = new Map<string, (typeof b.nodes)[number]>();
  for (const node of b.nodes) {
    nodesById.set(node.id, node);
  }
  for (const node of a.nodes) {
    const peer = nodesById.get(node.id);
    if (!peer) {
      return false;
    }
    if ((node.label ?? null) !== (peer.label ?? null)) {
      return false;
    }
    if (
      !shallowRecordEquals(
        normaliseAttributesForEquality(node.attributes),
        normaliseAttributesForEquality(peer.attributes),
      )
    ) {
      return false;
    }
  }

  if (a.edges.length !== b.edges.length) {
    return false;
  }

  const edgesByKey = new Map<string, (typeof b.edges)[number]>();
  for (const edge of b.edges) {
    edgesByKey.set(`${edge.from}->${edge.to}`, edge);
  }
  for (const edge of a.edges) {
    const peer = edgesByKey.get(`${edge.from}->${edge.to}`);
    if (!peer) {
      return false;
    }
    const leftWeight = typeof edge.weight === "number" ? Number(edge.weight) : null;
    const rightWeight = typeof peer.weight === "number" ? Number(peer.weight) : null;
    if (leftWeight !== rightWeight) {
      return false;
    }
    if ((edge.label ?? null) !== (peer.label ?? null)) {
      return false;
    }
    if (
      !shallowRecordEquals(
        normaliseAttributesForEquality(edge.attributes),
        normaliseAttributesForEquality(peer.attributes),
      )
    ) {
      return false;
    }
  }

  return true;
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

function descriptorToGraphModel(descriptor: NormalisedGraph): GraphForgeModelInstance {
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
  descriptor: NormalisedGraph,
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

function applyAddNode(descriptor: NormalisedGraph, node: z.infer<typeof GraphNodeSchema>): GraphMutationRecord {
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

function applyRemoveNode(descriptor: NormalisedGraph, id: string): GraphMutationRecord {
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
  descriptor: NormalisedGraph,
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
  descriptor: NormalisedGraph,
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
  descriptor: NormalisedGraph,
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
  descriptor: NormalisedGraph,
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
  if (node.attributes[key] === value) {
    return { op: "set_node_attribute", description: `attribute '${key}' unchanged on '${id}'`, changed: false };
  }
  node.attributes[key] = value;
  return { op: "set_node_attribute", description: `attribute '${key}' set on '${id}'`, changed: true };
}

function applySetEdgeAttribute(
  descriptor: NormalisedGraph,
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
  const currentValue = edge.attributes[key];
  const weightMatches = key === "weight" && typeof value === "number" ? edge.weight === value : true;
  const labelMatches = key === "label" && typeof value === "string" ? edge.label === value : true;
  if (currentValue === value && weightMatches && labelMatches) {
    return { op: "set_edge_attribute", description: `attribute '${key}' unchanged on edge`, changed: false };
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

/**
 * Apply a metadata patch by merging the provided `set` values and removing the
 * keys listed in `unset`. The helper keeps track of each adjustment so the
 * resulting {@link GraphMutationRecord} explains what changed.
 */
function applyPatchMetadata(
  descriptor: NormalisedGraph,
  set: Record<string, GraphAttributeValue>,
  unset: string[],
): GraphMutationRecord {
  const safeSet = filterAttributes(set);
  const keysToUnset = dedupe(
    unset
      .map((key) => key.trim())
      .filter((key): key is string => key.length > 0),
  );

  const setSize = Object.keys(safeSet).length;
  const unsetSize = keysToUnset.length;
  if (setSize + unsetSize === 0) {
    throw new Error("patch_metadata requires at least one key to set or unset");
  }

  const mutations: string[] = [];
  let changed = false;

  for (const [key, value] of Object.entries(safeSet)) {
    const current = descriptor.metadata[key];
    if (current === value) {
      continue;
    }
    descriptor.metadata[key] = value;
    mutations.push(`${key}=${JSON.stringify(value)}`);
    changed = true;
  }

  for (const key of keysToUnset) {
    if (!(key in descriptor.metadata)) {
      continue;
    }
    delete descriptor.metadata[key];
    mutations.push(`-${key}`);
    changed = true;
  }

  const description = changed
    ? `metadata patched (${mutations.join(", ")})`
    : "metadata patch produced no change";
  return { op: "patch_metadata", description, changed };
}

/** Parameters accepted by the rewrite mutation operation. */
type GraphRewriteOperationParams = z.infer<typeof GraphRewriteOperationSchema>["params"];

/**
 * Apply a single rewrite rule directly within the mutation pipeline. The
 * resulting graph replaces the in-memory descriptor when the rule produces a
 * change, preserving optimistic version increments for downstream commits.
 */
function applyRewriteOperation(
  descriptor: NormalisedGraph,
  ruleId: z.infer<typeof GraphRewriteRuleIdSchema>,
  params: GraphRewriteOperationParams | undefined,
): GraphMutationRecord {
  const options = params ?? {};
  let rule: RewriteRule;

  switch (ruleId) {
    case "split_parallel": {
      const targets = normaliseEdgeTargets(options.split_parallel_targets);
      rule = createSplitParallelRule(targets);
      break;
    }
    case "inline_subgraph":
      rule = createInlineSubgraphRule();
      break;
    case "reroute_avoid": {
      const avoidNodeIds = normaliseStringSet(options.reroute_avoid_node_ids);
      const avoidLabels = normaliseStringSet(options.reroute_avoid_labels);
      rule = createRerouteAvoidRule({ avoidNodeIds, avoidLabels });
      break;
    }
    default:
      return {
        op: "rewrite",
        description: `rewrite '${ruleId}' unsupported`,
        changed: false,
      };
  }

  const stopOnNoChange = options.stop_on_no_change ?? true;
  const { graph: rewritten, history } = applyAll(descriptor, [rule], stopOnNoChange);
  const applied = history.reduce((total, entry) => total + entry.applied, 0);
  const matches = history.reduce((total, entry) => total + entry.matches, 0);
  const changed = applied > 0;

  if (changed) {
    adoptGraphDescriptor(descriptor, rewritten);
  }

  const description = changed
    ? `rewrite '${rule.name}' applied ${applied} time(s)`
    : `rewrite '${rule.name}' produced no change (${matches} matches)`;
  return { op: "rewrite", description, changed };
}

/**
 * Replace the content of {@link descriptor} with {@link source} without
 * leaking references. The helper preserves identifiers to keep optimistic
 * concurrency expectations intact.
 */
function adoptGraphDescriptor(target: NormalisedGraph, source: NormalisedGraph): void {
  target.name = source.name;
  target.graphId = source.graphId;
  target.graphVersion = source.graphVersion;
  target.nodes = source.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    attributes: { ...node.attributes },
  }));
  target.edges = source.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    weight: edge.weight,
    attributes: { ...edge.attributes },
  }));
  target.metadata = { ...source.metadata };
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

function normaliseEdgeWeight(edge: NormalisedEdge): number {
  const direct = typeof edge.weight === "number" ? edge.weight : undefined;
  const attributeWeight = Number(edge.attributes.weight ?? NaN);
  const weight = Number.isFinite(direct) ? direct! : Number.isFinite(attributeWeight) ? attributeWeight : 1;
  return weight < 0 ? 0 : weight;
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
  adjacency: Map<string, string[]>,
  indegree: Map<string, number>,
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
