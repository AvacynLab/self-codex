import { GraphDescriptorSchema } from "../tools/graphTools.js";
/**
 * Render the graph as a GraphML document compatible with common visualisation
 * tools such as yEd or Gephi. The helper keeps the XML minimal yet valid by
 * escaping identifiers and only serialising primitive attributes.
 */
export function renderGraphmlFromGraph(descriptor, options = {}) {
    const parsed = GraphDescriptorSchema.parse(descriptor);
    const lines = [];
    lines.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    lines.push("<graphml xmlns=\"http://graphml.graphdrawing.org/xmlns\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">");
    lines.push("  <graph edgedefault=\"directed\">");
    for (const node of parsed.nodes) {
        const label = buildNodeLabel(node, options.labelAttribute);
        lines.push(`    <node id=\"${escapeXml(node.id)}\">`);
        lines.push(`      <data key=\"label\">${escapeXml(label)}</data>`);
        for (const [key, value] of Object.entries(node.attributes ?? {})) {
            if (isPrimitive(value)) {
                lines.push(`      <data key=\"${escapeXml(key)}\">${escapeXml(String(value))}</data>`);
            }
        }
        lines.push("    </node>");
    }
    for (const edge of parsed.edges) {
        lines.push(`    <edge source=\"${escapeXml(edge.from)}\" target=\"${escapeXml(edge.to)}\">`);
        if (edge.label) {
            lines.push(`      <data key=\"label\">${escapeXml(edge.label)}</data>`);
        }
        const weight = resolveWeight(edge, options.weightAttribute);
        if (weight !== null) {
            lines.push(`      <data key=\"weight\">${escapeXml(String(weight))}</data>`);
        }
        for (const [key, value] of Object.entries(edge.attributes ?? {})) {
            if (isPrimitive(value)) {
                lines.push(`      <data key=\"${escapeXml(key)}\">${escapeXml(String(value))}</data>`);
            }
        }
        lines.push("    </edge>");
    }
    lines.push("  </graph>");
    lines.push("</graphml>");
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
    return raw.trim();
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
function isPrimitive(value) {
    return (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean");
}
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
