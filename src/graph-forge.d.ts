declare module "../graph-forge/dist/model.js" {
  export type AttributeValue = string | number | boolean;
  export interface GraphNodeData { id: string; attributes: Record<string, AttributeValue>; }
  export interface GraphEdgeData { from: string; to: string; attributes: Record<string, AttributeValue>; }
  export class GraphModel {
    readonly name: string;
    readonly nodes: Map<string, GraphNodeData>;
    readonly edges: GraphEdgeData[];
    readonly directives: Map<string, AttributeValue>;
    constructor(name: string, nodes: GraphNodeData[], edges: GraphEdgeData[], directives: Map<string, AttributeValue>);
    listNodes(): GraphNodeData[];
    listEdges(): GraphEdgeData[];
  }
}
