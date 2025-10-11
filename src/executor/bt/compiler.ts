import { flatten, type HierGraph } from "../../graph/hierarchy.js";
import type { GraphNodeRecord } from "../../graph/types.js";
import {
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
  type BehaviorNodeDefinition,
  type CompiledBehaviorTree,
} from "./types.js";

/** Attribute name storing the tool executed by a Behaviour Tree task. */
const TOOL_ATTRIBUTE = "bt_tool";
/** Attribute name storing the runtime variable key bound to the task input. */
const INPUT_KEY_ATTRIBUTE = "bt_input_key";

/** Extract a string attribute or throw when the value is missing/invalid. */
function requireStringAttribute(node: GraphNodeRecord, key: string): string {
  const value = node.attributes[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Node ${node.id} is missing required attribute ${key}`);
  }
  return value;
}

/** Extract an optional string attribute returning undefined when absent. */
function optionalStringAttribute(node: GraphNodeRecord, key: string): string | undefined {
  const value = node.attributes[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Attribute ${key} on node ${node.id} must be a non-empty string`);
  }
  return value;
}

/**
 * Compile a hierarchical graph into a Behaviour Tree composed of sequence nodes
 * and task leaves. The compiler performs a topological sort of the flattened
 * graph to preserve dependencies between tasks.
 */
export function compileHierGraphToBehaviorTree(graph: HierGraph): CompiledBehaviorTree {
  const normalised = flatten(graph);
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const node of normalised.nodes) {
    adjacency.set(node.id, new Set());
    indegree.set(node.id, 0);
  }

  for (const edge of normalised.edges) {
    const from = adjacency.get(edge.from);
    const to = indegree.get(edge.to);
    if (!from || to === undefined) {
      throw new Error(`Invalid edge referencing missing nodes: ${edge.from} → ${edge.to}`);
    }
    if (!from.has(edge.to)) {
      from.add(edge.to);
      indegree.set(edge.to, to + 1);
    }
  }

  const ready: string[] = Array.from(indegree.entries())
    .filter(([, value]) => value === 0)
    .map(([nodeId]) => nodeId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ordered: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const neighbour of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(neighbour) ?? 0) - 1;
      indegree.set(neighbour, remaining);
      if (remaining === 0) {
        ready.push(neighbour);
      }
    }
    ready.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  if (ordered.length !== normalised.nodes.length) {
    throw new Error(`Hierarchical graph ${graph.id} contains cycles and cannot be compiled`);
  }

  const nodeById = new Map(normalised.nodes.map((node) => [node.id, node] as const));
  const tasks: BehaviorNodeDefinition[] = ordered.map((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} disappeared during compilation`);
    }
    const tool = requireStringAttribute(node, TOOL_ATTRIBUTE);
    const inputKey = optionalStringAttribute(node, INPUT_KEY_ATTRIBUTE);
    return {
      type: "task",
      id: node.id,
      node_id: node.id,
      tool,
      input_key: inputKey,
    } satisfies BehaviorNodeDefinition;
  });

  let root: BehaviorNodeDefinition;
  if (tasks.length === 1) {
    root = tasks[0];
  } else {
    root = {
      type: "sequence",
      id: `${graph.id}:sequence`,
      children: tasks,
    } satisfies BehaviorNodeDefinition;
  }

  return {
    id: graph.id,
    root,
  };
}
