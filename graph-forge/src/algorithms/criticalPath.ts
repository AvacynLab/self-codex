import { AttributeValue, GraphModel } from "../model.js";

export interface CriticalPathOptions {
  readonly weightAttribute?: string;
}

export interface CriticalPathEntry {
  readonly node: string;
  readonly start: number;
  readonly finish: number;
}

export interface CriticalPathResult {
  readonly length: number;
  readonly path: string[];
  readonly schedule: CriticalPathEntry[];
  readonly topologicalOrder: string[];
}

export function criticalPath(graph: GraphModel, options: CriticalPathOptions = {}): CriticalPathResult {
  const weightKey = options.weightAttribute ?? "weight";
  const nodes = graph.listNodes();
  if (nodes.length === 0) {
    return { length: 0, path: [], schedule: [], topologicalOrder: [] };
  }

  const indegree = new Map<string, number>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
  }
  for (const edge of graph.listEdges()) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [node, degree] of indegree) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  const topo: string[] = [];
  const indegreeCopy = new Map(indegree);
  while (queue.length > 0) {
    const current = queue.shift()!;
    topo.push(current);
    for (const edge of graph.getOutgoing(current)) {
      const updated = (indegreeCopy.get(edge.to) ?? 0) - 1;
      indegreeCopy.set(edge.to, updated);
      if (updated === 0) {
        queue.push(edge.to);
      }
    }
  }

  if (topo.length !== nodes.length) {
    throw new Error("Critical path analysis requires a DAG; detected at least one cycle");
  }

  const distance = new Map<string, number>();
  const predecessor = new Map<string, string | null>();
  const startTime = new Map<string, number>();
  const finishTime = new Map<string, number>();

  for (const node of topo) {
    if ((indegree.get(node) ?? 0) === 0) {
      distance.set(node, 0);
      startTime.set(node, 0);
      finishTime.set(node, 0);
      predecessor.set(node, null);
    } else {
      distance.set(node, Number.NEGATIVE_INFINITY);
      startTime.set(node, Number.NEGATIVE_INFINITY);
      finishTime.set(node, Number.NEGATIVE_INFINITY);
      predecessor.set(node, null);
    }
  }

  for (const node of topo) {
    const currentDistance = distance.get(node) ?? Number.NEGATIVE_INFINITY;
    for (const edge of graph.getOutgoing(node)) {
      const weight = resolveDuration(edge.attributes[weightKey]);
      const candidate = currentDistance + weight;
      if (candidate > (distance.get(edge.to) ?? Number.NEGATIVE_INFINITY)) {
        distance.set(edge.to, candidate);
        predecessor.set(edge.to, node);
        startTime.set(edge.to, currentDistance);
        finishTime.set(edge.to, candidate);
      }
    }
  }

  let endNode = topo[0];
  let maxDistance = distance.get(endNode) ?? Number.NEGATIVE_INFINITY;
  for (const node of topo) {
    const dist = distance.get(node) ?? Number.NEGATIVE_INFINITY;
    if (dist > maxDistance) {
      maxDistance = dist;
      endNode = node;
    }
  }

  if (!Number.isFinite(maxDistance)) {
    return { length: 0, path: [], schedule: [], topologicalOrder: topo };
  }

  const path: string[] = [];
  let current: string | null = endNode;
  while (current) {
    path.unshift(current);
    current = predecessor.get(current) ?? null;
  }

  const schedule: CriticalPathEntry[] = [];
  for (const node of path) {
    schedule.push({
      node,
      start: startTime.get(node) ?? 0,
      finish: finishTime.get(node) ?? 0
    });
  }

  return { length: maxDistance, path, schedule, topologicalOrder: topo };
}

function resolveDuration(value: AttributeValue | undefined): number {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  throw new Error(`Edge duration must be numeric but received '${String(value)}'`);
}
