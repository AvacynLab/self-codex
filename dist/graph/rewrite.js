import { flatten } from "./hierarchy.js";
/** Unique key storing the serialized registry of sub-graphs embedded inside a normalised graph. */
const SUBGRAPH_REGISTRY_KEY = "hierarchy:subgraphs";
/** Attribute flag automatically added to edges produced by the split-parallel rule. */
const SPLIT_PARALLEL_FLAG = "rewritten_split_parallel";
/** Attribute flag automatically added to edges produced by the inline-subgraph rule. */
const INLINE_SUBGRAPH_FLAG = "rewritten_inline_subgraph";
/** Attribute flag automatically added to edges produced by the reroute-avoid rule. */
const REROUTE_AVOID_FLAG = "rewritten_reroute_avoid";
/** Internal upper bound that prevents the rewriting pipeline from looping forever. */
const MAX_ITERATIONS = 25;
/**
 * Apply the provided list of rewrite rules to a graph until either no further
 * changes are produced or the maximum iteration count is reached.
 */
export function applyAll(graph, rules, stopOnNoChange = true) {
    let current = cloneGraph(graph);
    const history = [];
    let iteration = 0;
    while (iteration < MAX_ITERATIONS) {
        iteration += 1;
        let changedThisRound = false;
        for (const rule of rules) {
            const { graph: nextGraph, applied, matches } = applyRule(current, rule);
            history.push({ rule: rule.name, applied, matches });
            if (applied > 0) {
                current = nextGraph;
                changedThisRound = true;
            }
        }
        if (!changedThisRound) {
            break;
        }
        if (stopOnNoChange) {
            break;
        }
    }
    return { graph: current, history };
}
/** Create the canonical split-parallel rule used to expand parallel fan-outs. */
export function createSplitParallelRule(targetEdges) {
    return {
        name: "split-parallel",
        match(graph) {
            const matches = [];
            for (const edge of graph.edges) {
                const key = edgeKey(edge);
                if (targetEdges && !targetEdges.has(key)) {
                    continue;
                }
                if (edge.attributes[SPLIT_PARALLEL_FLAG]) {
                    continue;
                }
                const shouldSplit = edge.attributes.parallel === true || edge.attributes.mode === "parallel";
                if (!shouldSplit) {
                    continue;
                }
                const nodeId = ensureUniqueNodeId(graph, `${edge.from}∥${edge.to}`);
                matches.push({ type: "split-parallel", edge, proposedNodeId: nodeId });
            }
            return matches;
        },
        apply(graph, match) {
            if (match.type !== "split-parallel") {
                return graph;
            }
            const edgeIndex = graph.edges.findIndex((candidate) => sameEdge(candidate, match.edge));
            if (edgeIndex === -1) {
                return graph;
            }
            const newNode = {
                id: match.proposedNodeId,
                label: `Parallel ${match.edge.label ?? match.edge.to}`,
                attributes: {
                    kind: "parallel",
                    parent: match.edge.from,
                },
            };
            const preservedAttributes = { ...match.edge.attributes };
            delete preservedAttributes.parallel;
            delete preservedAttributes.mode;
            const fanoutEdge = {
                from: match.edge.from,
                to: newNode.id,
                label: match.edge.label,
                weight: match.edge.weight,
                attributes: {
                    ...preservedAttributes,
                    [SPLIT_PARALLEL_FLAG]: true,
                    role: "fanout",
                },
            };
            const branchEdge = {
                from: newNode.id,
                to: match.edge.to,
                label: match.edge.label,
                weight: match.edge.weight,
                attributes: {
                    ...preservedAttributes,
                    [SPLIT_PARALLEL_FLAG]: true,
                    role: "branch",
                },
            };
            const next = {
                ...graph,
                graphVersion: graph.graphVersion + 1,
                nodes: [...graph.nodes, newNode],
                edges: replaceAt(graph.edges, edgeIndex, [fanoutEdge, branchEdge]),
            };
            return next;
        },
    };
}
/** Create the canonical inline-subgraph rule that expands embedded hierarchies. */
export function createInlineSubgraphRule() {
    return {
        name: "inline-subgraph",
        match(graph) {
            const registry = parseSubgraphRegistry(graph.metadata[SUBGRAPH_REGISTRY_KEY]);
            if (!registry) {
                return [];
            }
            const matches = [];
            for (const node of graph.nodes) {
                if (node.attributes.kind !== "subgraph") {
                    continue;
                }
                const reference = node.attributes.ref ?? node.attributes.subgraph_ref;
                if (typeof reference !== "string") {
                    continue;
                }
                const descriptor = registry.get(reference);
                if (!descriptor) {
                    continue;
                }
                matches.push({ type: "inline-subgraph", node, descriptor });
            }
            return matches;
        },
        apply(graph, match) {
            if (match.type !== "inline-subgraph") {
                return graph;
            }
            const registry = parseSubgraphRegistry(graph.metadata[SUBGRAPH_REGISTRY_KEY]);
            if (!registry) {
                return graph;
            }
            const reference = match.node.attributes.ref ?? match.node.attributes.subgraph_ref;
            if (typeof reference !== "string") {
                return graph;
            }
            const descriptor = registry.get(reference);
            if (!descriptor) {
                return graph;
            }
            const flattened = normaliseEmbeddedGraph(descriptor.graph);
            const prefixed = prefixGraph(flattened, match.node.id);
            const entryHints = descriptor.entryPoints ?? match.descriptor.entryPoints;
            const exitHints = descriptor.exitPoints ?? match.descriptor.exitPoints;
            const entryNodes = entryHints && entryHints.length > 0
                ? entryHints
                    .map((id) => prefixed.mapping.get(id) ?? id)
                    .filter((id) => typeof id === "string")
                : inferEntryNodes(prefixed.graph);
            const exitNodes = exitHints && exitHints.length > 0
                ? exitHints
                    .map((id) => prefixed.mapping.get(id) ?? id)
                    .filter((id) => typeof id === "string")
                : inferExitNodes(prefixed.graph);
            const incoming = graph.edges.filter((edge) => edge.to === match.node.id);
            const outgoing = graph.edges.filter((edge) => edge.from === match.node.id);
            const retainedNodes = graph.nodes.filter((node) => node.id !== match.node.id);
            const retainedEdges = graph.edges.filter((edge) => edge.from !== match.node.id && edge.to !== match.node.id);
            const rewiredEdges = [];
            for (const edge of incoming) {
                for (const entry of entryNodes) {
                    if (edge.from === entry) {
                        continue;
                    }
                    rewiredEdges.push({
                        from: edge.from,
                        to: entry,
                        label: edge.label,
                        weight: edge.weight,
                        attributes: {
                            ...edge.attributes,
                            [INLINE_SUBGRAPH_FLAG]: true,
                            via: match.node.id,
                        },
                    });
                }
            }
            for (const edge of outgoing) {
                for (const exit of exitNodes) {
                    if (edge.to === exit) {
                        continue;
                    }
                    rewiredEdges.push({
                        from: exit,
                        to: edge.to,
                        label: edge.label,
                        weight: edge.weight,
                        attributes: {
                            ...edge.attributes,
                            [INLINE_SUBGRAPH_FLAG]: true,
                            via: match.node.id,
                        },
                    });
                }
            }
            const nextNodes = mergeNodes(retainedNodes, prefixed.graph.nodes, match.node.id);
            const nextEdges = [...retainedEdges, ...prefixed.graph.edges, ...rewiredEdges];
            return {
                ...graph,
                graphVersion: graph.graphVersion + 1,
                nodes: sortNodes(nextNodes),
                edges: sortEdges(nextEdges),
            };
        },
    };
}
/** Create the canonical reroute-avoid rule that bypasses weak or unsafe nodes. */
export function createRerouteAvoidRule(options) {
    return {
        name: "reroute-avoid",
        match(graph) {
            const matches = [];
            for (const node of graph.nodes) {
                const shouldAvoidById = options.avoidNodeIds?.has(node.id);
                const shouldAvoidByLabel = node.label && options.avoidLabels?.has(node.label);
                if (!shouldAvoidById && !shouldAvoidByLabel) {
                    continue;
                }
                matches.push({ type: "reroute-avoid", node });
            }
            return matches;
        },
        apply(graph, match) {
            if (match.type !== "reroute-avoid") {
                return graph;
            }
            const nodeExists = graph.nodes.some((node) => node.id === match.node.id);
            if (!nodeExists) {
                return graph;
            }
            const incoming = graph.edges.filter((edge) => edge.to === match.node.id);
            const outgoing = graph.edges.filter((edge) => edge.from === match.node.id);
            if (incoming.length === 0 || outgoing.length === 0) {
                const nextNodes = graph.nodes.filter((node) => node.id !== match.node.id);
                const nextEdges = graph.edges.filter((edge) => edge.from !== match.node.id && edge.to !== match.node.id);
                return {
                    ...graph,
                    graphVersion: graph.graphVersion + 1,
                    nodes: nextNodes,
                    edges: nextEdges,
                };
            }
            const bypassEdges = [];
            const seen = new Set();
            for (const source of incoming) {
                for (const target of outgoing) {
                    if (source.from === target.to) {
                        continue;
                    }
                    const key = `${source.from}→${target.to}`;
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    bypassEdges.push({
                        from: source.from,
                        to: target.to,
                        label: target.label ?? source.label,
                        weight: source.weight ?? target.weight,
                        attributes: {
                            ...target.attributes,
                            [REROUTE_AVOID_FLAG]: true,
                            avoided: match.node.id,
                        },
                    });
                }
            }
            const nodes = graph.nodes.filter((node) => node.id !== match.node.id);
            const edges = graph.edges.filter((edge) => edge.from !== match.node.id && edge.to !== match.node.id);
            return {
                ...graph,
                graphVersion: graph.graphVersion + 1,
                nodes,
                edges: sortEdges([...edges, ...bypassEdges]),
            };
        },
    };
}
/** Apply a single rule until it can no longer mutate the graph. */
function applyRule(graph, rule) {
    let current = graph;
    let applied = 0;
    let matches = 0;
    const visited = new Set();
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        const set = rule.match(current);
        matches += set.length;
        if (set.length === 0) {
            break;
        }
        const snapshot = snapshotGraph(current);
        if (visited.has(snapshot.serialised)) {
            break;
        }
        visited.add(snapshot.serialised);
        let mutated = false;
        for (const match of set) {
            const next = rule.apply(current, match);
            if (!graphsEqual(current, next)) {
                current = next;
                applied += 1;
                mutated = true;
                break;
            }
        }
        if (!mutated) {
            break;
        }
    }
    return { graph: current, applied, matches };
}
/** Extract and validate the subgraph registry stored in the metadata map. */
function parseSubgraphRegistry(value) {
    if (!value || typeof value !== "string") {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        const registry = new Map();
        for (const [key, descriptor] of Object.entries(parsed)) {
            if (!descriptor || typeof descriptor !== "object") {
                continue;
            }
            registry.set(key, descriptor);
        }
        return registry;
    }
    catch {
        return null;
    }
}
/** Ensure that a node identifier remains unique within the provided graph. */
function ensureUniqueNodeId(graph, baseId) {
    let candidate = baseId;
    let suffix = 1;
    const existing = new Set(graph.nodes.map((node) => node.id));
    while (existing.has(candidate)) {
        suffix += 1;
        candidate = `${baseId}#${suffix}`;
    }
    return candidate;
}
/** Verify whether two edges point to the same source and target. */
function sameEdge(left, right) {
    return left.from === right.from && left.to === right.to && left.label === right.label;
}
/** Replace a single edge with a new list, returning a new array. */
function replaceAt(edges, index, replacements) {
    return [...edges.slice(0, index), ...replacements, ...edges.slice(index + 1)];
}
/** Clone a graph to maintain immutability guarantees across rewrites. */
function cloneGraph(graph) {
    return {
        ...graph,
        nodes: graph.nodes.map((node) => ({
            id: node.id,
            label: node.label,
            attributes: { ...node.attributes },
        })),
        edges: graph.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            label: edge.label,
            weight: edge.weight,
            attributes: { ...edge.attributes },
        })),
        metadata: { ...graph.metadata },
    };
}
/** Generate a structural snapshot used to detect idempotence. */
function snapshotGraph(graph) {
    return { serialised: serialiseGraph(graph) };
}
/** Determine whether two graphs are structurally identical. */
function graphsEqual(left, right) {
    return serialiseGraph(left) === serialiseGraph(right);
}
/** Produce a deterministic serialisation of a graph. */
function serialiseGraph(graph) {
    const nodes = sortNodes(graph.nodes).map((node) => ({
        id: node.id,
        label: node.label,
        attributes: sortAttributes(node.attributes),
    }));
    const edges = sortEdges(graph.edges).map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        weight: edge.weight,
        attributes: sortAttributes(edge.attributes),
    }));
    const metadata = sortAttributes(graph.metadata);
    return JSON.stringify({
        ...graph,
        nodes,
        edges,
        metadata,
    });
}
/** Sort nodes deterministically by their identifier. */
function sortNodes(nodes) {
    return [...nodes].sort((a, b) => a.id.localeCompare(b.id));
}
/** Sort edges deterministically by source/target/label. */
function sortEdges(edges) {
    return [...edges].sort((a, b) => {
        if (a.from !== b.from)
            return a.from.localeCompare(b.from);
        if (a.to !== b.to)
            return a.to.localeCompare(b.to);
        return (a.label ?? "").localeCompare(b.label ?? "");
    });
}
/** Produce a sorted copy of an attribute map for deterministic outputs. */
function sortAttributes(attributes) {
    const entries = Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
}
/** Prefix a graph so that embedded nodes remain globally unique. */
function prefixGraph(graph, prefix) {
    const mapping = new Map();
    for (const node of graph.nodes) {
        mapping.set(node.id, `${prefix}/${node.id}`);
    }
    const nodes = graph.nodes.map((node) => ({
        id: mapping.get(node.id),
        label: node.label,
        attributes: {
            ...node.attributes,
            parent_subgraph: prefix,
        },
    }));
    const edges = graph.edges.map((edge) => ({
        from: mapping.get(edge.from),
        to: mapping.get(edge.to),
        label: edge.label,
        weight: edge.weight,
        attributes: { ...edge.attributes, parent_subgraph: prefix },
    }));
    return {
        graph: {
            ...graph,
            nodes,
            edges,
        },
        mapping,
    };
}
/**
 * Merge nodes while guarding against duplicates when inlining a sub-graph.
 */
function mergeNodes(base, addition, parentId) {
    const result = [...base];
    const existing = new Set(base.map((node) => node.id));
    for (const node of addition) {
        if (existing.has(node.id)) {
            continue;
        }
        result.push({
            id: node.id,
            label: node.label,
            attributes: {
                ...node.attributes,
                host: parentId,
            },
        });
        existing.add(node.id);
    }
    return result;
}
/**
 * Determine entry nodes as the ones without in-edges in the embedded graph.
 */
function inferEntryNodes(graph) {
    const targets = new Set(graph.edges.map((edge) => edge.to));
    return graph.nodes
        .filter((node) => !targets.has(node.id))
        .map((node) => node.id)
        .sort();
}
/** Determine exit nodes as the ones without out-edges in the embedded graph. */
function inferExitNodes(graph) {
    const sources = new Set(graph.edges.map((edge) => edge.from));
    return graph.nodes
        .filter((node) => !sources.has(node.id))
        .map((node) => node.id)
        .sort();
}
/**
 * Normalise any embedded hierarchical graph so downstream rules can reuse it as
 * a regular normalised graph without leaking implementation details.
 */
function normaliseEmbeddedGraph(graph) {
    if (isNormalisedGraph(graph)) {
        return graph;
    }
    return flatten(graph);
}
/** Compute a stable identifier for an edge. */
function edgeKey(edge) {
    return `${edge.from}→${edge.to}`;
}
/** Narrow a parsed descriptor to a normalised graph when the shape matches. */
function isNormalisedGraph(graph) {
    const candidate = graph;
    if (!candidate || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
        return false;
    }
    return candidate.edges.every((edge) => typeof edge.from === "string" && typeof edge.to === "string");
}
