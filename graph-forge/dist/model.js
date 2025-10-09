export class GraphModel {
    name;
    nodes;
    edges;
    directives;
    adjacency;
    constructor(name, nodes, edges, directives) {
        this.name = name;
        this.nodes = new Map(nodes.map((node) => [node.id, node]));
        this.edges = edges;
        this.directives = directives;
        this.adjacency = new Map();
        for (const node of nodes) {
            this.adjacency.set(node.id, []);
        }
        for (const edge of edges) {
            if (!this.adjacency.has(edge.from)) {
                this.adjacency.set(edge.from, []);
            }
            this.adjacency.get(edge.from).push(edge);
        }
    }
    getNode(id) {
        return this.nodes.get(id);
    }
    getOutgoing(id) {
        return this.adjacency.get(id) ?? [];
    }
    listNodes() {
        return Array.from(this.nodes.values());
    }
    listEdges() {
        return [...this.edges];
    }
    getDirective(name) {
        return this.directives.get(name);
    }
}
//# sourceMappingURL=model.js.map