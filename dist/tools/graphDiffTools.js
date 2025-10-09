import { z } from "zod";
import { diffGraphs } from "../graph/diff.js";
import { applyGraphPatch } from "../graph/patch.js";
import { evaluateGraphInvariants, GraphInvariantError } from "../graph/invariants.js";
import { GraphTransactionError, GraphVersionConflictError, } from "../graph/tx.js";
import { ERROR_CODES } from "../types.js";
import { GraphDescriptorSchema, normaliseGraphPayload, serialiseNormalisedGraph, } from "./graphTools.js";
import { resolveOperationId } from "./operationIds.js";
/** Schema describing a graph selector used by the diff tool. */
const GraphSelectorSchema = z.union([
    z.object({ latest: z.literal(true) }).strict(),
    z.object({ version: z.number().int().nonnegative() }).strict(),
    z.object({ graph: GraphDescriptorSchema }).strict(),
]);
/** Schema describing a RFC 6902 operation accepted by graph_patch. */
export const GraphPatchOperationSchema = z
    .object({
    op: z.enum(["add", "remove", "replace"]),
    path: z.string().min(1, "path must not be empty"),
    value: z.unknown().optional(),
})
    .strict();
/** Schema accepted by the graph_diff tool. */
export const GraphDiffInputSchema = z
    .object({
    graph_id: z.string().min(1, "graph_id is required"),
    from: GraphSelectorSchema,
    to: GraphSelectorSchema,
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
/** Schema accepted by the graph_patch tool. */
export const GraphPatchInputSchema = z
    .object({
    graph_id: z.string().min(1, "graph_id is required"),
    base_version: z.number().int().nonnegative().optional(),
    owner: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(240).optional(),
    enforce_invariants: z.boolean().default(true),
    patch: z.array(GraphPatchOperationSchema).min(1, "at least one patch operation is required"),
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
export const GraphDiffInputShape = GraphDiffInputSchema.shape;
export const GraphPatchInputShape = GraphPatchInputSchema.shape;
/** Compute a diff between two graph selectors. */
export function handleGraphDiff(context, input) {
    const opId = resolveOperationId(input.op_id, "graph_diff_op");
    const resolvedFrom = resolveGraphSelector(context, input.graph_id, input.from);
    const resolvedTo = resolveGraphSelector(context, input.graph_id, input.to);
    const diff = diffGraphs(resolvedFrom.graph, resolvedTo.graph);
    return {
        op_id: opId,
        graph_id: input.graph_id,
        from: resolvedFrom.summary,
        to: resolvedTo.summary,
        changed: diff.changed,
        operations: diff.operations,
        summary: diff.summary,
    };
}
/** Apply a JSON Patch on top of the latest committed graph. */
export function handleGraphPatch(context, input) {
    const opId = resolveOperationId(input.op_id, "graph_patch_op");
    const committed = ensureCommittedState(context, input.graph_id);
    if (input.base_version !== undefined && input.base_version !== committed.version) {
        throw new GraphVersionConflictError(input.graph_id, committed.version, input.base_version);
    }
    context.locks.assertCanMutate(input.graph_id, input.owner ?? null);
    const tx = context.transactions.begin(committed.graph, {
        owner: input.owner ?? null,
        note: input.note ?? null,
    });
    context.resources.recordGraphSnapshot({
        graphId: tx.graphId,
        txId: tx.txId,
        baseVersion: tx.baseVersion,
        startedAt: tx.startedAt,
        graph: tx.workingCopy,
        owner: tx.owner,
        note: tx.note,
        expiresAt: tx.expiresAt,
    });
    let invariants = null;
    let committedResult = null;
    try {
        const patched = applyGraphPatch(committed.graph, input.patch);
        const normalised = normaliseGraphPayload(serialiseNormalisedGraph(patched));
        if (input.enforce_invariants) {
            invariants = evaluateGraphInvariants(normalised);
            if (!invariants.ok) {
                throw new GraphInvariantError(invariants.violations);
            }
        }
        const diff = diffGraphs(committed.graph, normalised);
        const changed = diff.changed;
        context.locks.assertCanMutate(input.graph_id, input.owner ?? null);
        context.transactions.setWorkingCopy(tx.txId, normalised);
        committedResult = context.transactions.commit(tx.txId, normalised);
        context.resources.markGraphSnapshotCommitted({
            graphId: committedResult.graphId,
            txId: committedResult.txId,
            committedAt: committedResult.committedAt,
            finalVersion: committedResult.version,
            finalGraph: committedResult.graph,
        });
        context.resources.recordGraphVersion({
            graphId: committedResult.graphId,
            version: committedResult.version,
            committedAt: committedResult.committedAt,
            graph: committedResult.graph,
        });
        return {
            op_id: opId,
            graph_id: committedResult.graphId,
            base_version: tx.baseVersion,
            committed_version: committedResult.version,
            changed,
            operations_applied: input.patch.length,
            invariants,
            graph: serialiseNormalisedGraph(committedResult.graph),
        };
    }
    catch (error) {
        try {
            context.transactions.rollback(tx.txId);
        }
        catch (rollbackError) {
            // Ignored: the transaction has already failed, the caller is primarily interested in the original error.
            void rollbackError;
        }
        context.resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
        throw error;
    }
}
/** Resolve a selector into a normalised graph and a descriptive summary. */
function resolveGraphSelector(context, graphId, selector) {
    if ("graph" in selector) {
        const normalised = normaliseGraphPayload(selector.graph);
        return {
            graph: normalised,
            summary: { source: "descriptor", version: normalised.graphVersion ?? null },
        };
    }
    if ("version" in selector) {
        const resource = context.resources.read(`sc://graphs/${graphId}@v${selector.version}`);
        const payload = resource.payload;
        return {
            graph: structuredClone(payload.graph),
            summary: { source: "version", version: payload.version },
        };
    }
    const resource = context.resources.read(`sc://graphs/${graphId}`);
    const payload = resource.payload;
    return {
        graph: structuredClone(payload.graph),
        summary: { source: "latest", version: payload.version },
    };
}
/** Ensure the transaction manager knows about the latest committed graph state. */
function ensureCommittedState(context, graphId) {
    const committed = context.transactions.getCommittedState(graphId);
    if (committed) {
        return { graph: committed.graph, version: committed.version };
    }
    const resource = context.resources.read(`sc://graphs/${graphId}`);
    const payload = resource.payload;
    bootstrapCommittedState(context.transactions, payload.graph);
    const refreshed = context.transactions.getCommittedState(graphId);
    if (!refreshed) {
        throw new GraphTransactionError(ERROR_CODES.TX_UNEXPECTED, "failed to register graph state", "retry once the transaction manager has been initialised");
    }
    return { graph: refreshed.graph, version: refreshed.version };
}
/** Register a committed graph in the transaction manager without mutating it. */
function bootstrapCommittedState(transactions, graph) {
    let tx = null;
    try {
        tx = transactions.begin(graph);
    }
    finally {
        if (tx) {
            try {
                transactions.rollback(tx.txId);
            }
            catch (error) {
                void error;
            }
        }
    }
}
//# sourceMappingURL=graphDiffTools.js.map