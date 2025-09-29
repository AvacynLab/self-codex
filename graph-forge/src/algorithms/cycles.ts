import { GraphModel } from "../model.js";

export interface CycleDetectionResult {
  readonly hasCycle: boolean;
  readonly cycles: string[][];
}

/**
 * Detects directed cycles within the graph using depth-first search.
 */
export function detectCycles(graph: GraphModel, limit = 20): CycleDetectionResult {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (nodeId: string): void => {
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const edge of graph.getOutgoing(nodeId)) {
      if (cycles.length >= limit) {
        break;
      }
      if (visiting.has(edge.to)) {
        const start = stack.indexOf(edge.to);
        cycles.push(stack.slice(start).concat(edge.to));
        continue;
      }
      if (!visited.has(edge.to)) {
        visit(edge.to);
      }
      if (cycles.length >= limit) {
        break;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    stack.pop();
  };

  for (const node of graph.listNodes()) {
    if (cycles.length >= limit) {
      break;
    }
    if (!visited.has(node.id)) {
      visit(node.id);
    }
  }

  return { hasCycle: cycles.length > 0, cycles };
}
