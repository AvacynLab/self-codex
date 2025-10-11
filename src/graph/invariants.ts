import type { NormalisedGraph, GraphAttributeValue } from "./types.js";
import { ERROR_CODES, type ErrorCode } from "../types.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/** Violation reported when a graph breaks one of the enforced invariants. */
export interface GraphInvariantViolation {
  /** Stable error code identifying the violated invariant. */
  code: ErrorCode;
  /** Human readable explanation of the issue. */
  message: string;
  /** JSON pointer to the offending location inside the graph descriptor. */
  path: string;
  /** Optional actionable hint describing how to resolve the violation. */
  hint?: string;
  /** Optional structured details attached to the violation. */
  details?: Record<string, unknown>;
}

/** Summary returned when evaluating the invariants for a graph. */
export type GraphInvariantReport =
  | { ok: true }
  | { ok: false; violations: GraphInvariantViolation[] };

/** Options controlling which invariants must be enforced. */
export interface GraphInvariantOptions {
  enforceDag?: boolean;
  requireNodeLabels?: boolean;
  requireEdgeLabels?: boolean;
  requirePortAttributes?: boolean;
  defaultMaxInDegree?: number;
  defaultMaxOutDegree?: number;
}

/** Error thrown when invariants are violated. */
export class GraphInvariantError extends Error {
  public readonly code: ErrorCode;
  public readonly details: { violations: GraphInvariantViolation[] };

  constructor(readonly violations: GraphInvariantViolation[]) {
    super(violations.map((violation) => `${violation.code}: ${violation.message}`).join("; "));
    this.name = "GraphInvariantError";
    this.code = violations[0]?.code ?? ERROR_CODES.PATCH_INVARIANT_VIOLATION;
    this.details = { violations };
  }
}

/**
 * Evaluate the invariants declared in the graph metadata and node attributes.
 * Callers can override the derived options via {@link overrides}.
 */
export function evaluateGraphInvariants(
  graph: NormalisedGraph,
  overrides: GraphInvariantOptions = {},
): GraphInvariantReport {
  const options = deriveOptions(graph, overrides);
  const violations: GraphInvariantViolation[] = [];

  if (options.enforceDag) {
    const cycles = detectCycles(graph);
    if (cycles.length > 0) {
      for (const cycle of cycles) {
        const cyclePath = cycle.join(" -> ");
        violations.push({
          code: ERROR_CODES.PATCH_CYCLE,
          message: `cycle detected: ${cyclePath}`,
          path: "/edges",
          hint: "remove or reroute one of the cycle edges",
          details: { cycle },
        });
      }
    }
  }

  if (options.requireNodeLabels) {
    graph.nodes.forEach((node, index) => {
      if (!node.label || node.label.trim().length === 0) {
        violations.push({
          code: ERROR_CODES.PATCH_PORTS,
          message: `node '${node.id}' is missing a label`,
          path: `/nodes/${index}`,
          hint: "provide a non-empty label for the node",
        });
      }
    });
  }

  if (options.requireEdgeLabels) {
    graph.edges.forEach((edge, index) => {
      if (!edge.label || edge.label.trim().length === 0) {
        violations.push({
          code: ERROR_CODES.PATCH_PORTS,
          message: `edge '${edge.from}' -> '${edge.to}' is missing a label`,
          path: `/edges/${index}`,
          hint: "set the 'label' property on the edge",
        });
      }
    });
  }

  if (options.requirePortAttributes) {
    graph.edges.forEach((edge, index) => {
      const fromPort = normalisePort(edge.attributes.from_port);
      const toPort = normalisePort(edge.attributes.to_port);
      if (!fromPort || !toPort) {
        violations.push({
          code: ERROR_CODES.PATCH_PORTS,
          message: `edge '${edge.from}' -> '${edge.to}' must declare 'from_port' and 'to_port' attributes`,
          path: `/edges/${index}`,
          hint: "ensure both 'from_port' and 'to_port' attributes are defined",
        });
      }
    });
  }

  const cardinalityViolations = enforceCardinality(graph, options);
  violations.push(...cardinalityViolations);

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Assert that the invariants hold, throwing a {@link GraphInvariantError} when they do not. */
export function assertGraphInvariants(
  graph: NormalisedGraph,
  overrides: GraphInvariantOptions = {},
): void {
  const report = evaluateGraphInvariants(graph, overrides);
  if (!report.ok) {
    throw new GraphInvariantError(report.violations);
  }
}

/** Infer invariant options from metadata and node attributes. */
function deriveOptions(graph: NormalisedGraph, overrides: GraphInvariantOptions): GraphInvariantOptions {
  const metadata = normaliseRecord(graph.metadata ?? {});
  return {
    enforceDag:
      overrides.enforceDag ?? (metadata.graph_kind === "dag" || metadata.dag === true || metadata.enforce_dag === true),
    requireNodeLabels: overrides.requireNodeLabels ?? metadata.require_labels === true,
    requireEdgeLabels: overrides.requireEdgeLabels ?? metadata.require_edge_labels === true,
    requirePortAttributes: overrides.requirePortAttributes ?? metadata.require_ports === true,
    defaultMaxInDegree: overrides.defaultMaxInDegree ?? parseDegree(metadata.max_in_degree),
    defaultMaxOutDegree: overrides.defaultMaxOutDegree ?? parseDegree(metadata.max_out_degree),
  } satisfies GraphInvariantOptions;
}

/** Parse a degree hint from metadata. */
function parseDegree(value: GraphAttributeValue | undefined): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Enforce per-node cardinality limits using metadata defaults and attribute-level overrides.
 */
function enforceCardinality(graph: NormalisedGraph, options: GraphInvariantOptions): GraphInvariantViolation[] {
  const violations: GraphInvariantViolation[] = [];
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
    const maxIn = parseDegree(node.attributes.max_in_degree) ?? options.defaultMaxInDegree;
    const maxOut = parseDegree(node.attributes.max_out_degree) ?? options.defaultMaxOutDegree;
    const path = `/nodes/${index}`;
    if (typeof maxIn === "number" && (incoming.get(node.id) ?? 0) > maxIn) {
      const actual = incoming.get(node.id) ?? 0;
      violations.push({
        code: ERROR_CODES.PATCH_CARD,
        message: `node '${node.id}' exceeds max_in_degree (${actual} > ${maxIn})`,
        path,
        hint: "reduce the number of incoming edges or raise the allowed degree",
        details: { direction: "in", node: node.id, max: maxIn, actual },
      });
    }
    if (typeof maxOut === "number" && (outgoing.get(node.id) ?? 0) > maxOut) {
      const actual = outgoing.get(node.id) ?? 0;
      violations.push({
        code: ERROR_CODES.PATCH_CARD,
        message: `node '${node.id}' exceeds max_out_degree (${actual} > ${maxOut})`,
        path,
        hint: "reduce outgoing edges or adjust max_out_degree",
        details: { direction: "out", node: node.id, max: maxOut, actual },
      });
    }
  });

  return violations;
}

/** Detect directed cycles using depth-first search. */
function detectCycles(graph: NormalisedGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from)!.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (nodeId: string): void => {
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const neighbour of adjacency.get(nodeId) ?? []) {
      if (visiting.has(neighbour)) {
        const startIndex = stack.indexOf(neighbour);
        if (startIndex >= 0) {
          cycles.push(stack.slice(startIndex).concat(neighbour));
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

  for (const nodeId of adjacency.keys()) {
    if (!visited.has(nodeId)) {
      visit(nodeId);
    }
  }

  return cycles;
}

/** Normalise metadata/attribute records. */
function normaliseRecord(record: Record<string, GraphAttributeValue>): Record<string, GraphAttributeValue> {
  const output: Record<string, GraphAttributeValue> = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = value;
  }
  return output;
}

/** Normalise a port attribute value into a non-empty string. */
function normalisePort(value: GraphAttributeValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
