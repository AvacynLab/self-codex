import type { NormalisedGraph, GraphAttributeValue } from "./types.js";

/**
 * JSON Patch operation supported by the diff/patch helpers. Only the subset of
 * operations required for graph synchronisation is implemented so callers are
 * not tempted to rely on exotic behaviours that would complicate invariants.
 */
export interface JsonPatchOperation {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/** Result returned when diffing two graphs. */
export interface GraphDiffResult {
  /** Patch operations capable of transforming {@link base} into {@link target}. */
  operations: JsonPatchOperation[];
  /** Indicates whether the graphs differ structurally. */
  changed: boolean;
  /** High-level summary of the mutated top-level sections. */
  summary: {
    nameChanged: boolean;
    metadataChanged: boolean;
    nodesChanged: boolean;
    edgesChanged: boolean;
  };
}

/**
 * Compute a RFC 6902 JSON Patch transforming {@link base} into {@link target}.
 *
 * The implementation intentionally focuses on top-level mutations (name,
 * metadata, nodes, edges) to guarantee deterministic output without requiring
 * a heavy structural diff dependency. Arrays are fully replaced whenever they
 * diverge which keeps the patch readable and easy to apply.
 */
export function diffGraphs(base: NormalisedGraph, target: NormalisedGraph): GraphDiffResult {
  const baseDoc = toDiffDocument(base);
  const targetDoc = toDiffDocument(target);

  const operations: JsonPatchOperation[] = [];

  if (baseDoc.name !== targetDoc.name) {
    operations.push({ op: "replace", path: "/name", value: targetDoc.name });
  }

  if (!recordsEqual(baseDoc.metadata, targetDoc.metadata)) {
    emitRecordDiff("/metadata", baseDoc.metadata, targetDoc.metadata, operations);
  }

  const nodesChanged = !arraysEqual(baseDoc.nodes, targetDoc.nodes);
  if (nodesChanged) {
    operations.push({ op: "replace", path: "/nodes", value: targetDoc.nodes });
  }

  const edgesChanged = !arraysEqual(baseDoc.edges, targetDoc.edges);
  if (edgesChanged) {
    operations.push({ op: "replace", path: "/edges", value: targetDoc.edges });
  }

  const changed = operations.length > 0;
  return {
    operations,
    changed,
    summary: {
      nameChanged: baseDoc.name !== targetDoc.name,
      metadataChanged: !recordsEqual(baseDoc.metadata, targetDoc.metadata),
      nodesChanged,
      edgesChanged,
    },
  };
}

/** Canonical representation leveraged by {@link diffGraphs}. */
interface DiffDocument {
  name: string;
  metadata: Record<string, GraphAttributeValue>;
  nodes: Array<{
    id: string;
    label: string | null;
    attributes: Record<string, GraphAttributeValue>;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label: string | null;
    weight: number | null;
    attributes: Record<string, GraphAttributeValue>;
  }>;
}

/** Convert a normalised graph into the canonical representation used for diffs. */
function toDiffDocument(graph: NormalisedGraph): DiffDocument {
  return {
    name: graph.name ?? "",
    metadata: sortRecord(graph.metadata ?? {}),
    nodes: graph.nodes
      .map((node) => ({
        id: node.id,
        label: node.label ?? null,
        attributes: sortRecord(node.attributes ?? {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: graph.edges
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label ?? null,
        weight: typeof edge.weight === "number" ? Number(edge.weight) : null,
        attributes: sortRecord(edge.attributes ?? {}),
      }))
      .sort((a, b) => {
        if (a.from === b.from) {
          return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
        }
        return a.from < b.from ? -1 : 1;
      }),
  };
}

/** Compare two records for equality (assuming both were sorted). */
function recordsEqual(
  left: Record<string, GraphAttributeValue>,
  right: Record<string, GraphAttributeValue>,
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

/** Compare two arrays via JSON serialization (values are already canonical). */
function arraysEqual(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return false;
    }
  }
  return true;
}

/** Emit per-key JSON Patch operations for record mutations. */
function emitRecordDiff(
  basePath: string,
  base: Record<string, GraphAttributeValue>,
  target: Record<string, GraphAttributeValue>,
  operations: JsonPatchOperation[],
): void {
  const baseKeys = new Set(Object.keys(base));
  const targetKeys = new Set(Object.keys(target));

  for (const key of baseKeys) {
    if (!targetKeys.has(key)) {
      operations.push({ op: "remove", path: `${basePath}/${escapePointer(key)}` });
    }
  }
  for (const key of targetKeys) {
    const pointer = `${basePath}/${escapePointer(key)}`;
    if (!baseKeys.has(key)) {
      operations.push({ op: "add", path: pointer, value: target[key] });
    } else if (base[key] !== target[key]) {
      operations.push({ op: "replace", path: pointer, value: target[key] });
    }
  }
}

/** Sort record entries lexicographically for deterministic comparisons. */
function sortRecord(values: Record<string, GraphAttributeValue>): Record<string, GraphAttributeValue> {
  const sortedEntries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, GraphAttributeValue> = {};
  for (const [key, value] of sortedEntries) {
    result[key] = value;
  }
  return result;
}

/** Escape a JSON pointer segment following RFC 6901. */
function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
