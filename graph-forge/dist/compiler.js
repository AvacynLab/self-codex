import { parse } from "./parser.js";
import { GraphModel } from "./model.js";
export class CompileError extends Error {
    constructor(message) {
        super(message);
        this.name = "CompileError";
    }
}
export function compileSource(source, options = {}) {
    const ast = parse(source);
    return compileAst(ast, options);
}
export function compileAst(ast, options = {}) {
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
export function compileGraphNode(graph) {
    const nodeMap = buildNodeMap(graph.nodes);
    const nodeData = graph.nodes.map((node) => toNodeData(node));
    const edgeData = graph.edges.map((edge) => toEdgeData(edge, nodeMap));
    const directives = buildDirectiveMap(graph);
    const analyses = graph.analyses.map((analysis) => toAnalysis(analysis));
    const model = new GraphModel(graph.name, nodeData, edgeData, directives);
    return { graph: model, analyses };
}
function buildNodeMap(nodes) {
    const map = new Map();
    for (const node of nodes) {
        if (map.has(node.name)) {
            const prev = map.get(node.name);
            throw new CompileError(`Duplicate node '${node.name}' (line ${node.nameToken.line}, column ${node.nameToken.column}); previously defined at line ${prev.nameToken.line}`);
        }
        map.set(node.name, node);
    }
    return map;
}
function toNodeData(node) {
    return {
        id: node.name,
        attributes: foldAttributes(node.attributes)
    };
}
function toEdgeData(edge, nodeMap) {
    if (!nodeMap.has(edge.from)) {
        throw new CompileError(`Edge references unknown source node '${edge.from}' (line ${edge.fromToken.line}, column ${edge.fromToken.column})`);
    }
    if (!nodeMap.has(edge.to)) {
        throw new CompileError(`Edge references unknown destination node '${edge.to}' (line ${edge.toToken.line}, column ${edge.toToken.column})`);
    }
    return {
        from: edge.from,
        to: edge.to,
        attributes: foldAttributes(edge.attributes)
    };
}
function buildDirectiveMap(graph) {
    const map = new Map();
    for (const directive of graph.directives) {
        if (map.has(directive.name)) {
            throw new CompileError(`Duplicate directive '${directive.name}' (line ${directive.nameToken.line}, column ${directive.nameToken.column})`);
        }
        map.set(directive.name, toPrimitive(directive.value));
    }
    return map;
}
function toAnalysis(analysis) {
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
function foldAttributes(attributes) {
    const result = {};
    for (const attribute of attributes) {
        if (Object.prototype.hasOwnProperty.call(result, attribute.key)) {
            throw new CompileError(`Duplicate attribute '${attribute.key}' (line ${attribute.keyToken.line}, column ${attribute.keyToken.column})`);
        }
        result[attribute.key] = toPrimitive(attribute.value);
    }
    return result;
}
function toPrimitive(node) {
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
            const exhaustive = node;
            return exhaustive;
    }
}
//# sourceMappingURL=compiler.js.map