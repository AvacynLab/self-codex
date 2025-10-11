// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/** Default input port assigned when a task endpoint does not specify one explicitly. */
const DEFAULT_INPUT_PORT = "in";
/** Default output port assigned when a task endpoint does not specify one explicitly. */
const DEFAULT_OUTPUT_PORT = "out";
/** Internal key used to store the embedded hierarchical sub-graph within a subgraph node. */
const EMBEDDED_GRAPH_KEY = "__embeddedGraph";
/** Internal key used to track the ancestry of embeddings to detect cycles. */
const ANCESTRY_KEY = "__hierarchyAncestry";
/**
 * Determine whether the provided node represents a task.
 */
function isTaskNode(node) {
    return node.kind === "task";
}
/**
 * Determine whether the provided node represents a sub-graph placeholder.
 */
function isSubgraphNode(node) {
    return node.kind === "subgraph";
}
/**
 * Normalise the provided list of port names, defaulting to a single entry when undefined.
 */
function normalisePorts(ports, fallback) {
    if (!ports || ports.length === 0) {
        return new Set([fallback]);
    }
    const unique = new Set();
    for (const port of ports) {
        if (typeof port !== "string" || port.trim().length === 0) {
            throw new Error(`Invalid port name \"${port}\"`);
        }
        unique.add(port);
    }
    return unique;
}
/**
 * Extract and validate the SubgraphPorts contract stored inside a subgraph node.
 */
function extractSubgraphPorts(node) {
    const raw = node.params?.ports;
    if (!raw || typeof raw !== "object") {
        throw new Error(`Subgraph node ${node.id} is missing ports declaration`);
    }
    const inputs = {};
    const outputs = {};
    const rawInputs = raw.inputs;
    const rawOutputs = raw.outputs;
    if (!rawInputs || typeof rawInputs !== "object") {
        throw new Error(`Subgraph node ${node.id} is missing input ports`);
    }
    if (!rawOutputs || typeof rawOutputs !== "object") {
        throw new Error(`Subgraph node ${node.id} is missing output ports`);
    }
    for (const [key, value] of Object.entries(rawInputs)) {
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new Error(`Invalid input port mapping for subgraph ${node.id}`);
        }
        inputs[key] = value;
    }
    for (const [key, value] of Object.entries(rawOutputs)) {
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new Error(`Invalid output port mapping for subgraph ${node.id}`);
        }
        outputs[key] = value;
    }
    return { inputs, outputs };
}
/**
 * Retrieve the embedded graph stored inside a subgraph node, if any.
 */
function extractEmbeddedGraph(node) {
    const raw = node.params?.[EMBEDDED_GRAPH_KEY];
    if (!raw) {
        return undefined;
    }
    if (typeof raw !== "object") {
        throw new Error(`Embedded graph payload for node ${node.id} is invalid`);
    }
    return raw;
}
/**
 * Deep clone a hierarchical graph to avoid accidental mutations when embedding.
 */
function cloneHierGraph(graph) {
    return structuredClone(graph);
}
/**
 * Recursively ensure that embedding the provided sub-graph would not introduce a cycle across hierarchy levels.
 */
function assertNoInterLevelCycle(graph, ancestors) {
    if (ancestors.has(graph.id)) {
        throw new Error(`Embedding graph ${graph.id} would introduce a cycle`);
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(graph.id);
    for (const node of graph.nodes) {
        if (isSubgraphNode(node)) {
            if (ancestors.has(node.ref)) {
                throw new Error(`Embedding subgraph ${node.ref} would create an inter-level cycle`);
            }
            const embedded = extractEmbeddedGraph(node);
            if (embedded) {
                assertNoInterLevelCycle(embedded, nextAncestors);
            }
        }
    }
}
/**
 * Ensure node identifiers are unique and all edges reference valid nodes and ports.
 */
function validateHierGraph(graph) {
    const idSet = new Set();
    const nodeById = new Map();
    for (const node of graph.nodes) {
        if (idSet.has(node.id)) {
            throw new Error(`Duplicate node identifier detected: ${node.id}`);
        }
        idSet.add(node.id);
        nodeById.set(node.id, node);
        if (isTaskNode(node)) {
            normalisePorts(node.inputs, DEFAULT_INPUT_PORT);
            normalisePorts(node.outputs, DEFAULT_OUTPUT_PORT);
        }
        else if (isSubgraphNode(node)) {
            if (!node.ref || node.ref.trim().length === 0) {
                throw new Error(`Subgraph node ${node.id} must reference a subgraph identifier`);
            }
            // Validate ports and embedded graphs up-front.
            extractSubgraphPorts(node);
            const embedded = extractEmbeddedGraph(node);
            if (embedded) {
                validateHierGraph(embedded);
            }
        }
    }
    for (const edge of graph.edges) {
        const fromNode = nodeById.get(edge.from.nodeId);
        const toNode = nodeById.get(edge.to.nodeId);
        if (!fromNode) {
            throw new Error(`Edge ${edge.id} references unknown source node ${edge.from.nodeId}`);
        }
        if (!toNode) {
            throw new Error(`Edge ${edge.id} references unknown target node ${edge.to.nodeId}`);
        }
        const fromPort = edge.from.port ?? DEFAULT_OUTPUT_PORT;
        if (isTaskNode(fromNode)) {
            const ports = normalisePorts(fromNode.outputs, DEFAULT_OUTPUT_PORT);
            if (!ports.has(fromPort)) {
                throw new Error(`Edge ${edge.id} references missing output port ${fromPort} on ${fromNode.id}`);
            }
        }
        else {
            const ports = extractSubgraphPorts(fromNode).outputs;
            if (!ports[fromPort]) {
                throw new Error(`Edge ${edge.id} references missing subgraph output port ${fromPort} on ${fromNode.id}`);
            }
        }
        const toPort = edge.to.port ?? DEFAULT_INPUT_PORT;
        if (isTaskNode(toNode)) {
            const ports = normalisePorts(toNode.inputs, DEFAULT_INPUT_PORT);
            if (!ports.has(toPort)) {
                throw new Error(`Edge ${edge.id} references missing input port ${toPort} on ${toNode.id}`);
            }
        }
        else {
            const ports = extractSubgraphPorts(toNode).inputs;
            if (!ports[toPort]) {
                throw new Error(`Edge ${edge.id} references missing subgraph input port ${toPort} on ${toNode.id}`);
            }
        }
    }
}
/**
 * Helper exposing the embedded graph stored inside a subgraph node (used in tests and diagnostics).
 */
export function getEmbeddedGraph(node) {
    return extractEmbeddedGraph(node);
}
/**
 * Embed the provided sub-graph inside the selected subgraph node, returning a new hierarchical graph instance.
 */
export function embedSubgraph(parent, nodeId, sub) {
    validateHierGraph(parent);
    validateHierGraph(sub);
    const node = parent.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
        throw new Error(`Unknown node ${nodeId}`);
    }
    if (!isSubgraphNode(node)) {
        throw new Error(`Node ${nodeId} is not a subgraph node`);
    }
    if (node.ref !== sub.id) {
        throw new Error(`Subgraph node ${nodeId} expects graph ${node.ref} but received ${sub.id}`);
    }
    const declaredPorts = extractSubgraphPorts(node);
    const subNodeIds = new Set(sub.nodes.map((candidate) => candidate.id));
    for (const target of Object.values(declaredPorts.inputs)) {
        if (!subNodeIds.has(target)) {
            throw new Error(`Input port on ${node.id} targets missing node ${target} in subgraph ${sub.id}`);
        }
    }
    for (const target of Object.values(declaredPorts.outputs)) {
        if (!subNodeIds.has(target)) {
            throw new Error(`Output port on ${node.id} targets missing node ${target} in subgraph ${sub.id}`);
        }
    }
    const ancestry = new Set(Array.isArray(node.params?.[ANCESTRY_KEY]) ? node.params?.[ANCESTRY_KEY] : []);
    ancestry.add(parent.id);
    assertNoInterLevelCycle(sub, ancestry);
    const embedded = cloneHierGraph(sub);
    const updatedNode = {
        ...node,
        params: {
            ...node.params,
            [EMBEDDED_GRAPH_KEY]: embedded,
            [ANCESTRY_KEY]: Array.from(ancestry),
        },
    };
    return {
        ...parent,
        nodes: parent.nodes.map((candidate) => (candidate.id === nodeId ? updatedNode : candidate)),
    };
}
/**
 * Convert a hierarchical graph into the flattened normalised representation consumed by the rest of the orchestrator.
 */
export function flatten(hier) {
    validateHierGraph(hier);
    const nodes = [];
    const edges = [];
    const addedNodeIds = new Set();
    function addNode(record) {
        if (addedNodeIds.has(record.id)) {
            return;
        }
        addedNodeIds.add(record.id);
        nodes.push(record);
    }
    function flattenRecursive(graph, prefix, ancestors) {
        assertNoInterLevelCycle(graph, ancestors);
        const idPrefix = prefix.length > 0 ? `${prefix}/` : "";
        const mapping = new Map();
        const portBindings = new Map();
        const localAncestors = new Set(ancestors);
        localAncestors.add(graph.id);
        for (const node of graph.nodes) {
            if (isTaskNode(node)) {
                const finalId = `${idPrefix}${node.id}`;
                mapping.set(node.id, finalId);
                const attributes = { kind: "task" };
                if (node.attributes) {
                    for (const [key, value] of Object.entries(node.attributes)) {
                        if (typeof value === "string" ||
                            typeof value === "number" ||
                            typeof value === "boolean") {
                            attributes[key] = value;
                        }
                    }
                }
                const record = {
                    id: finalId,
                    label: node.label,
                    attributes,
                };
                addNode(record);
            }
            else {
                const embedded = extractEmbeddedGraph(node);
                if (!embedded) {
                    throw new Error(`Subgraph node ${node.id} does not have an embedded graph`);
                }
                const finalId = `${idPrefix}${node.id}`;
                const childMapping = flattenRecursive(embedded, finalId, localAncestors);
                const ports = extractSubgraphPorts(node);
                const inputs = {};
                for (const [port, target] of Object.entries(ports.inputs)) {
                    const resolved = childMapping.get(target);
                    if (!resolved) {
                        throw new Error(`Input port ${port} on ${node.id} targets missing node ${target}`);
                    }
                    inputs[port] = resolved;
                }
                const outputs = {};
                for (const [port, target] of Object.entries(ports.outputs)) {
                    const resolved = childMapping.get(target);
                    if (!resolved) {
                        throw new Error(`Output port ${port} on ${node.id} targets missing node ${target}`);
                    }
                    outputs[port] = resolved;
                }
                portBindings.set(node.id, { inputs, outputs });
            }
        }
        for (const edge of graph.edges) {
            const fromNode = graph.nodes.find((candidate) => candidate.id === edge.from.nodeId);
            const toNode = graph.nodes.find((candidate) => candidate.id === edge.to.nodeId);
            const fromPort = edge.from.port ?? DEFAULT_OUTPUT_PORT;
            const toPort = edge.to.port ?? DEFAULT_INPUT_PORT;
            const fromId = isTaskNode(fromNode)
                ? mapping.get(fromNode.id)
                : portBindings.get(fromNode.id)?.outputs[fromPort];
            if (!fromId) {
                throw new Error(`Unable to resolve source node for edge ${edge.id}`);
            }
            const toId = isTaskNode(toNode)
                ? mapping.get(toNode.id)
                : portBindings.get(toNode.id)?.inputs[toPort];
            if (!toId) {
                throw new Error(`Unable to resolve target node for edge ${edge.id}`);
            }
            const attributes = {
                ...(edge.attributes ?? {}),
                hierarchy_edge: edge.id,
                from_port: fromPort,
                to_port: toPort,
            };
            const record = {
                from: fromId,
                to: toId,
                label: edge.label,
                attributes,
            };
            edges.push(record);
        }
        return mapping;
    }
    flattenRecursive(hier, "", new Set());
    nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    return {
        name: hier.id,
        graphId: hier.id,
        graphVersion: 1,
        nodes,
        edges,
        metadata: { hierarchical: true },
    };
}
//# sourceMappingURL=hierarchy.js.map