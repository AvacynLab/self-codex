export class CycleDetectedError extends Error {
    cycle;
    constructor(message, cycle) {
        super(message);
        this.name = "CycleDetectedError";
        this.cycle = cycle;
    }
}
/**
 * Computes a topological ordering of the directed acyclic graph. The function
 * throws a {@link CycleDetectedError} when a cycle is detected.
 */
export function topologicalSort(graph) {
    const indegree = new Map();
    for (const node of graph.listNodes()) {
        indegree.set(node.id, 0);
    }
    for (const edge of graph.listEdges()) {
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const queue = [];
    for (const [id, degree] of indegree.entries()) {
        if (degree === 0) {
            queue.push(id);
        }
    }
    const order = [];
    const indegreeCopy = new Map(indegree);
    while (queue.length) {
        const current = queue.shift();
        order.push(current);
        for (const edge of graph.getOutgoing(current)) {
            const next = (indegreeCopy.get(edge.to) ?? 0) - 1;
            indegreeCopy.set(edge.to, next);
            if (next === 0) {
                queue.push(edge.to);
            }
        }
    }
    if (order.length !== graph.listNodes().length) {
        const cycle = detectCycle(graph);
        throw new CycleDetectedError("Topological sort requires an acyclic graph", cycle ?? []);
    }
    return order;
}
function detectCycle(graph) {
    const visiting = new Set();
    const visited = new Set();
    const stack = [];
    const visit = (nodeId) => {
        visiting.add(nodeId);
        stack.push(nodeId);
        for (const edge of graph.getOutgoing(nodeId)) {
            if (!visited.has(edge.to)) {
                if (visiting.has(edge.to)) {
                    const cycleStart = stack.indexOf(edge.to);
                    return stack.slice(cycleStart).concat(edge.to);
                }
                const cycle = visit(edge.to);
                if (cycle) {
                    return cycle;
                }
            }
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        stack.pop();
        return null;
    };
    for (const node of graph.listNodes()) {
        if (!visited.has(node.id)) {
            const cycle = visit(node.id);
            if (cycle) {
                return cycle;
            }
        }
    }
    return null;
}
//# sourceMappingURL=topologicalSort.js.map