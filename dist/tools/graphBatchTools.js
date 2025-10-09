import { z } from "zod";
import { GraphTransactionError, GraphVersionConflictError, } from "../graph/tx.js";
import { buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { ERROR_CODES } from "../types.js";
import { GraphMutateInputSchema, handleGraphMutate, normaliseGraphPayload, serialiseNormalisedGraph, } from "./graphTools.js";
import { resolveOperationId } from "./operationIds.js";
const GraphBatchOperationSchema = GraphMutateInputSchema.shape.operations.element;
/** Schema accepted by the `graph_batch_mutate` tool. */
export const GraphBatchMutateInputSchema = z
    .object({
    graph_id: z.string().min(1, "graph_id is required"),
    operations: z
        .array(GraphBatchOperationSchema)
        .min(1, "at least one operation must be provided")
        .max(200, "cannot apply more than 200 operations at once"),
    expected_version: z.number().int().nonnegative().optional(),
    owner: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(240).optional(),
    idempotency_key: z.string().min(1).optional(),
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
export const GraphBatchMutateInputShape = GraphBatchMutateInputSchema.shape;
/**
 * Applies a batch of idempotent graph operations on the latest committed
 * descriptor. The helper opens an ephemeral transaction, ensuring callers
 * observe the mutation atomically while replaying cached results when an
 * idempotency key is provided.
 */
export async function handleGraphBatchMutate(context, input) {
    const key = input.idempotency_key ?? null;
    const existingEntry = key && context.idempotency
        ? context.idempotency.peek(`graph_batch_mutate:${key}`)
        : null;
    const existingOpId = existingEntry?.value?.op_id;
    const opId = resolveOperationId(input.op_id ?? existingOpId, "graph_batch_mutate_op");
    const execute = async () => {
        const committed = context.transactions.getCommittedState(input.graph_id);
        if (!committed) {
            throw new GraphTransactionError(ERROR_CODES.TX_NOT_FOUND, "graph state unavailable", "commit an initial version before using graph_batch_mutate");
        }
        if (input.expected_version !== undefined && committed.version !== input.expected_version) {
            throw new GraphVersionConflictError(input.graph_id, committed.version, input.expected_version);
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
        let committedResult = null;
        try {
            const mutateInput = {
                graph: serialiseNormalisedGraph(tx.workingCopy),
                operations: input.operations,
            };
            const mutation = handleGraphMutate(mutateInput);
            const normalised = normaliseGraphPayload(mutation.graph);
            context.locks.assertCanMutate(input.graph_id, input.owner ?? null);
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
            const changed = mutation.applied.some((entry) => entry.changed);
            return {
                op_id: opId,
                graph_id: committedResult.graphId,
                base_version: tx.baseVersion,
                committed_version: committedResult.version,
                committed_at: committedResult.committedAt,
                changed,
                operations_applied: mutation.applied.length,
                applied: mutation.applied,
                graph: serialiseNormalisedGraph(committedResult.graph),
                owner: tx.owner,
                note: tx.note,
            };
        }
        catch (error) {
            try {
                context.transactions.rollback(tx.txId);
                context.resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
            }
            catch {
                // Ignored: the initial error is more relevant for callers.
            }
            throw error;
        }
    };
    if (context.idempotency && key) {
        const { op_id: _omitOpId, idempotency_key: _omitKey, ...fingerprint } = input;
        const cacheKey = buildIdempotencyCacheKey("graph_batch_mutate", key, fingerprint);
        const hit = await context.idempotency.remember(cacheKey, execute);
        const snapshot = hit.value;
        return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key };
    }
    const snapshot = await execute();
    return { ...snapshot, idempotent: false, idempotency_key: key };
}
//# sourceMappingURL=graphBatchTools.js.map