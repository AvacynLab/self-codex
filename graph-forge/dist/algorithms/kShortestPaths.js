import { GraphModel } from "../model.js";
import { buildEdgeCostEvaluator, shortestPath } from "./dijkstra.js";
/**
 * Computes the `k` shortest simple paths between two nodes using Yen's
 * algorithm.
 */
export function kShortestPaths(graph, start, goal, k, options = {}) {
    if (k <= 0) {
        throw new Error("k must be greater than zero");
    }
    const weightKey = options.weightAttribute ?? "weight";
    const evaluator = buildEdgeCostEvaluator(graph, weightKey, options.costFunction);
    const initial = shortestPath(graph, start, goal, { weightAttribute: weightKey, costFunction: evaluator });
    if (!initial.path.length) {
        return [];
    }
    const results = [initial];
    const candidates = [];
    for (let index = 1; index < k; index += 1) {
        const lastPath = results[index - 1];
        for (let spurIndex = 0; spurIndex < lastPath.path.length - 1; spurIndex += 1) {
            const spurNode = lastPath.path[spurIndex];
            const rootPath = lastPath.path.slice(0, spurIndex + 1);
            const removedEdges = [];
            for (const path of results) {
                if (arraysEqual(path.path.slice(0, spurIndex + 1), rootPath)) {
                    const edge = getEdge(graph, path.path[spurIndex], path.path[spurIndex + 1]);
                    if (edge) {
                        removedEdges.push(edge);
                    }
                }
            }
            const pruned = pruneEdges(graph, removedEdges);
            const spurPath = shortestPath(pruned, spurNode, goal, {
                weightAttribute: weightKey,
                costFunction: (edge, model) => evaluator(edge, model)
            });
            if (!spurPath.path.length) {
                continue;
            }
            const totalPath = rootPath.slice(0, -1).concat(spurPath.path);
            if (hasPath(results, totalPath) || hasCandidate(candidates, totalPath)) {
                continue;
            }
            const cost = computeCost(graph, totalPath, evaluator);
            candidates.push({ path: totalPath, cost });
        }
        if (!candidates.length) {
            break;
        }
        candidates.sort((a, b) => a.cost - b.cost);
        const best = candidates.shift();
        results.push({ distance: best.cost, path: best.path, visitedOrder: [] });
    }
    const deviation = options.maxDeviation ?? Number.POSITIVE_INFINITY;
    if (Number.isFinite(deviation)) {
        const baseline = results[0]?.distance ?? 0;
        return results.filter((path) => path.distance - baseline <= deviation);
    }
    return results;
}
function pruneEdges(graph, edges) {
    if (!edges.length) {
        return graph;
    }
    const removed = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));
    const filtered = graph.listEdges().filter((edge) => !removed.has(`${edge.from}->${edge.to}`));
    return new GraphModel(graph.name, graph.listNodes(), filtered, new Map(graph.directives));
}
function getEdge(graph, from, to) {
    return graph.getOutgoing(from).find((edge) => edge.to === to);
}
function computeCost(graph, path, evaluator) {
    let total = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
        const edge = getEdge(graph, path[i], path[i + 1]);
        if (!edge) {
            return Number.POSITIVE_INFINITY;
        }
        total += evaluator(edge, graph);
    }
    return total;
}
function arraysEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
function hasPath(collection, candidate) {
    return collection.some((entry) => arraysEqual(entry.path, candidate));
}
function hasCandidate(collection, candidate) {
    return collection.some((entry) => arraysEqual(entry.path, candidate));
}
