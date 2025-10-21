import { createHash } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { z } from "zod";

import {
  projectHyperGraph,
  type HyperEdge,
  type HyperGraph,
} from "../../graph/hypergraph.js";
import type { GraphEdgeRecord, GraphNodeRecord, NormalisedGraph } from "../../graph/types.js";
import { resolveOperationId } from "../operationIds.js";
import { omitUndefinedEntries } from "../../utils/object.js";

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

export const GraphHyperExportInputShape = GraphHyperExportInputSchema.shape;

export type GraphNodePayload = z.output<typeof GraphNodeSchema> & Record<string, unknown>;

export type GraphEdgePayload = z.output<typeof GraphEdgeSchema> & Record<string, unknown>;

export type GraphDescriptorPayload = z.output<typeof GraphDescriptorSchema> & Record<string, unknown>;

export interface GraphHyperExportResult extends Record<string, unknown> {
  op_id: string;
  graph: GraphDescriptorPayload;
  stats: {
    nodes: number;
    hyper_edges: number;
    edges: number;
  };
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
      attributes: node.attributes ?? {},
      // Preserve optional node metadata only when provided to stay compatible
      // with `exactOptionalPropertyTypes`.
      ...omitUndefinedEntries({ label: node.label }),
    })),
    hyperEdges: input.hyper_edges.map((edge) => ({
      id: edge.id,
      sources: [...edge.sources],
      targets: [...edge.targets],
      attributes: edge.attributes ?? {},
      // Drop optional descriptors that callers leave undefined so projected
      // edges never carry explicit `undefined` placeholders.
      ...omitUndefinedEntries({ label: edge.label, weight: edge.weight }),
    } satisfies HyperEdge)),
    ...omitUndefinedEntries({ metadata: input.metadata }),
  } satisfies HyperGraph;

  const projected = projectHyperGraph(
    hyperGraph,
    omitUndefinedEntries({
      // The projection helper expects the caller to omit undefined versions, so
      // we forward the field only when the client surfaced a concrete value.
      graphVersion: input.graph_version,
    }),
  );

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

/**
 * Compute a deterministic fingerprint of the graph content so that stable
 * identifiers can be generated even when callers omit the identifier field.
 */
export function computeGraphFingerprint(descriptor: NormalisedGraph): string {
  const hash = createHash("sha256");
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

export function ensureGraphIdentity(
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
  } else if (
    typeof preferredVersion === "number" &&
    Number.isFinite(preferredVersion) &&
    preferredVersion >= 1
  ) {
    descriptor.graphVersion = Math.floor(preferredVersion);
  } else if (
    !(
      typeof descriptor.graphVersion === "number" &&
      Number.isFinite(descriptor.graphVersion) &&
      descriptor.graphVersion >= 1
    )
  ) {
    descriptor.graphVersion = 1;
  }
}

export function serialiseDescriptor(descriptor: NormalisedGraph): GraphDescriptorPayload {
  ensureGraphIdentity(descriptor);
  return {
    name: descriptor.name,
    graph_id: descriptor.graphId,
    graph_version: descriptor.graphVersion,
    nodes: descriptor.nodes.map((node) => {
      const payload: GraphDescriptorPayload["nodes"][number] = {
        id: node.id,
        attributes: sortAttributes(node.attributes),
      };
      if (node.label !== undefined) {
        // Optional labels are copied verbatim only when explicitly set, ensuring the
        // serialised payload keeps working under `exactOptionalPropertyTypes`.
        payload.label = node.label;
      }
      return payload;
    }),
    edges: descriptor.edges.map((edge) => {
      const payload: GraphDescriptorPayload["edges"][number] = {
        from: edge.from,
        to: edge.to,
        attributes: sortAttributes(edge.attributes),
      };
      if (edge.label !== undefined) {
        payload.label = edge.label;
      }
      if (edge.weight !== undefined) {
        payload.weight = edge.weight;
      }
      return payload;
    }),
    metadata: sortAttributes(descriptor.metadata),
  } satisfies GraphDescriptorPayload;
}

export function normaliseDescriptor(graph: z.infer<typeof GraphDescriptorSchema>): NormalisedGraph {
  const nodes = graph.nodes.map((node) => {
    const descriptor: GraphNodeRecord = {
      id: node.id,
      attributes: filterAttributes({
        ...node.attributes,
        ...(node.label ? { label: node.label } : {}),
      }),
    };
    if (node.label !== undefined) {
      // With `exactOptionalPropertyTypes`, optional fields must be omitted when absent.
      descriptor.label = node.label;
    }
    return descriptor;
  });
  const edges = graph.edges.map((edge) => {
    const descriptor: GraphEdgeRecord = {
      from: edge.from,
      to: edge.to,
      attributes: filterAttributes({
        ...edge.attributes,
        ...(edge.label ? { label: edge.label } : {}),
        ...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
      }),
    };
    if (edge.label !== undefined) {
      descriptor.label = edge.label;
    }
    if (edge.weight !== undefined) {
      descriptor.weight = edge.weight;
    }
    return descriptor;
  });
  const metadata = filterAttributes(graph.metadata ?? {});
  const descriptor: NormalisedGraph = {
    name: graph.name,
    graphId: graph.graph_id ?? "",
    graphVersion: graph.graph_version ?? 1,
    nodes,
    edges,
    metadata,
  };
  ensureGraphIdentity(descriptor, {
    preferId: graph.graph_id ?? null,
    preferVersion: graph.graph_version ?? null,
  });
  return descriptor;
}

export function graphPayloadEquals(
  a: GraphDescriptorPayload,
  b: GraphDescriptorPayload,
): boolean {
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

export function adoptGraphDescriptor(target: NormalisedGraph, source: NormalisedGraph): void {
  target.name = source.name;
  target.graphId = source.graphId;
  target.graphVersion = source.graphVersion;
  target.nodes = source.nodes.map((node) => {
    const descriptor: GraphNodeRecord = {
      id: node.id,
      attributes: { ...node.attributes },
    };
    if (node.label !== undefined) {
      // Preserve labels only when callers explicitly provided one to avoid
      // serialising `label: undefined` once strict optional semantics are enforced.
      descriptor.label = node.label;
    }
    return descriptor;
  });
  target.edges = source.edges.map((edge) => {
    const descriptor: GraphEdgeRecord = {
      from: edge.from,
      to: edge.to,
      attributes: { ...edge.attributes },
    };
    if (edge.label !== undefined) {
      descriptor.label = edge.label;
    }
    if (edge.weight !== undefined) {
      descriptor.weight = edge.weight;
    }
    return descriptor;
  });
  target.metadata = { ...source.metadata };
}

export function filterAttributes(values: Record<string, unknown>): Record<string, string | number | boolean> {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function sortAttributes(
  attributes: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  const sortedEntries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted: Record<string, string | number | boolean> = {};
  for (const [key, value] of sortedEntries) {
    sorted[key] = value;
  }
  return sorted;
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
  return sortAttributes(filtered);
}

export type GraphHyperExportInput = z.infer<typeof GraphHyperExportInputSchema>;

