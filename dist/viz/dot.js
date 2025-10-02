import { GraphDescriptorSchema } from "../tools/graphTools.js";
/**
 * Render a graph descriptor as a GraphViz DOT document.
 *
 * The helper escapes identifiers and attributes to guard against malformed DOT
 * files while keeping the resulting structure deterministic and easy to diff.
 */
export function renderDotFromGraph(descriptor, options = {}) {
    const parsed = GraphDescriptorSchema.parse(descriptor);
    const directed = options.directed ?? true;
    const arrow = directed ? "->" : "--";
    const lines = [directed ? "digraph G {" : "graph G {"];
    lines.push("  graph [rankdir=LR];");
    for (const node of parsed.nodes) {
        const label = buildNodeLabel(node, options.labelAttribute);
        lines.push(`  ${escapeId(node.id)} [label="${label}"];`);
    }
    for (const edge of parsed.edges) {
        const attrs = [];
        const label = buildEdgeLabel(edge, options.weightAttribute);
        const hyperAnnotation = buildHyperEdgeAnnotation(edge);
        const combinedLabel = hyperAnnotation
            ? label
                ? `${label} ${hyperAnnotation}`
                : hyperAnnotation
            : label;
        if (combinedLabel) {
            attrs.push(`label=\"${combinedLabel}\"`);
        }
        const weight = resolveWeight(edge, options.weightAttribute);
        if (weight !== null) {
            attrs.push(`weight=${weight}`);
        }
        const attrSegment = attrs.length ? ` [${attrs.join(", ")}]` : "";
        lines.push(`  ${escapeId(edge.from)} ${arrow} ${escapeId(edge.to)}${attrSegment};`);
    }
    lines.push("}");
    return lines.join("\n");
}
function buildNodeLabel(node, fallbackAttribute) {
    const candidates = [node.label];
    if (fallbackAttribute && typeof node.attributes?.[fallbackAttribute] === "string") {
        candidates.push(String(node.attributes?.[fallbackAttribute]));
    }
    if (typeof node.attributes?.label === "string") {
        candidates.push(String(node.attributes.label));
    }
    candidates.push(node.id);
    const raw = candidates.find((value) => value && value.trim().length > 0) ?? node.id;
    return escapeString(raw.trim());
}
function buildEdgeLabel(edge, weightAttribute) {
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
    return escapeString(typeof raw === "string" ? raw : String(raw));
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
    if (typeof sourceCardinality === "number" &&
        Number.isFinite(sourceCardinality) &&
        typeof targetCardinality === "number" &&
        Number.isFinite(targetCardinality)) {
        annotation += ` ${sourceCardinality}->${targetCardinality}`;
    }
    annotation += "]";
    return escapeString(annotation);
}
function resolveWeight(edge, weightAttribute) {
    if (typeof edge.weight === "number" && Number.isFinite(edge.weight)) {
        return Number(edge.weight.toFixed(6));
    }
    if (weightAttribute) {
        const attr = edge.attributes?.[weightAttribute];
        if (typeof attr === "number" && Number.isFinite(attr)) {
            return Number(attr.toFixed(6));
        }
        if (typeof attr === "string") {
            const parsed = Number(attr);
            if (Number.isFinite(parsed)) {
                return Number(parsed.toFixed(6));
            }
        }
    }
    if (typeof edge.attributes?.weight === "number" && Number.isFinite(edge.attributes.weight)) {
        return Number(edge.attributes.weight.toFixed(6));
    }
    return null;
}
function escapeId(id) {
    return `"${escapeString(id)}"`;
}
function escapeString(value) {
    // DOT interprets backslashes and quotes, so we normalise the string to a
    // printable subset while keeping debugging details readable.
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\r\n|\r|\n/g, "\\n")
        .replace(/"/g, '\\"')
        .replace(/[\u0000-\u001f]/g, " ");
}
