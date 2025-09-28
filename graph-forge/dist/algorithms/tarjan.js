export function tarjanScc(graph) {
    let index = 0;
    const stack = [];
    const onStack = new Set();
    const indices = new Map();
    const lowlinks = new Map();
    const components = [];
    const visit = (nodeId) => {
        indices.set(nodeId, index);
        lowlinks.set(nodeId, index);
        index++;
        stack.push(nodeId);
        onStack.add(nodeId);
        for (const edge of graph.getOutgoing(nodeId)) {
            const neighbor = edge.to;
            if (!indices.has(neighbor)) {
                visit(neighbor);
                lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId), lowlinks.get(neighbor)));
            }
            else if (onStack.has(neighbor)) {
                lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId), indices.get(neighbor)));
            }
        }
        if (lowlinks.get(nodeId) === indices.get(nodeId)) {
            const component = [];
            while (true) {
                const candidate = stack.pop();
                if (!candidate) {
                    break;
                }
                onStack.delete(candidate);
                component.push(candidate);
                if (candidate === nodeId) {
                    break;
                }
            }
            components.push(component);
        }
    };
    for (const node of graph.listNodes()) {
        if (!indices.has(node.id)) {
            visit(node.id);
        }
    }
    return components;
}
