/** Error thrown when invariants are violated. */
export class GraphInvariantError extends Error {
    violations;
    constructor(violations) {
        super(violations
            .map((violation) => `${violation.code}: ${violation.message}`)
            .join("; "));
        this.violations = violations;
        this.name = "GraphInvariantError";
    }
}
/**
 * Evaluate the invariants declared in the graph metadata and node attributes.
 * Callers can override the derived options via {@link overrides}.
 */
export function evaluateGraphInvariants(graph, overrides = {}) {
    const options = deriveOptions(graph, overrides);
    const violations = [];
    if (options.enforceDag) {
        const cycles = detectCycles(graph);
        if (cycles.length > 0) {
            violations.push({
                code: "E-GRAPH-CYCLE",
                message: `cycles detected (${cycles.length}) in graph '${graph.graphId}'`,
                details: { cycles },
            });
        }
    }
    if (options.requireNodeLabels) {
        const missing = graph.nodes.filter((node) => !node.label || node.label.trim().length === 0).map((node) => node.id);
        if (missing.length > 0) {
            violations.push({
                code: "E-NODE-LABEL",
                message: "node labels are required when 'require_labels' metadata is true",
                nodes: missing,
            });
        }
    }
    if (options.requireEdgeLabels) {
        const missing = graph.edges
            .filter((edge) => !edge.label || edge.label.trim().length === 0)
            .map((edge) => ({ from: edge.from, to: edge.to }));
        if (missing.length > 0) {
            for (const entry of missing) {
                violations.push({
                    code: "E-EDGE-LABEL",
                    message: `edge '${entry.from}' -> '${entry.to}' is missing a label`,
                    edge: entry,
                });
            }
        }
    }
    if (options.requirePortAttributes) {
        for (const edge of graph.edges) {
            const fromPort = normalisePort(edge.attributes.from_port);
            const toPort = normalisePort(edge.attributes.to_port);
            if (!fromPort || !toPort) {
                violations.push({
                    code: "E-EDGE-PORT",
                    message: `edge '${edge.from}' -> '${edge.to}' must declare 'from_port' and 'to_port' attributes`,
                    edge: { from: edge.from, to: edge.to },
                });
            }
        }
    }
    const cardinalityViolations = enforceCardinality(graph, options);
    violations.push(...cardinalityViolations);
    return { ok: violations.length === 0, violations };
}
/** Assert that the invariants hold, throwing a {@link GraphInvariantError} when they do not. */
export function assertGraphInvariants(graph, overrides = {}) {
    const report = evaluateGraphInvariants(graph, overrides);
    if (!report.ok) {
        throw new GraphInvariantError(report.violations);
    }
}
/** Infer invariant options from metadata and node attributes. */
function deriveOptions(graph, overrides) {
    const metadata = normaliseRecord(graph.metadata ?? {});
    return {
        enforceDag: overrides.enforceDag ?? (metadata.graph_kind === "dag" || metadata.dag === true || metadata.enforce_dag === true),
        requireNodeLabels: overrides.requireNodeLabels ?? metadata.require_labels === true,
        requireEdgeLabels: overrides.requireEdgeLabels ?? metadata.require_edge_labels === true,
        requirePortAttributes: overrides.requirePortAttributes ?? metadata.require_ports === true,
        defaultMaxInDegree: overrides.defaultMaxInDegree ?? parseDegree(metadata.max_in_degree),
        defaultMaxOutDegree: overrides.defaultMaxOutDegree ?? parseDegree(metadata.max_out_degree),
    };
}
/** Parse a degree hint from metadata. */
function parseDegree(value) {
    if (typeof value !== "number") {
        return undefined;
    }
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
/**
 * Enforce per-node cardinality limits using metadata defaults and attribute-level overrides.
 */
function enforceCardinality(graph, options) {
    const violations = [];
    const incoming = new Map();
    const outgoing = new Map();
    for (const node of graph.nodes) {
        incoming.set(node.id, 0);
        outgoing.set(node.id, 0);
    }
    for (const edge of graph.edges) {
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
        outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    }
    for (const node of graph.nodes) {
        const maxIn = parseDegree(node.attributes.max_in_degree) ?? options.defaultMaxInDegree;
        const maxOut = parseDegree(node.attributes.max_out_degree) ?? options.defaultMaxOutDegree;
        if (typeof maxIn === "number" && (incoming.get(node.id) ?? 0) > maxIn) {
            violations.push({
                code: "E-IN-DEGREE",
                message: `node '${node.id}' exceeds max_in_degree (${incoming.get(node.id)} > ${maxIn})`,
                nodes: [node.id],
                details: { max: maxIn, actual: incoming.get(node.id) ?? 0 },
            });
        }
        if (typeof maxOut === "number" && (outgoing.get(node.id) ?? 0) > maxOut) {
            violations.push({
                code: "E-OUT-DEGREE",
                message: `node '${node.id}' exceeds max_out_degree (${outgoing.get(node.id)} > ${maxOut})`,
                nodes: [node.id],
                details: { max: maxOut, actual: outgoing.get(node.id) ?? 0 },
            });
        }
    }
    return violations;
}
/** Detect directed cycles using depth-first search. */
function detectCycles(graph) {
    const adjacency = new Map();
    for (const node of graph.nodes) {
        adjacency.set(node.id, []);
    }
    for (const edge of graph.edges) {
        if (!adjacency.has(edge.from)) {
            adjacency.set(edge.from, []);
        }
        adjacency.get(edge.from).push(edge.to);
    }
    const visiting = new Set();
    const visited = new Set();
    const stack = [];
    const cycles = [];
    const visit = (nodeId) => {
        visiting.add(nodeId);
        stack.push(nodeId);
        for (const neighbour of adjacency.get(nodeId) ?? []) {
            if (visiting.has(neighbour)) {
                const startIndex = stack.indexOf(neighbour);
                if (startIndex >= 0) {
                    cycles.push(stack.slice(startIndex).concat(neighbour));
                }
                continue;
            }
            if (!visited.has(neighbour)) {
                visit(neighbour);
            }
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        stack.pop();
    };
    for (const nodeId of adjacency.keys()) {
        if (!visited.has(nodeId)) {
            visit(nodeId);
        }
    }
    return cycles;
}
/** Normalise metadata/attribute records. */
function normaliseRecord(record) {
    const output = {};
    for (const [key, value] of Object.entries(record)) {
        output[key] = value;
    }
    return output;
}
/** Normalise a port attribute value into a non-empty string. */
function normalisePort(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
