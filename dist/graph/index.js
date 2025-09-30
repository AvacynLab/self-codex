function pushSorted(map, key, value) {
    const list = map.get(key);
    if (list) {
        list.push(value);
        list.sort();
    }
    else {
        map.set(key, [value]);
    }
}
function addNodeAttribute(index, nodeId, key, value) {
    let valueMap = index.get(key);
    if (!valueMap) {
        valueMap = new Map();
        index.set(key, valueMap);
    }
    const bucket = valueMap.get(value);
    if (bucket) {
        bucket.push(nodeId);
        bucket.sort();
    }
    else {
        valueMap.set(value, [nodeId]);
    }
}
function addEdgeAttribute(index, edge, key, value) {
    let valueMap = index.get(key);
    if (!valueMap) {
        valueMap = new Map();
        index.set(key, valueMap);
    }
    const bucket = valueMap.get(value);
    if (bucket) {
        bucket.push(edge);
    }
    else {
        valueMap.set(value, [edge]);
    }
}
function buildUndirectedAdjacency(adjacency) {
    const undirected = new Map();
    for (const [from, neighbours] of adjacency.entries()) {
        if (!undirected.has(from)) {
            undirected.set(from, []);
        }
        for (const neighbour of neighbours) {
            if (!undirected.has(neighbour)) {
                undirected.set(neighbour, []);
            }
            undirected.get(from).push(neighbour);
            undirected.get(neighbour).push(from);
        }
    }
    for (const list of undirected.values()) {
        list.sort();
    }
    return undirected;
}
function computeComponents(graph, undirected) {
    const remaining = new Set(graph.nodes.map((node) => node.id));
    const components = [];
    while (remaining.size > 0) {
        const [start] = remaining;
        const queue = [start];
        const component = [];
        while (queue.length > 0) {
            const node = queue.shift();
            if (!remaining.delete(node)) {
                continue;
            }
            component.push(node);
            for (const neighbour of undirected.get(node) ?? []) {
                if (remaining.has(neighbour) && !queue.includes(neighbour)) {
                    queue.push(neighbour);
                }
            }
        }
        component.sort();
        components.push(component);
    }
    return components;
}
function computeDegreeSummary(nodes, indegree, outdegree) {
    if (nodes.length === 0) {
        return { averageIn: 0, averageOut: 0, minIn: 0, maxIn: 0, minOut: 0, maxOut: 0 };
    }
    let totalIn = 0;
    let totalOut = 0;
    let minIn = Number.POSITIVE_INFINITY;
    let maxIn = Number.NEGATIVE_INFINITY;
    let minOut = Number.POSITIVE_INFINITY;
    let maxOut = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
        const inValue = indegree.get(node) ?? 0;
        const outValue = outdegree.get(node) ?? 0;
        totalIn += inValue;
        totalOut += outValue;
        if (inValue < minIn)
            minIn = inValue;
        if (inValue > maxIn)
            maxIn = inValue;
        if (outValue < minOut)
            minOut = outValue;
        if (outValue > maxOut)
            maxOut = outValue;
    }
    return {
        averageIn: Number((totalIn / nodes.length).toFixed(4)),
        averageOut: Number((totalOut / nodes.length).toFixed(4)),
        minIn: minIn === Number.POSITIVE_INFINITY ? 0 : minIn,
        maxIn: maxIn === Number.NEGATIVE_INFINITY ? 0 : maxIn,
        minOut: minOut === Number.POSITIVE_INFINITY ? 0 : minOut,
        maxOut: maxOut === Number.NEGATIVE_INFINITY ? 0 : maxOut,
    };
}
/**
 * Builds a set of indexes (attributes, degrees, components) used by the graph
 * tooling for reporting, partitioning, and cache invalidation.
 */
export function buildGraphAttributeIndex(graph) {
    const nodesByAttribute = new Map();
    const edgesByAttribute = new Map();
    const indegree = new Map();
    const outdegree = new Map();
    const adjacency = new Map();
    for (const node of graph.nodes) {
        indegree.set(node.id, 0);
        outdegree.set(node.id, 0);
        adjacency.set(node.id, []);
        for (const [key, value] of Object.entries(node.attributes)) {
            addNodeAttribute(nodesByAttribute, node.id, key, value);
        }
    }
    for (const edge of graph.edges) {
        const neighbours = adjacency.get(edge.from);
        if (neighbours) {
            neighbours.push(edge.to);
        }
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
        outdegree.set(edge.from, (outdegree.get(edge.from) ?? 0) + 1);
        for (const [key, value] of Object.entries(edge.attributes)) {
            addEdgeAttribute(edgesByAttribute, { from: edge.from, to: edge.to }, key, value);
        }
    }
    for (const neighbours of adjacency.values()) {
        neighbours.sort();
    }
    const undirectedAdjacency = buildUndirectedAdjacency(adjacency);
    const entrypoints = graph.nodes
        .filter((node) => (indegree.get(node.id) ?? 0) === 0)
        .map((node) => node.id)
        .sort();
    const sinks = graph.nodes
        .filter((node) => (outdegree.get(node.id) ?? 0) === 0)
        .map((node) => node.id)
        .sort();
    const isolated = graph.nodes
        .filter((node) => (indegree.get(node.id) ?? 0) === 0 && (outdegree.get(node.id) ?? 0) === 0)
        .map((node) => node.id)
        .sort();
    const combinedDegrees = graph.nodes.map((node) => ({
        id: node.id,
        degree: (indegree.get(node.id) ?? 0) + (outdegree.get(node.id) ?? 0),
    }));
    combinedDegrees.sort((a, b) => (b.degree - a.degree) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const hubs = combinedDegrees.slice(0, Math.min(5, combinedDegrees.length)).map((entry) => entry.id);
    const components = computeComponents(graph, undirectedAdjacency);
    const degreeSummary = computeDegreeSummary(graph.nodes.map((node) => node.id), indegree, outdegree);
    return {
        nodesByAttribute,
        edgesByAttribute,
        indegree,
        outdegree,
        adjacency,
        undirectedAdjacency,
        entrypoints,
        sinks,
        isolated,
        hubs,
        components,
        degreeSummary,
    };
}
