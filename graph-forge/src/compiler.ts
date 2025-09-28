import {
  AnalysisNode,
  AttributeNode,
  GraphFileNode,
  GraphNode,
  NodeDeclNode,
  EdgeDeclNode,
  ValueNode,
  parse
} from "./parser.js";
import { AttributeValue, GraphEdgeData, GraphModel, GraphNodeData } from "./model.js";

export interface CompileOptions {
  readonly entryGraph?: string;
}

export interface CompiledAnalysisArg {
  readonly value: AttributeValue;
  readonly tokenLine: number;
  readonly tokenColumn: number;
}

export interface CompiledAnalysis {
  readonly name: string;
  readonly tokenLine: number;
  readonly tokenColumn: number;
  readonly args: CompiledAnalysisArg[];
}

export interface CompiledGraph {
  readonly graph: GraphModel;
  readonly analyses: CompiledAnalysis[];
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export function compileSource(source: string, options: CompileOptions = {}): CompiledGraph {
  const ast = parse(source);
  return compileAst(ast, options);
}

export function compileAst(ast: GraphFileNode, options: CompileOptions = {}): CompiledGraph {
  if (ast.graphs.length === 0) {
    throw new CompileError("No graphs declared in source");
  }
  const target = options.entryGraph
    ? ast.graphs.find((graph) => graph.name === options.entryGraph)
    : ast.graphs[0];
  if (!target) {
    throw new CompileError(`Graph '${options.entryGraph}' not found`);
  }
  return compileGraphNode(target);
}

export function compileGraphNode(graph: GraphNode): CompiledGraph {
  const nodeMap = buildNodeMap(graph.nodes);
  const nodeData = graph.nodes.map((node) => toNodeData(node));
  const edgeData = graph.edges.map((edge) => toEdgeData(edge, nodeMap));
  const directives = buildDirectiveMap(graph);
  const analyses = graph.analyses.map((analysis) => toAnalysis(analysis));
  const model = new GraphModel(graph.name, nodeData, edgeData, directives);
  return { graph: model, analyses };
}

function buildNodeMap(nodes: NodeDeclNode[]): Map<string, NodeDeclNode> {
  const map = new Map<string, NodeDeclNode>();
  for (const node of nodes) {
    if (map.has(node.name)) {
      const prev = map.get(node.name)!;
      throw new CompileError(
        `Duplicate node '${node.name}' (line ${node.nameToken.line}, column ${node.nameToken.column}); previously defined at line ${prev.nameToken.line}`
      );
    }
    map.set(node.name, node);
  }
  return map;
}

function toNodeData(node: NodeDeclNode): GraphNodeData {
  return {
    id: node.name,
    attributes: foldAttributes(node.attributes)
  };
}

function toEdgeData(edge: EdgeDeclNode, nodeMap: Map<string, NodeDeclNode>): GraphEdgeData {
  if (!nodeMap.has(edge.from)) {
    throw new CompileError(
      `Edge references unknown source node '${edge.from}' (line ${edge.fromToken.line}, column ${edge.fromToken.column})`
    );
  }
  if (!nodeMap.has(edge.to)) {
    throw new CompileError(
      `Edge references unknown destination node '${edge.to}' (line ${edge.toToken.line}, column ${edge.toToken.column})`
    );
  }
  return {
    from: edge.from,
    to: edge.to,
    attributes: foldAttributes(edge.attributes)
  };
}

function buildDirectiveMap(graph: GraphNode): Map<string, AttributeValue> {
  const map = new Map<string, AttributeValue>();
  for (const directive of graph.directives) {
    if (map.has(directive.name)) {
      throw new CompileError(
        `Duplicate directive '${directive.name}' (line ${directive.nameToken.line}, column ${directive.nameToken.column})`
      );
    }
    map.set(directive.name, toPrimitive(directive.value));
  }
  return map;
}

function toAnalysis(analysis: AnalysisNode): CompiledAnalysis {
  const args = analysis.args.map((arg) => ({
    value: toPrimitive(arg),
    tokenLine: arg.token.line,
    tokenColumn: arg.token.column
  }));
  return {
    name: analysis.name,
    tokenLine: analysis.nameToken.line,
    tokenColumn: analysis.nameToken.column,
    args
  };
}

function foldAttributes(attributes: AttributeNode[]): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  for (const attribute of attributes) {
    if (Object.prototype.hasOwnProperty.call(result, attribute.key)) {
      throw new CompileError(
        `Duplicate attribute '${attribute.key}' (line ${attribute.keyToken.line}, column ${attribute.keyToken.column})`
      );
    }
    result[attribute.key] = toPrimitive(attribute.value);
  }
  return result;
}

function toPrimitive(node: ValueNode): AttributeValue {
  switch (node.kind) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "boolean":
      return node.value;
    case "identifier":
      return node.value;
    default:
      // Exhaustive check
      const exhaustive: never = node;
      return exhaustive;
  }
}
