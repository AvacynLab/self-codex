import { buildEdgeCostEvaluator, } from "./dijkstra.js";
/** Lightweight binary heap used to implement the priority queue. */
class MinHeap {
    data = [];
    enqueue(entry) {
        this.data.push(entry);
        this.bubbleUp(this.data.length - 1);
    }
    dequeue() {
        if (this.data.length === 0) {
            return undefined;
        }
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            this.bubbleDown(0);
        }
        return top;
    }
    isEmpty() {
        return this.data.length === 0;
    }
    bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.data[parent].priority <= this.data[index].priority) {
                return;
            }
            [this.data[parent], this.data[index]] = [this.data[index], this.data[parent]];
            index = parent;
        }
    }
    bubbleDown(index) {
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
                return;
            }
            [this.data[index], this.data[smallest]] = [this.data[smallest], this.data[index]];
            index = smallest;
        }
    }
}
function buildAvoidEdgeKey(edge) {
    return `${edge.from}->${edge.to}`;
}
/**
 * Computes a constrained shortest path between `start` and `goal` using a
 * Dijkstra exploration. Nodes and edges listed in the exclusion sets are
 * ignored and an optional cost budget can flag solutions that exceed the
 * caller expectations.
 */
export function constrainedShortestPath(graph, start, goal, options = {}) {
    if (!graph.getNode(start)) {
        throw new Error(`Unknown start node '${start}'`);
    }
    if (!graph.getNode(goal)) {
        throw new Error(`Unknown goal node '${goal}'`);
    }
    const avoidNodes = new Set(options.avoidNodes ?? []);
    const avoidEdges = new Set();
    if (options.avoidEdges) {
        for (const edge of options.avoidEdges) {
            avoidEdges.add(buildAvoidEdgeKey(edge));
        }
    }
    const filteredNodes = graph
        .listNodes()
        .filter((node) => avoidNodes.has(node.id))
        .map((node) => node.id);
    const filteredEdges = dedupeEdges(graph
        .listEdges()
        .filter((edge) => avoidNodes.has(edge.from) || avoidNodes.has(edge.to) || avoidEdges.has(buildAvoidEdgeKey(edge)))
        .map((edge) => ({ from: edge.from, to: edge.to })));
    const violations = [];
    if (avoidNodes.has(start)) {
        violations.push(`start node '${start}' is excluded by avoid_nodes`);
    }
    if (avoidNodes.has(goal)) {
        violations.push(`goal node '${goal}' is excluded by avoid_nodes`);
    }
    const notes = [];
    if (filteredNodes.length > 0 || filteredEdges.length > 0) {
        notes.push("constraints_pruned_graph");
    }
    if (violations.length > 0) {
        return {
            status: "start_or_goal_excluded",
            distance: Number.POSITIVE_INFINITY,
            path: [],
            visitedOrder: [],
            filteredNodes,
            filteredEdges,
            violations,
            notes: dedupeNotes([...notes, "start_or_goal_excluded"]),
        };
    }
    const weightAttribute = options.weightAttribute ?? "weight";
    const costInput = options.costFunction;
    const computeCost = buildEdgeCostEvaluator(graph, weightAttribute, costInput);
    const distances = new Map();
    const previous = new Map();
    const visitedOrder = [];
    const visited = new Set();
    for (const node of graph.listNodes()) {
        distances.set(node.id, Number.POSITIVE_INFINITY);
        previous.set(node.id, null);
    }
    distances.set(start, 0);
    const queue = new MinHeap();
    queue.enqueue({ node: start, priority: 0 });
    while (!queue.isEmpty()) {
        const current = queue.dequeue();
        if (visited.has(current.node)) {
            continue;
        }
        if (avoidNodes.has(current.node)) {
            continue;
        }
        visited.add(current.node);
        visitedOrder.push(current.node);
        if (current.node === goal) {
            break;
        }
        for (const edge of graph.getOutgoing(current.node)) {
            if (avoidNodes.has(edge.to) || avoidNodes.has(edge.from)) {
                continue;
            }
            if (avoidEdges.has(buildAvoidEdgeKey(edge))) {
                continue;
            }
            const base = distances.get(current.node) ?? Number.POSITIVE_INFINITY;
            if (!Number.isFinite(base)) {
                continue;
            }
            const weight = computeCost(edge, graph);
            const tentative = base + weight;
            if (tentative < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
                distances.set(edge.to, tentative);
                previous.set(edge.to, current.node);
                queue.enqueue({ node: edge.to, priority: tentative });
            }
        }
    }
    const rawDistance = distances.get(goal) ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(rawDistance)) {
        return {
            status: "unreachable",
            distance: Number.POSITIVE_INFINITY,
            path: [],
            visitedOrder,
            filteredNodes,
            filteredEdges,
            violations,
            notes,
        };
    }
    const path = [];
    let cursor = goal;
    while (cursor) {
        path.unshift(cursor);
        cursor = previous.get(cursor) ?? null;
    }
    const distance = Number(rawDistance.toFixed(6));
    if (typeof options.maxCost === "number" && distance > options.maxCost) {
        return {
            status: "max_cost_exceeded",
            distance,
            path,
            visitedOrder,
            filteredNodes,
            filteredEdges,
            violations: [...violations, `path cost ${distance} exceeds max_cost ${options.maxCost}`],
            notes: dedupeNotes([...notes, "cost_budget_exceeded"]),
        };
    }
    return {
        status: "found",
        distance,
        path,
        visitedOrder,
        filteredNodes,
        filteredEdges,
        violations,
        notes,
    };
}
function dedupeEdges(edges) {
    const seen = new Set();
    const result = [];
    for (const edge of edges) {
        const key = buildAvoidEdgeKey(edge);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(edge);
    }
    return result;
}
function dedupeNotes(notes) {
    const seen = new Set();
    const result = [];
    for (const note of notes) {
        if (seen.has(note)) {
            continue;
        }
        seen.add(note);
        result.push(note);
    }
    return result;
}
