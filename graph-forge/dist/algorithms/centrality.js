import { buildEdgeCostEvaluator } from "./dijkstra.js";
/**
 * Computes the in/out degree for every node.
 */
export function degreeCentrality(graph) {
    const incoming = new Map();
    const outgoing = new Map();
    for (const node of graph.listNodes()) {
        incoming.set(node.id, 0);
        outgoing.set(node.id, 0);
    }
    for (const edge of graph.listEdges()) {
        outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
    return graph.listNodes().map((node) => {
        const inDegree = incoming.get(node.id) ?? 0;
        const outDegree = outgoing.get(node.id) ?? 0;
        return {
            node: node.id,
            inDegree,
            outDegree,
            total: inDegree + outDegree
        };
    });
}
/**
 * Computes the closeness centrality using weighted shortest paths.
 */
export function closenessCentrality(graph, options = {}) {
    const nodes = graph.listNodes();
    if (!nodes.length) {
        return [];
    }
    const weightKey = options.weightAttribute ?? "weight";
    const computeCost = buildEdgeCostEvaluator(graph, weightKey, options.costFunction);
    return nodes.map((node) => {
        const distances = singleSourceShortestPaths(graph, node.id, computeCost);
        let totalDistance = 0;
        let reachable = 0;
        for (const [target, distance] of distances.entries()) {
            if (target === node.id) {
                continue;
            }
            if (Number.isFinite(distance)) {
                totalDistance += distance;
                reachable += 1;
            }
        }
        const score = reachable > 0 && totalDistance > 0 ? reachable / totalDistance : 0;
        return { node: node.id, score, reachable };
    });
}
function singleSourceShortestPaths(graph, source, evaluator) {
    const distances = new Map();
    const visited = new Set();
    const queue = [];
    for (const node of graph.listNodes()) {
        distances.set(node.id, node.id === source ? 0 : Number.POSITIVE_INFINITY);
    }
    queue.push({ node: source, cost: 0 });
    while (queue.length) {
        queue.sort((a, b) => a.cost - b.cost);
        const current = queue.shift();
        if (visited.has(current.node)) {
            continue;
        }
        visited.add(current.node);
        for (const edge of graph.getOutgoing(current.node)) {
            const weight = evaluator(edge, graph);
            const nextCost = current.cost + weight;
            const existing = distances.get(edge.to) ?? Number.POSITIVE_INFINITY;
            if (nextCost < existing) {
                distances.set(edge.to, nextCost);
                queue.push({ node: edge.to, cost: nextCost });
            }
        }
    }
    return distances;
}
//# sourceMappingURL=centrality.js.map