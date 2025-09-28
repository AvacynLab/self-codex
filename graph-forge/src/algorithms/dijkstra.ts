import { AttributeValue, GraphModel } from "../model.js";

export interface DijkstraOptions {
  readonly weightAttribute?: string;
}

export interface DijkstraResult {
  readonly distance: number;
  readonly path: string[];
  readonly visitedOrder: string[];
}

interface QueueEntry {
  node: string;
  priority: number;
}

class MinHeap {
  private readonly data: QueueEntry[] = [];

  enqueue(entry: QueueEntry): void {
    this.data.push(entry);
    this.bubbleUp(this.data.length - 1);
  }

  dequeue(): QueueEntry | undefined {
    if (this.data.length === 0) {
      return undefined;
    }
    const min = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.bubbleDown(0);
    }
    return min;
  }

  isEmpty(): boolean {
    return this.data.length === 0;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.data[parent].priority <= this.data[index].priority) {
        break;
      }
      [this.data[parent], this.data[index]] = [this.data[index], this.data[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.data.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.data[left].priority < this.data[smallest].priority) {
        smallest = left;
      }
      if (right < length && this.data[right].priority < this.data[smallest].priority) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }
      [this.data[index], this.data[smallest]] = [this.data[smallest], this.data[index]];
      index = smallest;
    }
  }
}

export function shortestPath(graph: GraphModel, start: string, goal: string, options: DijkstraOptions = {}): DijkstraResult {
  if (!graph.getNode(start)) {
    throw new Error(`Unknown start node '${start}'`);
  }
  if (!graph.getNode(goal)) {
    throw new Error(`Unknown goal node '${goal}'`);
  }

  const weightKey = options.weightAttribute ?? "weight";
  const distances = new Map<string, number>();
  const previous = new Map<string, string | null>();
  const visitedOrder: string[] = [];
  const visitedSet = new Set<string>();

  for (const node of graph.listNodes()) {
    distances.set(node.id, Number.POSITIVE_INFINITY);
    previous.set(node.id, null);
  }
  distances.set(start, 0);

  const queue = new MinHeap();
  queue.enqueue({ node: start, priority: 0 });

  while (!queue.isEmpty()) {
    const current = queue.dequeue()!;
    if (visitedSet.has(current.node)) {
      continue;
    }
    visitedSet.add(current.node);
    visitedOrder.push(current.node);

    if (current.node === goal) {
      break;
    }

    for (const edge of graph.getOutgoing(current.node)) {
      const weight = resolveWeight(edge.attributes[weightKey]);
      const base = distances.get(current.node) ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(base)) {
        continue;
      }
      const tentative = base + weight;
      if (tentative < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, tentative);
        previous.set(edge.to, current.node);
        queue.enqueue({ node: edge.to, priority: tentative });
      }
    }
  }

  const distance = distances.get(goal) ?? Number.POSITIVE_INFINITY;
  if (!isFinite(distance)) {
    return { distance: Number.POSITIVE_INFINITY, path: [], visitedOrder };
  }

  const path: string[] = [];
  let current: string | null = goal;
  while (current) {
    path.unshift(current);
    current = previous.get(current) ?? null;
  }

  return { distance, path, visitedOrder };
}

function resolveWeight(value: AttributeValue | undefined): number {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value === "number") {
    if (value < 0) {
      throw new Error("Dijkstra cannot handle negative weights");
    }
    return value;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  throw new Error(`Edge weight must be a non-negative number but received '${String(value)}'`);
}
