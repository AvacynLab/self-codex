/** Metadata key storing the hyper-edge identifier after projection. */
const HYPER_EDGE_ID_KEY = "hyper_edge_id";
/** Metadata key storing the pair index generated during projection. */
const HYPER_EDGE_PAIR_INDEX_KEY = "hyper_edge_pair_index";
/** Metadata key storing the index of the source endpoint in the hyper-edge. */
const HYPER_EDGE_SOURCE_INDEX_KEY = "hyper_edge_source_index";
/** Metadata key storing the index of the target endpoint in the hyper-edge. */
const HYPER_EDGE_TARGET_INDEX_KEY = "hyper_edge_target_index";
/** Metadata key capturing the number of sources in the hyper-edge. */
const HYPER_EDGE_SOURCE_CARDINALITY_KEY = "hyper_edge_source_cardinality";
/** Metadata key capturing the number of targets in the hyper-edge. */
const HYPER_EDGE_TARGET_CARDINALITY_KEY = "hyper_edge_target_cardinality";
/**
 * Project an n-ary hyper-edge into a set of binary edges.
 *
 * Each generated edge retains enough metadata to rebuild the original hyper-edge
 * or to provide context to reporting tools. The metadata intentionally relies on
 * primitive values so that downstream serialisations remain stable.
 */
function projectHyperEdge(edge, nodeIds) {
    if (!edge.id || edge.id.trim().length === 0) {
        throw new Error("hyper-edge must expose a stable identifier");
    }
    if (!Array.isArray(edge.sources) || edge.sources.length === 0) {
        throw new Error(`hyper-edge ${edge.id} must declare at least one source`);
    }
    if (!Array.isArray(edge.targets) || edge.targets.length === 0) {
        throw new Error(`hyper-edge ${edge.id} must declare at least one target`);
    }
    const projected = [];
    let pairIndex = 0;
    for (let sourceIndex = 0; sourceIndex < edge.sources.length; sourceIndex += 1) {
        const source = edge.sources[sourceIndex];
        if (!nodeIds.has(source)) {
            throw new Error(`hyper-edge ${edge.id} references unknown source node ${source}`);
        }
        for (let targetIndex = 0; targetIndex < edge.targets.length; targetIndex += 1) {
            const target = edge.targets[targetIndex];
            if (!nodeIds.has(target)) {
                throw new Error(`hyper-edge ${edge.id} references unknown target node ${target}`);
            }
            const attributes = {
                [HYPER_EDGE_ID_KEY]: edge.id,
                [HYPER_EDGE_PAIR_INDEX_KEY]: pairIndex,
                [HYPER_EDGE_SOURCE_INDEX_KEY]: sourceIndex,
                [HYPER_EDGE_TARGET_INDEX_KEY]: targetIndex,
                [HYPER_EDGE_SOURCE_CARDINALITY_KEY]: edge.sources.length,
                [HYPER_EDGE_TARGET_CARDINALITY_KEY]: edge.targets.length,
            };
            if (edge.attributes) {
                for (const [key, value] of Object.entries(edge.attributes)) {
                    attributes[key] = value;
                }
            }
            projected.push({
                from: source,
                to: target,
                label: edge.label,
                weight: edge.weight,
                attributes,
            });
            pairIndex += 1;
        }
    }
    return projected;
}
/**
 * Validate and normalise the node list of the provided hyper-graph.
 *
 * The helper guarantees a stable foundation before projection by enforcing
 * unique node identifiers and by ensuring each node exposes an attribute map.
 */
function normaliseNodes(nodes) {
    const nodeIds = new Set();
    const records = [];
    for (const node of nodes) {
        if (!node.id || node.id.trim().length === 0) {
            throw new Error("hyper-graph nodes must provide an identifier");
        }
        if (nodeIds.has(node.id)) {
            throw new Error(`duplicate node identifier detected in hyper-graph: ${node.id}`);
        }
        nodeIds.add(node.id);
        records.push({
            ...node,
            attributes: node.attributes ?? {},
        });
    }
    return { ids: nodeIds, records };
}
/**
 * Project a {@link HyperGraph} into the normalised representation consumed by
 * the rest of the graph tooling. The resulting graph preserves the original
 * nodes while expanding every hyper-edge into a set of binary edges enriched
 * with metadata for traceability.
 */
export function projectHyperGraph(graph, options = {}) {
    if (!graph.id || graph.id.trim().length === 0) {
        throw new Error("hyper-graph must expose an identifier");
    }
    const { ids: nodeIds, records } = normaliseNodes(graph.nodes);
    const edges = [];
    for (const edge of graph.hyperEdges) {
        const projected = projectHyperEdge(edge, nodeIds);
        edges.push(...projected);
    }
    return {
        name: graph.id,
        graphId: graph.id,
        graphVersion: options.graphVersion ?? 1,
        nodes: records,
        edges,
        metadata: {
            ...(graph.metadata ?? {}),
            hyper_edge_projection: true,
        },
    };
}
export { HYPER_EDGE_ID_KEY, HYPER_EDGE_PAIR_INDEX_KEY, HYPER_EDGE_SOURCE_CARDINALITY_KEY, HYPER_EDGE_SOURCE_INDEX_KEY, HYPER_EDGE_TARGET_CARDINALITY_KEY, HYPER_EDGE_TARGET_INDEX_KEY, projectHyperEdge, };
