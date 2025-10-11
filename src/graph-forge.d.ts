// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
declare module "../graph-forge/dist/index.js" {
  export interface GraphNodeData {
    readonly id: string;
    readonly attributes: Record<string, string | number | boolean>;
  }

  export interface GraphEdgeData {
    readonly from: string;
    readonly to: string;
    readonly attributes: Record<string, string | number | boolean>;
  }

  export interface EdgeCostDescriptor {
    readonly attribute: string;
    readonly defaultValue?: number;
    readonly scale?: number;
  }

  export class GraphModel {
    constructor(
      name: string,
      nodes: GraphNodeData[],
      edges: GraphEdgeData[],
      directives: Map<string, string | number | boolean>,
    );
    listNodes(): GraphNodeData[];
    listEdges(): GraphEdgeData[];
    getNode(id: string): GraphNodeData | undefined;
    getOutgoing(id: string): GraphEdgeData[];
  }

  export function kShortestPaths(
    graph: GraphModel,
    start: string,
    goal: string,
    k: number,
    options?: {
      readonly weightAttribute?: string;
      readonly costFunction?: EdgeCostDescriptor | string | ((edge: GraphEdgeData, graph: GraphModel) => number);
      readonly maxDeviation?: number;
    },
  ): Array<{ distance: number; path: string[]; visitedOrder: string[] }>;

  export function shortestPath(
    graph: GraphModel,
    start: string,
    goal: string,
    options?: {
      readonly weightAttribute?: string;
      readonly costFunction?: EdgeCostDescriptor | string | ((edge: GraphEdgeData, graph: GraphModel) => number);
    },
  ): { distance: number; path: string[]; visitedOrder: string[] };

  export function betweennessCentrality(
    graph: GraphModel,
    options?: {
      readonly weighted?: boolean;
      readonly weightAttribute?: string;
      readonly costFunction?: EdgeCostDescriptor | string | ((edge: GraphEdgeData, graph: GraphModel) => number);
      readonly normalise?: boolean;
    },
  ): Array<{ node: string; score: number }>;
}
