import { GraphDescriptorSchema } from "../tools/graphTools.js";
/** Options influencing the Mermaid serialisation. */
/**
 * Convert a graph descriptor into a Mermaid flowchart definition.
 *
 * The function performs light sanitisation on identifiers to keep the output
 * compatible with the Mermaid grammar while preserving determinism. Labels are
 * trimmed and truncated to avoid oversized diagrams.
 */
export function renderMermaidFromGraph(descriptor, options = {}) {
    const parsed = GraphDescriptorSchema.parse(descriptor);
    const direction = options.direction ?? "LR";
    const maxLength = Math.max(8, options.maxLabelLength ?? 48);
    const idMap = new Map();
    // Track the generated identifiers separately to avoid repeatedly scanning the
    // cache. This keeps the deterministic suffixing logic linear in the number
    // of nodes instead of quadratic when collisions appear.
    const usedIds = new Set();
    const lines = [`graph ${direction}`];
    for (const node of parsed.nodes) {
        const normalisedId = normaliseId(node.id, idMap, usedIds);
        const label = buildNodeLabel(node, options.labelAttribute, maxLength);
        lines.push(`${normalisedId}["${label}"]`);
    }
    for (const edge of parsed.edges) {
        const fromId = idMap.get(edge.from) ?? normaliseId(edge.from, idMap, usedIds);
        const toId = idMap.get(edge.to) ?? normaliseId(edge.to, idMap, usedIds);
        const label = buildEdgeLabel(edge, options.weightAttribute, maxLength);
        const hyperAnnotation = buildHyperEdgeAnnotation(edge);
        const combinedLabel = hyperAnnotation ? label ? `${label} ${hyperAnnotation}` : hyperAnnotation : label;
        const segment = combinedLabel ? ` -- "${combinedLabel}" --> ` : " --> ";
        lines.push(`${fromId}${segment}${toId}`);
    }
    return lines.join("\n");
}
function normaliseId(original, cache, used) {
    const existing = cache.get(original);
    if (existing) {
        return existing;
    }
    const base = original
        .trim()
        // Replace characters Mermaid cannot accept in identifiers with a safe
        // underscore placeholder.
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_{2,}/g, "_");
    const candidate = base.length > 0 ? base : "node";
    let finalId = candidate;
    let counter = 1;
    while (used.has(finalId)) {
        counter += 1;
        finalId = `${candidate}_${counter}`;
    }
    cache.set(original, finalId);
    used.add(finalId);
    return finalId;
}
function buildNodeLabel(node, fallbackAttribute, maxLength) {
    const candidates = [node.label];
    if (fallbackAttribute && typeof node.attributes?.[fallbackAttribute] === "string") {
        candidates.push(String(node.attributes?.[fallbackAttribute]));
    }
    if (typeof node.attributes?.label === "string") {
        candidates.push(String(node.attributes.label));
    }
    candidates.push(node.id);
    const raw = candidates.find((value) => value && value.trim().length > 0) ?? node.id;
    return truncateLabel(raw.trim(), maxLength);
}
function buildEdgeLabel(edge, weightAttribute, maxLength) {
    const candidates = [edge.label];
    if (typeof edge.weight === "number") {
        candidates.push(edge.weight);
    }
    if (weightAttribute) {
        candidates.push(edge.attributes?.[weightAttribute]);
    }
    if (typeof edge.attributes?.weight === "number") {
        candidates.push(edge.attributes.weight);
    }
    const raw = candidates.find((value) => value !== undefined && value !== null);
    if (raw === undefined || raw === null) {
        return null;
    }
    const text = typeof raw === "string" ? raw : String(raw);
    return truncateLabel(text.trim(), maxLength);
}
function buildHyperEdgeAnnotation(edge) {
    const identifier = edge.attributes?.hyper_edge_id;
    if (typeof identifier !== "string") {
        return null;
    }
    const trimmed = identifier.trim();
    if (!trimmed) {
        return null;
    }
    let annotation = `[H:${trimmed}`;
    const pairIndex = edge.attributes?.hyper_edge_pair_index;
    if (typeof pairIndex === "number" && Number.isFinite(pairIndex)) {
        annotation += `#${pairIndex}`;
    }
    const sourceCardinality = edge.attributes?.hyper_edge_source_cardinality;
    const targetCardinality = edge.attributes?.hyper_edge_target_cardinality;
    if (typeof sourceCardinality === "number" && Number.isFinite(sourceCardinality) && typeof targetCardinality === "number" && Number.isFinite(targetCardinality)) {
        annotation += ` ${sourceCardinality}->${targetCardinality}`;
    }
    annotation += "]";
    return escapeLabel(annotation);
}
function truncateLabel(label, maxLength) {
    if (label.length <= maxLength) {
        return escapeLabel(label);
    }
    const slice = label.slice(0, maxLength - 1).trimEnd();
    return `${escapeLabel(slice)}…`;
}
function escapeLabel(label) {
    // Escape backslashes first so subsequent replacements keep their semantics.
    return label
        .replace(/\\/g, "\\\\")
        .replace(/\r\n|\r|\n/g, "\\n")
        .replace(/"/g, '\\"')
        // Brackets occasionally appear in labels; escape them so Mermaid does not
        // mistake them for node syntax.
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        // Replace remaining control characters with spaces to keep the diagram
        // readable if unexpected values slip through.
        .replace(/[\u0000-\u001f]/g, " ");
}
