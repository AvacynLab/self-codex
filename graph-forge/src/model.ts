export type AttributeValue = string | number | boolean;

export interface GraphNodeData {
  readonly id: string;
  readonly attributes: Record<string, AttributeValue>;
}

export interface GraphEdgeData {
  readonly from: string;
  readonly to: string;
  readonly attributes: Record<string, AttributeValue>;
}

export class GraphModel {
  readonly nodes: Map<string, GraphNodeData>;
  readonly edges: GraphEdgeData[];
  readonly directives: Map<string, AttributeValue>;
  private readonly adjacency: Map<string, GraphEdgeData[]>;

  constructor(
    readonly name: string,
    nodes: GraphNodeData[],
    edges: GraphEdgeData[],
    directives: Map<string, AttributeValue>
  ) {
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
      this.adjacency.get(edge.from)!.push(edge);
    }
  }

  getNode(id: string): GraphNodeData | undefined {
    return this.nodes.get(id);
  }

  getOutgoing(id: string): GraphEdgeData[] {
    return this.adjacency.get(id) ?? [];
  }

  listNodes(): GraphNodeData[] {
    return Array.from(this.nodes.values());
  }

  listEdges(): GraphEdgeData[] {
    return [...this.edges];
  }

  getDirective(name: string): AttributeValue | undefined {
    return this.directives.get(name);
  }
}
