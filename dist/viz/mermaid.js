import { GraphDescriptorSchema } from "../tools/graphTools.js";
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
    const lines = [`graph ${direction}`];
    for (const node of parsed.nodes) {
        const normalisedId = normaliseId(node.id, idMap);
        const label = buildNodeLabel(node, options.labelAttribute, maxLength);
        lines.push(`${normalisedId}["${label}"]`);
    }
    for (const edge of parsed.edges) {
        const fromId = idMap.get(edge.from) ?? normaliseId(edge.from, idMap);
        const toId = idMap.get(edge.to) ?? normaliseId(edge.to, idMap);
        const label = buildEdgeLabel(edge, options.weightAttribute, maxLength);
        const segment = label ? ` -- "${label}" --> ` : " --> ";
        lines.push(`${fromId}${segment}${toId}`);
    }
    return lines.join("\n");
}
function normaliseId(original, cache) {
    const existing = cache.get(original);
    if (existing) {
        return existing;
    }
    const base = original
        .trim()
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .replace(/_{2,}/g, "_");
    const candidate = base.length > 0 ? base : "node";
    let finalId = candidate;
    let counter = 1;
    while ([...cache.values()].includes(finalId)) {
        counter += 1;
        finalId = `${candidate}_${counter}`;
    }
    cache.set(original, finalId);
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
function truncateLabel(label, maxLength) {
    if (label.length <= maxLength) {
        return escapeLabel(label);
    }
    const slice = label.slice(0, maxLength - 1).trimEnd();
    return `${escapeLabel(slice)}…`;
}
function escapeLabel(label) {
    return label.replace(/"/g, '\\"');
}
