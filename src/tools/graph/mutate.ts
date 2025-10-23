import { z } from "zod";

import { applyAdaptiveRewrites, type AdaptiveEvaluationResult } from "../../graph/adaptive.js";
import {
  applyAll,
  createInlineSubgraphRule,
  createRerouteAvoidRule,
  createSplitParallelRule,
  type RewriteHistoryEntry,
  type RewriteRule,
} from "../../graph/rewrite.js";
import type {
  NormalisedGraph,
  GraphAttributeValue,
  GraphNodeRecord,
  GraphEdgeRecord,
} from "../../graph/types.js";
import type { KnowledgeGraph } from "../../knowledge/knowledgeGraph.js";
import { resolveOperationId } from "../operationIds.js";
import {
  GraphAttributeRecordSchema,
  GraphAttributeValueSchema,
  GraphDescriptorPayload,
  GraphDescriptorSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  adoptGraphDescriptor,
  ensureGraphIdentity,
  filterAttributes,
  normaliseDescriptor,
  serialiseDescriptor,
} from "./snapshot.js";
import { computationCache } from "./runtime.js";
import { dedupeStrings, toTrimmedStringList, toTrimmedStringSet } from "../shared.js";

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

export interface GraphGenerateResult extends Record<string, unknown> {
  op_id: string;
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

/**
 * Builds a {@link GraphNodeRecord} while omitting optional fields that were not explicitly provided.
 *
 * Centralising the conditional spread logic keeps the graph tooling resilient to
 * `exactOptionalPropertyTypes` by guaranteeing generated descriptors never
 * persist `undefined` placeholders for optional properties such as `label`.
 */
function buildGraphNodeRecord(params: {
  id: string;
  label?: string;
  attributes: Record<string, GraphAttributeValue>;
}): GraphNodeRecord {
  const { id, label, attributes } = params;
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    attributes,
  };
}

/**
 * Builds a {@link GraphEdgeRecord} that omits unset optional fields to prevent
 * leaking `undefined` values in descriptors and runtime mutations.
 */
function buildGraphEdgeRecord(params: {
  from: string;
  to: string;
  label?: string;
  weight?: number;
  attributes: Record<string, GraphAttributeValue>;
}): GraphEdgeRecord {
  const { from, to, label, weight, attributes } = params;
  return {
    from,
    to,
    ...(label !== undefined ? { label } : {}),
    ...(weight !== undefined ? { weight } : {}),
    attributes,
  };
}

/**
 * Normalise a task definition by cloning optional fields while omitting any
 * `undefined` placeholder. The helper centralises the omission logic required
 * for `exactOptionalPropertyTypes` and keeps every task copy independent.
 */
function createTaskDefinition(params: {
  id: string;
  dependsOn: Iterable<string>;
  label?: string;
  duration?: number;
  weight?: number;
  metadata?: Record<string, string | number | boolean> | undefined;
  synthetic?: boolean | undefined;
}): TaskDefinition {
  const definition: TaskDefinition = { id: params.id, dependsOn: dedupeStrings(params.dependsOn) };
  if (params.label !== undefined) {
    definition.label = params.label;
  }
  if (params.duration !== undefined) {
    definition.duration = params.duration;
  }
  if (params.weight !== undefined) {
    definition.weight = params.weight;
  }
  if (params.metadata && Object.keys(params.metadata).length > 0) {
    definition.metadata = { ...params.metadata };
  }
  if (params.synthetic) {
    definition.synthetic = true;
  }
  return definition;
}

function cloneTaskDefinition(task: TaskDefinition): TaskDefinition {
  return createTaskDefinition({
    id: task.id,
    dependsOn: [...task.dependsOn],
    ...(task.label !== undefined ? { label: task.label } : {}),
    ...(task.duration !== undefined ? { duration: task.duration } : {}),
    ...(task.weight !== undefined ? { weight: task.weight } : {}),
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
    ...(task.synthetic ? { synthetic: true } : {}),
  });
}

/**
 * Merge two task definitions while keeping optional fields absent when they
 * are not explicitly provided by either side.
 */
function mergeTaskDefinitions(existing: TaskDefinition, incoming: TaskDefinition): TaskDefinition {
  const metadata = { ...existing.metadata, ...incoming.metadata } as Record<
    string,
    string | number | boolean
  >;
  const mergedLabel = incoming.label ?? existing.label;
  const mergedDuration = incoming.duration ?? existing.duration;
  const mergedWeight = incoming.weight ?? existing.weight;
  const synthetic = Boolean(existing.synthetic) && Boolean(incoming.synthetic);
  return createTaskDefinition({
    id: existing.id,
    dependsOn: [...existing.dependsOn, ...incoming.dependsOn],
    ...(mergedLabel !== undefined ? { label: mergedLabel } : {}),
    ...(mergedDuration !== undefined ? { duration: mergedDuration } : {}),
    ...(mergedWeight !== undefined ? { weight: mergedWeight } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(synthetic ? { synthetic: true } : {}),
  });
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
      nodes.set(task.id, mergeTaskDefinitions(existing, task));
    } else {
      nodes.set(task.id, cloneTaskDefinition(task));
      order.push(task.id);
    }

    for (const dep of task.dependsOn) {
      if (!nodes.has(dep)) {
        nodes.set(
          dep,
          createTaskDefinition({ id: dep, label: dep, dependsOn: [], synthetic: true }),
        );
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
    // Centralise the omission of optional fields so generated nodes remain
    // compliant with strict optional property checks.
    descriptor.nodes.push(
      buildGraphNodeRecord({
        id: task.id,
        ...(task.label !== undefined ? { label: task.label } : {}),
        attributes,
      }),
    );
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
      descriptor.edges.push(
        buildGraphEdgeRecord({ from: dependency, to: task.id, weight, attributes }),
      );
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
    rule: z.enum(["split_parallel", "inline_subgraph", "reroute_avoid"]),
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

  const changed = !graphPayloadEquals(initialPayload, serialiseDescriptor(descriptor));

  ensureGraphIdentity(descriptor, {
    preferId: input.graph.graph_id ?? null,
    preferVersion: input.graph.graph_version ?? null,
    mutated: changed,
  });

  if (changed) {
    computationCache.invalidateGraph(descriptor.graphId);
  }

  return {
    op_id: opId,
    graph: serialiseDescriptor(descriptor),
    applied,
  };
}

const GraphRewriteAdaptiveInsightSchema = z.object({
  edge_key: z.string().min(1),
  reinforcement: z.number(),
  confidence: z.number(),
  recommendation: z.enum(["boost", "prune", "keep"]),
  metrics: z
    .object({
      successes: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      total_duration_ms: z.number().int().nonnegative(),
      total_reward: z.number(),
      last_updated_at: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
      success_rate: z.number().nonnegative(),
      average_duration_ms: z.number().nonnegative(),
    })
    .optional(),
});

const GraphRewriteAdaptiveEvaluationSchema = z.object({
  insights: z.array(GraphRewriteAdaptiveInsightSchema),
  edges_to_boost: z.array(z.string().min(1)).optional(),
  edges_to_prune: z.array(z.string().min(1)).optional(),
});

const GraphRewriteAdaptiveOptionsSchema = z
  .object({
    stop_on_no_change: z.boolean().optional(),
    avoid_labels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const GraphRewriteApplyManualSchema = z
  .object({
    mode: z.literal("manual"),
    graph: GraphDescriptorSchema,
    rules: z.array(z.enum(["split_parallel", "inline_subgraph", "reroute_avoid"])),
    options: z
      .object({
        stop_on_no_change: z.boolean().optional(),
        split_parallel_targets: z.array(z.string().min(1)).optional(),
        reroute_avoid_node_ids: z.array(z.string().min(1)).optional(),
        reroute_avoid_labels: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    op_id: z.string().trim().min(1).optional(),
  })
  .strict();

const GraphRewriteApplyAdaptiveSchema = z
  .object({
    mode: z.literal("adaptive"),
    graph: GraphDescriptorSchema,
    evaluation: GraphRewriteAdaptiveEvaluationSchema,
    options: GraphRewriteAdaptiveOptionsSchema.optional(),
    op_id: z.string().trim().min(1).optional(),
  })
  .strict();

export const GraphRewriteApplyInputSchema = z.discriminatedUnion("mode", [
  GraphRewriteApplyManualSchema,
  GraphRewriteApplyAdaptiveSchema,
]);

export const GraphRewriteApplyInputShape = {
  graph: GraphDescriptorSchema,
  mode: z.enum(["manual", "adaptive"]),
  rules: z.array(z.enum(["split_parallel", "inline_subgraph", "reroute_avoid"])).optional(),
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
      const avoidNodeIds = toTrimmedStringSet(manualOptions?.reroute_avoid_node_ids);
      const avoidLabels = toTrimmedStringSet(manualOptions?.reroute_avoid_labels);
      // Preserve the ergonomics of optional manual parameters while avoiding
      // explicit `undefined` assignments that would violate
      // `exactOptionalPropertyTypes` once enabled.
      const ruleOptions: Parameters<typeof createRerouteAvoidRule>[0] = {
        ...(avoidNodeIds ? { avoidNodeIds } : {}),
        ...(avoidLabels ? { avoidLabels } : {}),
      };
      rules.push(createRerouteAvoidRule(ruleOptions));
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
    const avoidLabels = toTrimmedStringList(adaptiveOptions?.avoid_labels);
    const rewriteOptions = {
      stopOnNoChange,
      ...(avoidLabels ? { avoidLabels } : {}),
    } as const;
    const { graph: rewritten, history: rewriteHistory } = applyAdaptiveRewrites(
      descriptor,
      evaluation,
      rewriteOptions,
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

function deriveTasks(input: GraphGenerateInput, context?: GraphGenerationContext): DerivedTasksResult {
  const manual = normaliseTasksFromInput(input);
  if (manual) {
    return { tasks: manual, notes: [] };
  }

  const knowledgeEnabled = context?.knowledgeEnabled ?? true;
  const knowledgeGraph = knowledgeEnabled ? context?.knowledgeGraph : undefined;

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
        return createTaskDefinition({
          id: task.id,
          dependsOn: task.dependsOn,
          ...(task.label !== undefined ? { label: task.label } : {}),
          ...(task.duration !== undefined ? { duration: task.duration } : {}),
          ...(task.weight !== undefined ? { weight: task.weight } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
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
    const preset = PRESET_LIBRARY[input.preset];
    if (preset) {
      tasks.push(...preset.map(cloneTaskDefinition));
    }
  }
  if (!input.tasks) {
    return tasks.length > 0 ? tasks : null;
  }
  const parsed = parseTaskSource(input.tasks);
  tasks.push(...parsed.map(cloneTaskDefinition));
  return tasks;
}

function parseTaskSource(source: z.infer<typeof TaskSourceSchema>): TaskDefinition[] {
  if (Array.isArray(source)) {
    return source.map((task) =>
      createTaskDefinition({
        id: task.id,
        dependsOn: dedupeStrings(task.depends_on ?? []),
        ...(task.label !== undefined ? { label: task.label } : {}),
        ...(task.duration !== undefined ? { duration: task.duration } : {}),
        ...(task.weight !== undefined ? { weight: task.weight } : {}),
        ...(task.metadata ? { metadata: task.metadata } : {}),
      }),
    );
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
    tasks.push(
      createTaskDefinition({
        id,
        dependsOn,
        ...(label && label.length > 0 ? { label } : {}),
      }),
    );

    if (!seen.has(id)) {
      seen.add(id);
      previous = id;
    }
  }

  return tasks;
}

function graphPayloadEquals(a: GraphDescriptorPayload, b: GraphDescriptorPayload): boolean {
  if ((a.name ?? "") !== (b.name ?? "")) {
    return false;
  }

  if (!shallowRecordEquals(normaliseAttributesForEquality(a.metadata), normaliseAttributesForEquality(b.metadata))) {
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

function applyAddNode(descriptor: NormalisedGraph, node: z.infer<typeof GraphNodeSchema>): GraphMutationRecord {
  const existing = descriptor.nodes.find((entry) => entry.id === node.id);
  if (existing) {
    const mergedAttributes = { ...existing.attributes, ...filterAttributes(node.attributes ?? {}) };
    if (node.label) {
      mergedAttributes.label = node.label;
    }
    if (node.label !== undefined) {
      existing.label = node.label;
    }
    existing.attributes = mergedAttributes;
    return { op: "add_node", description: `node '${node.id}' already existed`, changed: false };
  }

  const nodeAttributes = filterAttributes({
    ...node.attributes,
    ...(node.label ? { label: node.label } : {}),
  });
  // Build the node using conditional spreads so optional properties remain
  // absent instead of being serialised as `undefined`. This keeps the in-memory
  // descriptor compatible with `exactOptionalPropertyTypes`.
  const createdNode = buildGraphNodeRecord({
    id: node.id,
    ...(node.label !== undefined ? { label: node.label } : {}),
    attributes: nodeAttributes,
  });
  descriptor.nodes.push(createdNode);
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
    return { op: "rename_node", description: `target '${newId}' already exists`, changed: false };
  }
  node.id = newId;
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

function applyAddEdge(descriptor: NormalisedGraph, edge: z.infer<typeof GraphEdgeSchema>): GraphMutationRecord {
  const existing = descriptor.edges.find((entry) => entry.from === edge.from && entry.to === edge.to);
  if (existing) {
    const mergedAttributes = { ...existing.attributes, ...filterAttributes(edge.attributes ?? {}) };
    if (edge.label) {
      mergedAttributes.label = edge.label;
    }
    if (edge.label !== undefined) {
      existing.label = edge.label;
    }
    if (typeof edge.weight === "number") {
      existing.weight = edge.weight;
    }
    existing.attributes = mergedAttributes;
    return { op: "add_edge", description: `edge '${edge.from}' -> '${edge.to}' already existed`, changed: false };
  }

  const edgeAttributes = filterAttributes({
    ...edge.attributes,
    ...(edge.label ? { label: edge.label } : {}),
    ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
  });
  // Ensure optional edge fields are omitted when not provided so future strict
  // optional property checks do not observe lingering `undefined` assignments.
  const createdEdge = buildGraphEdgeRecord({
    from: edge.from,
    to: edge.to,
    ...(edge.label !== undefined ? { label: edge.label } : {}),
    ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
    attributes: edgeAttributes,
  });
  descriptor.edges.push(createdEdge);
  return { op: "add_edge", description: `edge '${edge.from}' -> '${edge.to}' created`, changed: true };
}

function applyRemoveEdge(descriptor: NormalisedGraph, from: string, to: string): GraphMutationRecord {
  const initialEdgeCount = descriptor.edges.length;
  descriptor.edges = descriptor.edges.filter((edge) => edge.from !== from || edge.to !== to);
  if (descriptor.edges.length === initialEdgeCount) {
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

function applyPatchMetadata(
  descriptor: NormalisedGraph,
  set: Record<string, GraphAttributeValue>,
  unset: string[],
): GraphMutationRecord {
  const safeSet = filterAttributes(set);
  const keysToUnset = dedupeStrings(
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

type GraphRewriteOperationParams = z.infer<typeof GraphRewriteOperationSchema>["params"];

function applyRewriteOperation(
  descriptor: NormalisedGraph,
  ruleId: z.infer<typeof GraphRewriteOperationSchema>["rule"],
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
      const avoidNodeIds = toTrimmedStringSet(options.reroute_avoid_node_ids);
      const avoidLabels = toTrimmedStringSet(options.reroute_avoid_labels);
      // Build the rule parameters lazily so omitted entries do not leak
      // `undefined` markers into the options record.
      const ruleOptions: Parameters<typeof createRerouteAvoidRule>[0] = {
        ...(avoidNodeIds ? { avoidNodeIds } : {}),
        ...(avoidLabels ? { avoidLabels } : {}),
      };
      rule = createRerouteAvoidRule(ruleOptions);
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
      throw new Error("split_parallel_targets entries must follow '<from>→<to>' or '<from>-><to>'");
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
    edgesToBoost: evaluation.edges_to_boost ?? [],
    edgesToPrune: evaluation.edges_to_prune ?? [],
  };
}

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

function normaliseAttributesForEquality(
  attributes: Record<string, string | number | boolean | undefined> | undefined,
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
  return Object.fromEntries(Object.entries(filtered).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
