import { buildEdgeCostEvaluator, } from "./dijkstra.js";
/**
 * Compute the betweenness centrality for every node using Brandes' algorithm.
 * The implementation supports both unweighted and weighted graphs with
 * non-negative edge costs.
 */
export function betweennessCentrality(graph, options = {}) {
    const nodes = graph.listNodes();
    const nodeIds = nodes.map((node) => node.id);
    const scores = new Map();
    for (const id of nodeIds) {
        scores.set(id, 0);
    }
    const useWeights = options.weighted === true;
    const weightKey = options.weightAttribute ?? "weight";
    const evaluator = useWeights ? buildEdgeCostEvaluator(graph, weightKey, options.costFunction) : null;
    for (const source of nodeIds) {
        const stack = [];
        const predecessors = new Map();
        const sigma = new Map();
        const distance = new Map();
        for (const id of nodeIds) {
            predecessors.set(id, []);
            sigma.set(id, 0);
            distance.set(id, Number.POSITIVE_INFINITY);
        }
        sigma.set(source, 1);
        distance.set(source, 0);
        if (useWeights) {
            runWeightedSearch(graph, source, evaluator, stack, predecessors, sigma, distance);
        }
        else {
            runUnweightedSearch(graph, source, stack, predecessors, sigma, distance);
        }
        const delta = new Map();
        for (const id of nodeIds) {
            delta.set(id, 0);
        }
        while (stack.length) {
            const w = stack.pop();
            const wSigma = sigma.get(w);
            for (const v of predecessors.get(w) ?? []) {
                const share = (sigma.get(v) / wSigma) * (1 + (delta.get(w) ?? 0));
                delta.set(v, (delta.get(v) ?? 0) + share);
            }
            if (w !== source) {
                scores.set(w, (scores.get(w) ?? 0) + (delta.get(w) ?? 0));
            }
        }
    }
    if (options.normalise) {
        const n = nodeIds.length;
        if (n > 2) {
            const factor = 1 / ((n - 1) * (n - 2));
            for (const id of nodeIds) {
                scores.set(id, (scores.get(id) ?? 0) * factor);
            }
        }
    }
    return nodeIds.map((id) => ({ node: id, score: scores.get(id) ?? 0 }));
}
function runUnweightedSearch(graph, source, stack, predecessors, sigma, distance) {
    const queue = [];
    queue.push(source);
    while (queue.length) {
        const v = queue.shift();
        stack.push(v);
        for (const edge of graph.getOutgoing(v)) {
            const nextDistance = distance.get(v) + 1;
            const currentDistance = distance.get(edge.to);
            if (nextDistance < currentDistance) {
                distance.set(edge.to, nextDistance);
                queue.push(edge.to);
                sigma.set(edge.to, sigma.get(v));
                predecessors.set(edge.to, [v]);
            }
            else if (nextDistance === currentDistance) {
                sigma.set(edge.to, (sigma.get(edge.to) ?? 0) + (sigma.get(v) ?? 0));
                const existing = predecessors.get(edge.to);
                if (!existing.includes(v)) {
                    existing.push(v);
                }
            }
        }
    }
}
function runWeightedSearch(graph, source, evaluator, stack, predecessors, sigma, distance) {
    const queue = [];
    queue.push({ node: source, priority: 0 });
    while (queue.length) {
        queue.sort((a, b) => a.priority - b.priority);
        const current = queue.shift();
        const v = current.node;
        if ((distance.get(v) ?? Number.POSITIVE_INFINITY) < current.priority) {
            continue;
        }
        stack.push(v);
        for (const edge of graph.getOutgoing(v)) {
            const weight = evaluator(edge, graph);
            if (!Number.isFinite(weight) || weight < 0) {
                throw new Error("Betweenness centrality requires non-negative edge weights");
            }
            const tentative = (distance.get(v) ?? Number.POSITIVE_INFINITY) + weight;
            const targetDistance = distance.get(edge.to);
            const epsilon = 1e-9;
            if (tentative + epsilon < targetDistance) {
                distance.set(edge.to, tentative);
                queue.push({ node: edge.to, priority: tentative });
                sigma.set(edge.to, sigma.get(v));
                predecessors.set(edge.to, [v]);
            }
            else if (Math.abs(tentative - targetDistance) <= epsilon) {
                sigma.set(edge.to, (sigma.get(edge.to) ?? 0) + (sigma.get(v) ?? 0));
                const existing = predecessors.get(edge.to);
                if (!existing.includes(v)) {
                    existing.push(v);
                }
            }
        }
    }
}
//# sourceMappingURL=brandes.js.map