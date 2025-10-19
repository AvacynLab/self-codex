function clampK(requested, available, notes) {
    if (requested <= 0) {
        notes.push("k_adjusted_to_minimum");
        return Math.min(available, 1);
    }
    if (requested > available) {
        notes.push("k_reduced_to_node_count");
        return available;
    }
    return requested;
}
function selectSeedNodes(graph, index, k, objective, seed) {
    const seen = new Set();
    const ordered = [];
    const pushCandidate = (id) => {
        if (!seen.has(id)) {
            seen.add(id);
            ordered.push(id);
        }
    };
    const appendCandidates = (candidates) => {
        for (const candidate of candidates) {
            pushCandidate(candidate);
            if (ordered.length >= k) {
                return;
            }
        }
    };
    if (objective === "min-cut") {
        appendCandidates(index.entrypoints);
        appendCandidates(index.sinks);
    }
    appendCandidates(index.hubs);
    if (ordered.length < k) {
        const sortedByDegree = [...graph.nodes]
            .map((node) => ({
            id: node.id,
            degree: (index.indegree.get(node.id) ?? 0) + (index.outdegree.get(node.id) ?? 0),
        }))
            .sort((a, b) => (b.degree - a.degree) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        appendCandidates(sortedByDegree.map((entry) => entry.id));
    }
    if (ordered.length < k) {
        const alphabetical = [...graph.nodes]
            .map((node) => node.id)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        appendCandidates(alphabetical);
    }
    if (ordered.length === 0) {
        return [];
    }
    if (typeof seed === "number" && Number.isFinite(seed) && seed > 0) {
        const offset = seed % ordered.length;
        const rotated = ordered.slice(offset).concat(ordered.slice(0, offset));
        return rotated.slice(0, k);
    }
    return ordered.slice(0, k);
}
function labelPropagation(graph, index, maxIterations) {
    const labels = new Map();
    for (const node of graph.nodes) {
        labels.set(node.id, node.id);
    }
    let iterations = 0;
    for (; iterations < maxIterations; iterations += 1) {
        let changes = 0;
        for (const node of graph.nodes) {
            const neighbours = index.undirectedAdjacency.get(node.id) ?? [];
            if (neighbours.length === 0) {
                continue;
            }
            const frequency = new Map();
            for (const neighbour of neighbours) {
                const label = labels.get(neighbour) ?? neighbour;
                frequency.set(label, (frequency.get(label) ?? 0) + 1);
            }
            const ranked = Array.from(frequency.entries()).sort((a, b) => {
                if (b[1] === a[1]) {
                    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
                }
                return b[1] - a[1];
            });
            const bestLabel = ranked[0]?.[0];
            if (bestLabel && bestLabel !== labels.get(node.id)) {
                labels.set(node.id, bestLabel);
                changes += 1;
            }
        }
        if (changes === 0) {
            break;
        }
    }
    return { labels, iterations: iterations + 1 };
}
function mergeCommunitiesIntoPartitions(labels, adjacency, k) {
    const groups = new Map();
    for (const [node, label] of labels.entries()) {
        const bucket = groups.get(label);
        if (bucket) {
            bucket.push(node);
        }
        else {
            groups.set(label, [node]);
        }
    }
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
        if (b[1].length === a[1].length) {
            return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        }
        return b[1].length - a[1].length;
    });
    const assignments = new Map();
    const baseGroups = sortedGroups.slice(0, k);
    baseGroups.forEach(([, nodes], index) => {
        for (const node of nodes) {
            assignments.set(node, index);
        }
    });
    for (const [, nodes] of sortedGroups.slice(k)) {
        for (const node of nodes) {
            const neighbours = adjacency.get(node) ?? [];
            let preferredPartition = null;
            for (const neighbour of neighbours) {
                const partition = assignments.get(neighbour);
                if (partition !== undefined) {
                    preferredPartition = partition;
                    break;
                }
            }
            if (preferredPartition === null) {
                preferredPartition = node.charCodeAt(0) % k;
            }
            assignments.set(node, preferredPartition);
        }
    }
    return assignments;
}
function multiSourceBfs(adjacency, seeds, k) {
    const assignments = new Map();
    const queue = [];
    seeds.forEach((seed, index) => {
        const partition = index % k;
        queue.push({ node: seed, partition });
    });
    while (queue.length > 0) {
        const current = queue.shift();
        if (assignments.has(current.node)) {
            continue;
        }
        assignments.set(current.node, current.partition);
        for (const neighbour of adjacency.get(current.node) ?? []) {
            if (!assignments.has(neighbour)) {
                queue.push({ node: neighbour, partition: current.partition });
            }
        }
    }
    return assignments;
}
function rotateSeeds(seeds, seed) {
    if (seeds.length === 0) {
        return [];
    }
    if (seed === undefined || !Number.isFinite(seed) || seed <= 0) {
        return [...seeds];
    }
    const offset = seed % seeds.length;
    return seeds.slice(offset).concat(seeds.slice(0, offset));
}
function dedupeSeeds(values) {
    const seen = new Set();
    const ordered = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            ordered.push(value);
        }
    }
    return ordered;
}
function rebalanceAssignments(graph, assignments, k) {
    if (assignments.size >= graph.nodes.length) {
        return false;
    }
    const remaining = graph.nodes
        .map((node) => node.id)
        .filter((id) => !assignments.has(id));
    if (remaining.length === 0) {
        return false;
    }
    let cursor = 0;
    for (const node of remaining) {
        assignments.set(node, cursor % k);
        cursor += 1;
    }
    return true;
}
function buildSeedVariants(graph, index, k, seed) {
    const variants = [];
    const seen = new Set();
    const pushVariant = (sources, alreadyRotated = false) => {
        if (sources.length === 0) {
            return;
        }
        const rotated = alreadyRotated ? [...sources] : rotateSeeds(sources, seed);
        const dedupedSeeds = dedupeSeeds(rotated).slice(0, k);
        if (dedupedSeeds.length === 0) {
            return;
        }
        const key = dedupedSeeds.join("|");
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        variants.push(dedupedSeeds);
    };
    pushVariant(selectSeedNodes(graph, index, k, "min-cut", seed), true);
    if (index.hubs.length > 0 && index.sinks.length > 0) {
        pushVariant([index.hubs[0], ...index.sinks]);
        pushVariant([index.hubs[0], ...index.entrypoints]);
    }
    if (index.entrypoints.length > 0) {
        pushVariant([...index.entrypoints, ...index.hubs]);
    }
    if (index.sinks.length > 0) {
        pushVariant([...index.sinks, ...index.hubs]);
    }
    const alphabetical = [...graph.nodes]
        .map((node) => node.id)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    pushVariant(alphabetical);
    return variants;
}
function countCutEdges(graph, assignments) {
    let cuts = 0;
    for (const edge of graph.edges) {
        if (assignments.get(edge.from) !== assignments.get(edge.to)) {
            cuts += 1;
        }
    }
    return cuts;
}
/**
 * Greedily reassigns nodes to reduce the number of cut edges. The heuristic
 * keeps partitions non-empty while exploring alternate partitions for each
 * node and accepts the first strictly improving move. This keeps the
 * complexity manageable for the small graphs used by the orchestrator while
 * markedly improving the min-cut objective quality.
 */
function refineMinCutAssignments(graph, assignments, k, currentCut, notes) {
    if (assignments.size === 0) {
        return currentCut;
    }
    const counts = new Map();
    for (let partition = 0; partition < k; partition += 1) {
        counts.set(partition, 0);
    }
    for (const partition of assignments.values()) {
        counts.set(partition, (counts.get(partition) ?? 0) + 1);
    }
    let improved = false;
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of graph.nodes) {
            const currentPartition = assignments.get(node.id);
            if (currentPartition === undefined) {
                continue;
            }
            const currentCount = counts.get(currentPartition) ?? 0;
            if (currentCount <= 1) {
                continue;
            }
            let bestPartition = currentPartition;
            let bestCut = currentCut;
            for (let candidate = 0; candidate < k; candidate += 1) {
                if (candidate === currentPartition) {
                    continue;
                }
                assignments.set(node.id, candidate);
                const newCut = countCutEdges(graph, assignments);
                assignments.set(node.id, currentPartition);
                if (newCut < bestCut) {
                    bestCut = newCut;
                    bestPartition = candidate;
                }
            }
            if (bestPartition !== currentPartition) {
                assignments.set(node.id, bestPartition);
                counts.set(currentPartition, currentCount - 1);
                counts.set(bestPartition, (counts.get(bestPartition) ?? 0) + 1);
                currentCut = bestCut;
                improved = true;
                changed = true;
            }
        }
    }
    if (improved) {
        notes.push("min_cut_refined");
    }
    return currentCut;
}
/**
 * Heuristic partitioner splitting a graph into at most `k` communities. The
 * implementation favours determinism over randomness to keep the unit tests
 * stable across Node.js versions.
 */
export function partitionGraph(graph, index, options) {
    const notes = [];
    const totalNodes = graph.nodes.length;
    if (totalNodes === 0) {
        return {
            assignments: new Map(),
            cutEdges: 0,
            partitionCount: 0,
            seedNodes: [],
            iterations: 0,
            notes: ["empty_graph"],
        };
    }
    const k = clampK(options.k, totalNodes, notes);
    const baseSeeds = selectSeedNodes(graph, index, k, options.objective, options.seed);
    let assignments;
    let iterations = 0;
    let chosenSeeds = baseSeeds;
    let cutEdges = 0;
    let rebalanced = false;
    if (options.objective === "community") {
        const propagation = labelPropagation(graph, index, options.maxIterations ?? 12);
        iterations = propagation.iterations;
        assignments = mergeCommunitiesIntoPartitions(propagation.labels, index.undirectedAdjacency, k);
        const distinct = new Set(assignments.values());
        if (distinct.size < k) {
            assignments = multiSourceBfs(index.undirectedAdjacency, baseSeeds, k);
            iterations = 1;
        }
        rebalanced = rebalanceAssignments(graph, assignments, k);
        cutEdges = countCutEdges(graph, assignments);
    }
    else {
        const variants = buildSeedVariants(graph, index, k, options.seed);
        let best = null;
        let bestKey = "";
        for (const variant of variants) {
            if (variant.length === 0) {
                continue;
            }
            const candidateAssignments = multiSourceBfs(index.undirectedAdjacency, variant, k);
            const candidateRebalanced = rebalanceAssignments(graph, candidateAssignments, k);
            const localNotes = [];
            let candidateCut = countCutEdges(graph, candidateAssignments);
            candidateCut = refineMinCutAssignments(graph, candidateAssignments, k, candidateCut, localNotes);
            const key = variant.join("|");
            if (!best ||
                candidateCut < best.cut ||
                (candidateCut === best.cut && key < bestKey)) {
                best = {
                    assignments: candidateAssignments,
                    cut: candidateCut,
                    seeds: variant,
                    rebalanced: candidateRebalanced,
                    notes: localNotes,
                };
                bestKey = key;
            }
        }
        if (!best) {
            const fallbackAssignments = multiSourceBfs(index.undirectedAdjacency, baseSeeds, k);
            const fallbackRebalanced = rebalanceAssignments(graph, fallbackAssignments, k);
            const localNotes = [];
            let fallbackCut = countCutEdges(graph, fallbackAssignments);
            fallbackCut = refineMinCutAssignments(graph, fallbackAssignments, k, fallbackCut, localNotes);
            assignments = fallbackAssignments;
            cutEdges = fallbackCut;
            chosenSeeds = baseSeeds;
            rebalanced = fallbackRebalanced;
            for (const note of localNotes) {
                if (!notes.includes(note)) {
                    notes.push(note);
                }
            }
        }
        else {
            assignments = best.assignments;
            cutEdges = best.cut;
            chosenSeeds = best.seeds;
            rebalanced = best.rebalanced;
            for (const note of best.notes) {
                if (!notes.includes(note)) {
                    notes.push(note);
                }
            }
        }
        iterations = 1;
    }
    if (rebalanced && !notes.includes("unassigned_nodes_rebalanced")) {
        notes.push("unassigned_nodes_rebalanced");
    }
    if (chosenSeeds.length < k && !notes.includes("seed_count_reduced")) {
        notes.push("seed_count_reduced");
    }
    const uniquePartitions = new Set(assignments.values());
    return {
        assignments,
        cutEdges,
        partitionCount: uniquePartitions.size,
        seedNodes: chosenSeeds,
        iterations,
        notes,
    };
}
//# sourceMappingURL=partition.js.map