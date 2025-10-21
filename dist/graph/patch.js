import { coerceNullToUndefined } from "../utils/object.js";
/** Error thrown when a JSON Patch cannot be applied to the graph document. */
export class GraphPatchApplyError extends Error {
    path;
    constructor(message, path) {
        super(message);
        this.path = path;
        this.name = "GraphPatchApplyError";
    }
}
/**
 * Apply JSON Patch operations on top of a normalised graph. The helper keeps the
 * graph identifier and version untouched so {@link GraphTransactionManager}
 * remains the single authority deciding when versions get incremented.
 */
export function applyGraphPatch(base, patch) {
    const document = toDocument(base);
    for (const operation of patch) {
        applyOperation(document, operation);
    }
    return fromDocument(document, base);
}
/** Convert a {@link NormalisedGraph} into a mutable document representation. */
function toDocument(graph) {
    return {
        name: graph.name ?? "",
        metadata: cloneRecord(graph.metadata ?? {}),
        nodes: graph.nodes.map((node) => ({
            id: node.id,
            label: node.label ?? null,
            attributes: cloneRecord(node.attributes ?? {}),
        })),
        edges: graph.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            label: edge.label ?? null,
            weight: typeof edge.weight === "number" ? Number(edge.weight) : null,
            attributes: cloneRecord(edge.attributes ?? {}),
        })),
    };
}
/** Convert the mutable document back into a normalised graph descriptor. */
function fromDocument(document, base) {
    return {
        name: document.name,
        graphId: base.graphId,
        graphVersion: base.graphVersion,
        metadata: cloneRecord(document.metadata),
        nodes: document.nodes.map((node) => ({
            id: node.id,
            label: coerceNullToUndefined(node.label),
            attributes: cloneRecord(node.attributes),
        })),
        edges: document.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            label: coerceNullToUndefined(edge.label),
            weight: coerceNullToUndefined(edge.weight),
            attributes: cloneRecord(edge.attributes),
        })),
    };
}
/** Apply a single JSON Patch operation to the provided document. */
function applyOperation(document, operation) {
    const segments = parsePointer(operation.path);
    if (segments.length === 0) {
        throw new GraphPatchApplyError("root operations are not supported", operation.path);
    }
    switch (operation.op) {
        case "replace":
            replaceAtPointer(document, segments, operation.path, operation.value);
            break;
        case "add":
            addAtPointer(document, segments, operation.path, operation.value);
            break;
        case "remove":
            removeAtPointer(document, segments, operation.path);
            break;
        default:
            throw new GraphPatchApplyError(`unsupported operation '${operation.op}'`, operation.path);
    }
}
/** Replace a value located at the JSON pointer. */
function replaceAtPointer(document, segments, path, value) {
    const parent = resolveContainer(document, segments.slice(0, -1), path);
    const key = segments.at(-1);
    if (Array.isArray(parent)) {
        const index = parseIndex(key, path, parent.length - 1);
        parent[index] = cloneValue(value);
    }
    else {
        parent[key] = cloneValue(value);
    }
}
/** Add a value at the pointer location (for objects only). */
function addAtPointer(document, segments, path, value) {
    const parent = resolveContainer(document, segments.slice(0, -1), path);
    const key = segments.at(-1);
    if (Array.isArray(parent)) {
        if (key === "-") {
            parent.push(cloneValue(value));
        }
        else {
            const index = parseIndex(key, path, parent.length);
            parent.splice(index, 0, cloneValue(value));
        }
    }
    else {
        if (Object.prototype.hasOwnProperty.call(parent, key)) {
            throw new GraphPatchApplyError(`key '${key}' already exists`, path);
        }
        parent[key] = cloneValue(value);
    }
}
/** Remove the value stored at the pointer location. */
function removeAtPointer(document, segments, path) {
    const parent = resolveContainer(document, segments.slice(0, -1), path);
    const key = segments.at(-1);
    if (Array.isArray(parent)) {
        const index = parseIndex(key, path, parent.length - 1);
        parent.splice(index, 1);
    }
    else {
        if (!Object.prototype.hasOwnProperty.call(parent, key)) {
            throw new GraphPatchApplyError(`key '${key}' does not exist`, path);
        }
        delete parent[key];
    }
}
/** Resolve the container referenced by the pointer segments. */
function resolveContainer(document, segments, path) {
    let current = document;
    for (const segment of segments) {
        if (Array.isArray(current)) {
            const index = parseIndex(segment, path, current.length - 1);
            current = current[index];
        }
        else if (typeof current === "object" && current !== null) {
            if (!Object.prototype.hasOwnProperty.call(current, segment)) {
                throw new GraphPatchApplyError(`path '${path}' is invalid`, path);
            }
            current = current[segment];
        }
        else {
            throw new GraphPatchApplyError(`path '${path}' cannot be resolved`, path);
        }
    }
    if (!Array.isArray(current) && typeof current !== "object") {
        throw new GraphPatchApplyError(`path '${path}' does not reference a container`, path);
    }
    return current;
}
/** Parse a JSON pointer into individual segments. */
function parsePointer(pointer) {
    if (!pointer.startsWith("/")) {
        throw new GraphPatchApplyError("JSON pointer must start with '/'", pointer);
    }
    if (pointer === "/") {
        return [];
    }
    return pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}
/** Parse and validate an array index. */
function parseIndex(segment, path, max) {
    if (!/^\d+$/.test(segment)) {
        throw new GraphPatchApplyError(`segment '${segment}' is not a valid index`, path);
    }
    const index = Number(segment);
    if (index < 0 || index > max) {
        throw new GraphPatchApplyError(`index '${index}' is out of bounds`, path);
    }
    return index;
}
/** Deep clone a graph attribute record. */
function cloneRecord(values) {
    const result = {};
    for (const [key, value] of Object.entries(values)) {
        result[key] = value;
    }
    return result;
}
/** Clone arbitrary JSON-compatible values. */
function cloneValue(value) {
    return structuredClone(value);
}
//# sourceMappingURL=patch.js.map