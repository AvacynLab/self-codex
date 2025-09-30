/**
 * Convert an orchestrator snapshot into a `GraphDescriptorPayload` usable by the
 * graph tooling layer. Only primitive attributes are preserved to guarantee the
 * descriptor remains serialisable as JSON without surprises.
 */
export function snapshotToGraphDescriptor(snapshot, options = {}) {
    const name = options.name ?? "orchestrator";
    const nodes = snapshot.nodes.map((node) => {
        const attributes = filterPrimitiveAttributes(node.attributes ?? {});
        const labelCandidates = [
            typeof attributes.label === "string" ? String(attributes.label) : undefined,
            options.labelAttribute && typeof attributes[options.labelAttribute] === "string"
                ? String(attributes[options.labelAttribute])
                : undefined,
            typeof attributes.name === "string" ? String(attributes.name) : undefined,
        ];
        const label = labelCandidates.find((value) => value && value.trim().length > 0);
        return {
            id: node.id,
            label: label?.trim(),
            attributes,
        };
    });
    const edges = snapshot.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: typeof edge.attributes?.label === "string" ? String(edge.attributes.label) : undefined,
        weight: typeof edge.attributes?.weight === "number" && Number.isFinite(edge.attributes.weight)
            ? Number(edge.attributes.weight)
            : undefined,
        attributes: filterPrimitiveAttributes(edge.attributes ?? {}),
    }));
    const metadata = filterPrimitiveAttributes(snapshot.directives ?? {});
    return { name, nodes, edges, metadata };
}
function filterPrimitiveAttributes(source) {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            result[key] = value;
        }
    }
    return result;
}
