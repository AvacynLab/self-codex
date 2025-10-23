import { z } from "zod";

import { ERROR_CODES } from "../types.js";
import {
  evaluateGraphInvariants,
  GraphInvariantError,
  type GraphInvariantOptions,
  type GraphInvariantReport,
  type GraphInvariantViolation,
} from "./invariants.js";
import type { GraphAttributeValue, NormalisedGraph } from "./types.js";

/**
 * Issues surfaced by {@link validateGraph}. Matches the shape used by
 * {@link GraphInvariantError} so existing tooling can surface violations
 * uniformly regardless of their origin (schema vs. invariant).
 */
export type GraphValidationIssue = GraphInvariantViolation;

/**
 * Options controlling structural validation in addition to the invariant flags.
 */
export interface GraphValidationOptions extends GraphInvariantOptions {
  /** Disable invariant evaluation entirely when set to false. */
  enforceInvariants?: boolean;
  /** Allow self-referencing edges if explicitly requested. */
  allowSelfLoops?: boolean;
  /** Allow nodes without incoming/outgoing edges. */
  allowIsolatedNodes?: boolean;
  /** Maximum number of nodes accepted for the descriptor. */
  maxNodes?: number;
  /** Maximum number of edges accepted for the descriptor. */
  maxEdges?: number;
}

/** Successful validation outcome. */
export interface GraphValidationSuccess {
  ok: true;
  invariants: GraphInvariantReport | null;
}

/** Validation failure exposing the collected violations. */
export interface GraphValidationFailure {
  ok: false;
  invariants: GraphInvariantReport | null;
  violations: GraphValidationIssue[];
}

/** Result returned by {@link validateGraph}. */
export type GraphValidationResult = GraphValidationSuccess | GraphValidationFailure;

/** Error thrown when structural validation fails. */
export class GraphValidationError extends GraphInvariantError {
  public readonly invariants: GraphInvariantReport | null;

  constructor(violations: GraphValidationIssue[], invariants: GraphInvariantReport | null) {
    super(violations);
    this.name = "GraphValidationError";
    this.invariants = invariants;
  }
}

/**
 * Validate a normalised graph descriptor against structural constraints and the
 * configured invariants. The helper intentionally returns a rich result so
 * callers can surface non-fatal warnings while still enforcing hard failures.
 */
export function validateGraph(
  graph: NormalisedGraph,
  overrides: GraphValidationOptions = {},
): GraphValidationResult {
  const options = deriveOptions(graph, overrides);
  const violations: GraphValidationIssue[] = [];

  const structural = GraphSchema.safeParse(graph);
  if (!structural.success) {
    for (const issue of structural.error.issues) {
      violations.push({
        code: ERROR_CODES.GRAPH_INVALID_INPUT,
        message: issue.message,
        path: `/${issue.path.join("/")}`,
        hint: "graph_descriptor_invalid",
      });
    }
  }

  if (graph.nodes.length === 0) {
    violations.push({
      code: ERROR_CODES.GRAPH_INVALID_INPUT,
      message: "graph must declare at least one node",
      path: "/nodes",
      hint: "provide_nodes",
    });
  }

  if (typeof options.maxNodes === "number" && graph.nodes.length > options.maxNodes) {
    violations.push({
      code: ERROR_CODES.GRAPH_INVALID_INPUT,
      message: `node limit exceeded (${graph.nodes.length} > ${options.maxNodes})`,
      path: "/nodes",
      hint: "reduce_node_count_or_raise_limit",
      details: { max: options.maxNodes, actual: graph.nodes.length },
    });
  }

  if (typeof options.maxEdges === "number" && graph.edges.length > options.maxEdges) {
    violations.push({
      code: ERROR_CODES.GRAPH_INVALID_INPUT,
      message: `edge limit exceeded (${graph.edges.length} > ${options.maxEdges})`,
      path: "/edges",
      hint: "reduce_edge_count_or_raise_limit",
      details: { max: options.maxEdges, actual: graph.edges.length },
    });
  }

  const nodeIds = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      violations.push({
        code: ERROR_CODES.GRAPH_INVALID_INPUT,
        message: `duplicate node identifier '${node.id}'`,
        path: `/nodes/${index}`,
        hint: "ensure_node_ids_unique",
      });
    }
    nodeIds.add(node.id);
  });

  graph.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      violations.push({
        code: ERROR_CODES.GRAPH_INVALID_INPUT,
        message: `edge '${edge.from}' -> '${edge.to}' references an unknown node`,
        path: `/edges/${index}`,
        hint: "ensure_edge_nodes_exist",
        details: { from: edge.from, to: edge.to },
      });
    }
    if (!options.allowSelfLoops && edge.from === edge.to) {
      violations.push({
        code: ERROR_CODES.GRAPH_INVALID_INPUT,
        message: `self-loop detected on node '${edge.from}'`,
        path: `/edges/${index}`,
        hint: "remove_self_loop_or_enable_allow_self_loops",
      });
    }
  });

  if (!options.allowIsolatedNodes) {
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const node of graph.nodes) {
      incoming.set(node.id, 0);
      outgoing.set(node.id, 0);
    }
    for (const edge of graph.edges) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
      outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    }
    graph.nodes.forEach((node, index) => {
      if ((incoming.get(node.id) ?? 0) === 0 && (outgoing.get(node.id) ?? 0) === 0) {
        violations.push({
          code: ERROR_CODES.GRAPH_INVALID_INPUT,
          message: `isolated node '${node.id}' detected`,
          path: `/nodes/${index}`,
          hint: "connect_node_or_allow_isolated_nodes",
        });
      }
    });
  }

  const invariants: GraphInvariantReport | null = options.enforceInvariants
    ? evaluateGraphInvariants(graph, options)
    : null;

  if (invariants && !invariants.ok) {
    violations.push(...invariants.violations);
  }

  if (violations.length > 0) {
    return { ok: false, invariants, violations } satisfies GraphValidationFailure;
  }
  return { ok: true, invariants } satisfies GraphValidationSuccess;
}

/** Throw a {@link GraphValidationError} when the descriptor violates constraints. */
export function assertValidGraph(
  graph: NormalisedGraph,
  overrides: GraphValidationOptions = {},
): void {
  const result = validateGraph(graph, overrides);
  if (!result.ok) {
    throw new GraphValidationError(result.violations, result.invariants);
  }
}

/** Scalar attribute accepted on nodes/edges. */
const AttributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** Schema ensuring individual nodes match the expected format. */
const NodeSchema = z
  .object({
    id: z.string().min(1, "node id must be provided"),
    label: z.string().trim().min(1, "label must not be empty").max(240).optional(),
    attributes: z.record(AttributeValueSchema).default({}),
  })
  .strict();

/** Schema ensuring edges reference valid scalar attributes. */
const EdgeSchema = z
  .object({
    from: z.string().min(1, "edge.from must reference a node"),
    to: z.string().min(1, "edge.to must reference a node"),
    label: z.string().trim().min(1, "label must not be empty").max(240).optional(),
    weight: z.number().finite("weight must be a finite number").optional(),
    attributes: z.record(AttributeValueSchema).default({}),
  })
  .strict();

/** Zod schema validating the structural shape of a normalised graph. */
const GraphSchema = z
  .object({
    name: z.string().min(1, "graph name must be provided"),
    graphId: z.string().min(1, "graphId must be provided"),
    graphVersion: z.number().int().nonnegative("graphVersion must be a non-negative integer"),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    metadata: z.record(AttributeValueSchema).default({}),
  })
  .strict();

/**
 * Merge metadata-derived options with caller overrides. Metadata values are
 * treated as hints and normalised to primitive types for predictable behaviour.
 */
type DerivedValidationOptions = Required<
  Pick<GraphValidationOptions, "allowSelfLoops" | "allowIsolatedNodes" | "enforceInvariants">
> &
  GraphInvariantOptions & {
    maxNodes?: number;
    maxEdges?: number;
  };

function deriveOptions(
  graph: NormalisedGraph,
  overrides: GraphValidationOptions,
): DerivedValidationOptions {
  const metadata = normaliseRecord(graph.metadata ?? {});
  const maxNodes = overrides.maxNodes ?? parseLimit(metadata.max_nodes);
  const maxEdges = overrides.maxEdges ?? parseLimit(metadata.max_edges);
  const defaultMaxInDegree = overrides.defaultMaxInDegree ?? parseLimit(metadata.max_in_degree);
  const defaultMaxOutDegree = overrides.defaultMaxOutDegree ?? parseLimit(metadata.max_out_degree);

  const derived: DerivedValidationOptions = {
    enforceInvariants: overrides.enforceInvariants ?? true,
    allowSelfLoops: overrides.allowSelfLoops ?? metadata.allow_self_loops === true,
    allowIsolatedNodes: overrides.allowIsolatedNodes ?? metadata.allow_isolated_nodes === true,
    enforceDag:
      overrides.enforceDag ?? (metadata.graph_kind === "dag" || metadata.dag === true || metadata.enforce_dag === true),
    requireNodeLabels: overrides.requireNodeLabels ?? metadata.require_labels === true,
    requireEdgeLabels: overrides.requireEdgeLabels ?? metadata.require_edge_labels === true,
    requirePortAttributes: overrides.requirePortAttributes ?? metadata.require_ports === true,
  } satisfies DerivedValidationOptions;

  if (maxNodes !== undefined) {
    derived.maxNodes = maxNodes;
  }
  if (maxEdges !== undefined) {
    derived.maxEdges = maxEdges;
  }
  if (defaultMaxInDegree !== undefined) {
    derived.defaultMaxInDegree = defaultMaxInDegree;
  }
  if (defaultMaxOutDegree !== undefined) {
    derived.defaultMaxOutDegree = defaultMaxOutDegree;
  }

  return derived;
}

/** Normalise metadata/attribute records. */
function normaliseRecord(record: Record<string, GraphAttributeValue>): Record<string, GraphAttributeValue> {
  const output: Record<string, GraphAttributeValue> = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = value;
  }
  return output;
}

/** Parse numeric limits ensuring they are positive integers. */
function parseLimit(value: GraphAttributeValue | undefined): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
