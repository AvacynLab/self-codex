import { NormalisedGraph, type GraphAttributeValue, type GraphEdgeRecord, type GraphNodeRecord } from "./types.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/** Default input port assigned when a task endpoint does not specify one explicitly. */
const DEFAULT_INPUT_PORT = "in";
/** Default output port assigned when a task endpoint does not specify one explicitly. */
const DEFAULT_OUTPUT_PORT = "out";

/** Internal key used to store the embedded hierarchical sub-graph within a subgraph node. */
const EMBEDDED_GRAPH_KEY = "__embeddedGraph";
/** Internal key used to track the ancestry of embeddings to detect cycles. */
const ANCESTRY_KEY = "__hierarchyAncestry";

/** Strongly typed mapping between named ports and target node identifiers. */
export interface SubgraphPorts {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

/** Description of a task node living at a specific hierarchical level. */
export interface TaskNode {
  id: string;
  kind: "task";
  label?: string;
  /** Optional attributes propagated to the flattened normalised graph. */
  attributes?: Record<string, GraphAttributeValue>;
  /** Optional list of accepted input port names. */
  inputs?: string[];
  /** Optional list of exposed output port names. */
  outputs?: string[];
}

/** Structural node that references a sub-graph to embed. */
export interface SubgraphNode {
  id: string;
  kind: "subgraph";
  ref: string;
  params?: Record<string, unknown>;
}

/** Union of all possible node types within a hierarchical graph. */
export type HierNode = TaskNode | SubgraphNode;

/** Endpoint describing a reference to a node identifier and an optional port. */
export interface EdgeEndpoint {
  nodeId: string;
  port?: string;
}

/** Directed edge within a hierarchical graph. */
export interface Edge {
  id: string;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  label?: string;
  attributes?: Record<string, GraphAttributeValue>;
}

/** High-level hierarchical graph description used before expansion. */
export interface HierGraph {
  id: string;
  nodes: HierNode[];
  edges: Edge[];
}

/** Shape returned internally when flattening an embedded sub-graph. */
interface PortBinding {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

/**
 * Determine whether the provided node represents a task.
 */
function isTaskNode(node: HierNode): node is TaskNode {
  return node.kind === "task";
}

/**
 * Determine whether the provided node represents a sub-graph placeholder.
 */
function isSubgraphNode(node: HierNode): node is SubgraphNode {
  return node.kind === "subgraph";
}

/**
 * Normalise the provided list of port names, defaulting to a single entry when undefined.
 */
function normalisePorts(ports: string[] | undefined, fallback: string): Set<string> {
  if (!ports || ports.length === 0) {
    return new Set([fallback]);
  }
  const unique = new Set<string>();
  for (const port of ports) {
    if (typeof port !== "string" || port.trim().length === 0) {
      throw new Error(`Invalid port name \"${port}\"`);
    }
    unique.add(port);
  }
  return unique;
}

/**
 * Extract and validate the SubgraphPorts contract stored inside a subgraph node.
 */
function extractSubgraphPorts(node: SubgraphNode): SubgraphPorts {
  const raw = node.params?.ports as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Subgraph node ${node.id} is missing ports declaration`);
  }
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  const rawInputs = (raw as { inputs?: unknown }).inputs;
  const rawOutputs = (raw as { outputs?: unknown }).outputs;
  if (!rawInputs || typeof rawInputs !== "object") {
    throw new Error(`Subgraph node ${node.id} is missing input ports`);
  }
  if (!rawOutputs || typeof rawOutputs !== "object") {
    throw new Error(`Subgraph node ${node.id} is missing output ports`);
  }
  for (const [key, value] of Object.entries(rawInputs as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid input port mapping for subgraph ${node.id}`);
    }
    inputs[key] = value;
  }
  for (const [key, value] of Object.entries(rawOutputs as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid output port mapping for subgraph ${node.id}`);
    }
    outputs[key] = value;
  }
  return { inputs, outputs };
}

/**
 * Retrieve the embedded graph stored inside a subgraph node, if any.
 */
function extractEmbeddedGraph(node: SubgraphNode): HierGraph | undefined {
  const raw = node.params?.[EMBEDDED_GRAPH_KEY] as unknown;
  if (!raw) {
    return undefined;
  }
  if (typeof raw !== "object") {
    throw new Error(`Embedded graph payload for node ${node.id} is invalid`);
  }
  return raw as HierGraph;
}

/**
 * Deep clone a hierarchical graph to avoid accidental mutations when embedding.
 */
function cloneHierGraph(graph: HierGraph): HierGraph {
  return structuredClone(graph);
}

/**
 * Recursively ensure that embedding the provided sub-graph would not introduce a cycle across hierarchy levels.
 */
function assertNoInterLevelCycle(graph: HierGraph, ancestors: Set<string>): void {
  if (ancestors.has(graph.id)) {
    throw new Error(`Embedding graph ${graph.id} would introduce a cycle`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(graph.id);
  for (const node of graph.nodes) {
    if (isSubgraphNode(node)) {
      if (ancestors.has(node.ref)) {
        throw new Error(`Embedding subgraph ${node.ref} would create an inter-level cycle`);
      }
      const embedded = extractEmbeddedGraph(node);
      if (embedded) {
        assertNoInterLevelCycle(embedded, nextAncestors);
      }
    }
  }
}

/**
 * Ensure node identifiers are unique and all edges reference valid nodes and ports.
 */
function validateHierGraph(graph: HierGraph): void {
  const idSet = new Set<string>();
  const nodeById = new Map<string, HierNode>();
  for (const node of graph.nodes) {
    if (idSet.has(node.id)) {
      throw new Error(`Duplicate node identifier detected: ${node.id}`);
    }
    idSet.add(node.id);
    nodeById.set(node.id, node);
    if (isTaskNode(node)) {
      normalisePorts(node.inputs, DEFAULT_INPUT_PORT);
      normalisePorts(node.outputs, DEFAULT_OUTPUT_PORT);
    } else if (isSubgraphNode(node)) {
      if (!node.ref || node.ref.trim().length === 0) {
        throw new Error(`Subgraph node ${node.id} must reference a subgraph identifier`);
      }
      // Validate ports and embedded graphs up-front.
      extractSubgraphPorts(node);
      const embedded = extractEmbeddedGraph(node);
      if (embedded) {
        validateHierGraph(embedded);
      }
    }
  }
  for (const edge of graph.edges) {
    const fromNode = nodeById.get(edge.from.nodeId);
    const toNode = nodeById.get(edge.to.nodeId);
    if (!fromNode) {
      throw new Error(`Edge ${edge.id} references unknown source node ${edge.from.nodeId}`);
    }
    if (!toNode) {
      throw new Error(`Edge ${edge.id} references unknown target node ${edge.to.nodeId}`);
    }
    const fromPort = edge.from.port ?? DEFAULT_OUTPUT_PORT;
    if (isTaskNode(fromNode)) {
      const ports = normalisePorts(fromNode.outputs, DEFAULT_OUTPUT_PORT);
      if (!ports.has(fromPort)) {
        throw new Error(`Edge ${edge.id} references missing output port ${fromPort} on ${fromNode.id}`);
      }
    } else {
      const ports = extractSubgraphPorts(fromNode).outputs;
      if (!ports[fromPort]) {
        throw new Error(`Edge ${edge.id} references missing subgraph output port ${fromPort} on ${fromNode.id}`);
      }
    }
    const toPort = edge.to.port ?? DEFAULT_INPUT_PORT;
    if (isTaskNode(toNode)) {
      const ports = normalisePorts(toNode.inputs, DEFAULT_INPUT_PORT);
      if (!ports.has(toPort)) {
        throw new Error(`Edge ${edge.id} references missing input port ${toPort} on ${toNode.id}`);
      }
    } else {
      const ports = extractSubgraphPorts(toNode).inputs;
      if (!ports[toPort]) {
        throw new Error(`Edge ${edge.id} references missing subgraph input port ${toPort} on ${toNode.id}`);
      }
    }
  }
}

/**
 * Helper exposing the embedded graph stored inside a subgraph node (used in tests and diagnostics).
 */
export function getEmbeddedGraph(node: SubgraphNode): HierGraph | undefined {
  return extractEmbeddedGraph(node);
}

/**
 * Embed the provided sub-graph inside the selected subgraph node, returning a new hierarchical graph instance.
 */
export function embedSubgraph(parent: HierGraph, nodeId: string, sub: HierGraph): HierGraph {
  validateHierGraph(parent);
  validateHierGraph(sub);
  const node = parent.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Unknown node ${nodeId}`);
  }
  if (!isSubgraphNode(node)) {
    throw new Error(`Node ${nodeId} is not a subgraph node`);
  }
  if (node.ref !== sub.id) {
    throw new Error(`Subgraph node ${nodeId} expects graph ${node.ref} but received ${sub.id}`);
  }
  const declaredPorts = extractSubgraphPorts(node);
  const subNodeIds = new Set(sub.nodes.map((candidate) => candidate.id));
  for (const target of Object.values(declaredPorts.inputs)) {
    if (!subNodeIds.has(target)) {
      throw new Error(`Input port on ${node.id} targets missing node ${target} in subgraph ${sub.id}`);
    }
  }
  for (const target of Object.values(declaredPorts.outputs)) {
    if (!subNodeIds.has(target)) {
      throw new Error(`Output port on ${node.id} targets missing node ${target} in subgraph ${sub.id}`);
    }
  }
  const ancestry = new Set<string>(
    Array.isArray(node.params?.[ANCESTRY_KEY]) ? (node.params?.[ANCESTRY_KEY] as string[]) : [],
  );
  ancestry.add(parent.id);
  assertNoInterLevelCycle(sub, ancestry);
  const embedded = cloneHierGraph(sub);
  const updatedNode: SubgraphNode = {
    ...node,
    params: {
      ...node.params,
      [EMBEDDED_GRAPH_KEY]: embedded,
      [ANCESTRY_KEY]: Array.from(ancestry),
    },
  };
  return {
    ...parent,
    nodes: parent.nodes.map((candidate) => (candidate.id === nodeId ? updatedNode : candidate)),
  };
}

/**
 * Convert a hierarchical graph into the flattened normalised representation consumed by the rest of the orchestrator.
 */
export function flatten(hier: HierGraph): NormalisedGraph {
  validateHierGraph(hier);
  const nodes: GraphNodeRecord[] = [];
  const edges: GraphEdgeRecord[] = [];
  const addedNodeIds = new Set<string>();

  function addNode(record: GraphNodeRecord): void {
    if (addedNodeIds.has(record.id)) {
      return;
    }
    addedNodeIds.add(record.id);
    nodes.push(record);
  }

  function flattenRecursive(graph: HierGraph, prefix: string, ancestors: Set<string>): Map<string, string> {
    assertNoInterLevelCycle(graph, ancestors);
    const idPrefix = prefix.length > 0 ? `${prefix}/` : "";
    const mapping = new Map<string, string>();
    const portBindings = new Map<string, PortBinding>();
    const localAncestors = new Set(ancestors);
    localAncestors.add(graph.id);

    for (const node of graph.nodes) {
      if (isTaskNode(node)) {
        const finalId = `${idPrefix}${node.id}`;
        mapping.set(node.id, finalId);
        const attributes: Record<string, GraphAttributeValue> = { kind: "task" };
        if (node.attributes) {
          for (const [key, value] of Object.entries(node.attributes)) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ) {
              attributes[key] = value;
            }
          }
        }
        // Recreate the task node descriptor manually so we can elide optional
        // fields (such as `label`) when upstream definitions omit them.
        const record: GraphNodeRecord = {
          id: finalId,
          attributes,
        };
        if (node.label !== undefined) {
          record.label = node.label;
        }
        addNode(record);
      } else {
        const embedded = extractEmbeddedGraph(node);
        if (!embedded) {
          throw new Error(`Subgraph node ${node.id} does not have an embedded graph`);
        }
        const finalId = `${idPrefix}${node.id}`;
        const childMapping = flattenRecursive(embedded, finalId, localAncestors);
        const ports = extractSubgraphPorts(node);
        const inputs: Record<string, string> = {};
        for (const [port, target] of Object.entries(ports.inputs)) {
          const resolved = childMapping.get(target);
          if (!resolved) {
            throw new Error(`Input port ${port} on ${node.id} targets missing node ${target}`);
          }
          inputs[port] = resolved;
        }
        const outputs: Record<string, string> = {};
        for (const [port, target] of Object.entries(ports.outputs)) {
          const resolved = childMapping.get(target);
          if (!resolved) {
            throw new Error(`Output port ${port} on ${node.id} targets missing node ${target}`);
          }
          outputs[port] = resolved;
        }
        portBindings.set(node.id, { inputs, outputs });
      }
    }

    for (const edge of graph.edges) {
      const fromNode = graph.nodes.find((candidate) => candidate.id === edge.from.nodeId)!;
      const toNode = graph.nodes.find((candidate) => candidate.id === edge.to.nodeId)!;
      const fromPort = edge.from.port ?? DEFAULT_OUTPUT_PORT;
      const toPort = edge.to.port ?? DEFAULT_INPUT_PORT;
      const fromId = isTaskNode(fromNode)
        ? mapping.get(fromNode.id)
        : portBindings.get(fromNode.id)?.outputs[fromPort];
      if (!fromId) {
        throw new Error(`Unable to resolve source node for edge ${edge.id}`);
      }
      const toId = isTaskNode(toNode)
        ? mapping.get(toNode.id)
        : portBindings.get(toNode.id)?.inputs[toPort];
      if (!toId) {
        throw new Error(`Unable to resolve target node for edge ${edge.id}`);
      }
      const attributes: Record<string, GraphAttributeValue> = {
        ...(edge.attributes ?? {}),
        hierarchy_edge: edge.id,
        from_port: fromPort,
        to_port: toPort,
      };
      // Build the flattened edge lazily so the optional label is only exposed
      // when callers actually provided one on the hierarchical edge.
      const record: GraphEdgeRecord = {
        from: fromId,
        to: toId,
        attributes,
      };
      if (edge.label !== undefined) {
        record.label = edge.label;
      }
      edges.push(record);
    }

    return mapping;
  }

  flattenRecursive(hier, "", new Set<string>());

  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  return {
    name: hier.id,
    graphId: hier.id,
    graphVersion: 1,
    nodes,
    edges,
    metadata: { hierarchical: true },
  };
}
