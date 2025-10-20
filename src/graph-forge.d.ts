// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

declare module "graph-forge/dist/index.js" {
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
    /** Attribute describing the weight or custom cost dimension. */
    readonly attribute: string;
    /** Optional default applied when the attribute is missing on an edge. */
    readonly defaultValue?: number;
    /** Scaling factor applied to the computed weight. */
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

  /** Descriptor of a directed edge excluded from constrained searches. */
  export interface AvoidEdgeDescriptor {
    readonly from: string;
    readonly to: string;
  }

  /** Additional filters accepted by {@link constrainedShortestPath}. */
  export interface ConstrainedPathOptions {
    readonly weightAttribute?: string;
    readonly costFunction?: EdgeCostDescriptor | string | ((edge: GraphEdgeData, graph: GraphModel) => number);
    readonly avoidNodes?: Iterable<string>;
    readonly avoidEdges?: Iterable<AvoidEdgeDescriptor>;
    readonly maxCost?: number;
  }

  export type ConstrainedPathStatus =
    | "found"
    | "start_or_goal_excluded"
    | "unreachable"
    | "max_cost_exceeded";

  export interface ConstrainedPathResult {
    readonly status: ConstrainedPathStatus;
    readonly distance: number;
    readonly path: string[];
    readonly visitedOrder: string[];
    readonly filteredNodes: string[];
    readonly filteredEdges: AvoidEdgeDescriptor[];
    readonly violations: string[];
    readonly notes: string[];
  }

  export function constrainedShortestPath(
    graph: GraphModel,
    start: string,
    goal: string,
    options?: ConstrainedPathOptions,
  ): ConstrainedPathResult;
}

declare module "../graph-forge/dist/index.js" {
  export * from "graph-forge/dist/index.js";
}

declare module "../../graph-forge/dist/index.js" {
  export * from "graph-forge/dist/index.js";
}

declare module "graph-forge/src/index.ts" {
  export * from "graph-forge/dist/index.js";
}

declare module "../graph-forge/src/index.ts" {
  export * from "graph-forge/dist/index.js";
}

declare module "../../graph-forge/src/index.ts" {
  export * from "graph-forge/dist/index.js";
}
