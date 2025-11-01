import { z } from "zod";
import { GraphTransactionError, GraphVersionConflictError, } from "../graph/tx.js";
import { buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { GraphMutateInputSchema, handleGraphMutate, } from "./graph/mutate.js";
import { normaliseGraphPayload, serialiseNormalisedGraph, GraphDescriptorSchema } from "./graph/snapshot.js";
import { GraphValidationError, validateGraph, assertValidGraph } from "../graph/validate.js";
import { recordOperation } from "../graph/oplog.js";
import { fireAndForgetGraphWal } from "../graph/wal.js";
import { diffGraphs } from "../graph/diff.js";
import { ERROR_CODES } from "../types.js";
import { resolveOperationId } from "./operationIds.js";
/** Schema accepted by the `tx_begin` tool. */
export const TxBeginInputSchema = z
    .object({
    graph_id: z.string().min(1, "graph_id is required"),
    expected_version: z.number().int().nonnegative().optional(),
    owner: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(240).optional(),
    ttl_ms: z.number().int().positive().max(86_400_000).optional(),
    graph: GraphDescriptorSchema.optional(),
    idempotency_key: z.string().min(1).optional(),
    // Optional correlation identifier propagated through events/logs.
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
/** Schema accepted by the `tx_apply` tool. */
export const TxApplyInputSchema = z
    .object({
    tx_id: z.string().uuid(),
    operations: z
        .array(GraphMutateInputSchema.shape.operations.element)
        .min(1, "at least one operation must be provided"),
    // Optional correlation identifier propagated through events/logs.
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
/** Schema accepted by the `tx_commit` tool. */
export const TxCommitInputSchema = z
    .object({
    tx_id: z.string().uuid(),
    // Optional correlation identifier propagated through events/logs.
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
/** Schema accepted by the `tx_rollback` tool. */
export const TxRollbackInputSchema = z
    .object({
    tx_id: z.string().uuid(),
    // Optional correlation identifier propagated through events/logs.
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
export const TxBeginInputShape = TxBeginInputSchema.shape;
export const TxApplyInputShape = TxApplyInputSchema.shape;
export const TxCommitInputShape = TxCommitInputSchema.shape;
export const TxRollbackInputShape = TxRollbackInputSchema.shape;
/** Opens a new transaction, returning a working copy that can be mutated server-side. */
export function handleTxBegin(context, input) {
    const opId = resolveOperationId(input.op_id, "tx_begin_op");
    const execute = () => {
        const baseGraph = resolveBaseGraph(context, input);
        // Validate the provided or committed base graph before opening the transaction.
        const validation = validateGraph(baseGraph);
        if (!validation.ok) {
            throw new GraphValidationError(validation.violations, validation.invariants);
        }
        if (input.expected_version !== undefined && baseGraph.graphVersion !== input.expected_version) {
            throw new GraphVersionConflictError(input.graph_id, baseGraph.graphVersion, input.expected_version);
        }
        context.locks.assertCanMutate(input.graph_id, input.owner ?? null);
        const opened = context.transactions.begin(baseGraph, {
            owner: input.owner ?? null,
            note: input.note ?? null,
            ttlMs: input.ttl_ms ?? null,
        });
        context.resources.recordGraphSnapshot({
            graphId: opened.graphId,
            txId: opened.txId,
            baseVersion: opened.baseVersion,
            startedAt: opened.startedAt,
            graph: opened.workingCopy,
            owner: opened.owner,
            note: opened.note,
            expiresAt: opened.expiresAt,
        });
        fireAndForgetGraphWal("tx_begin_tool", {
            tx_id: opened.txId,
            graph_id: opened.graphId,
            op_id: opId,
            base_version: opened.baseVersion,
            owner: opened.owner,
            note: opened.note,
            expires_at: opened.expiresAt,
            idempotency_key: input.idempotency_key ?? null,
        });
        return formatBeginResult(opened, opId);
    };
    const key = input.idempotency_key ?? null;
    if (context.idempotency && key) {
        const { op_id: _omitOpId, idempotency_key: _omitKey, ...fingerprint } = input;
        const cacheKey = buildIdempotencyCacheKey("tx_begin", key, fingerprint);
        const hit = context.idempotency.rememberSync(cacheKey, execute);
        const snapshot = hit.value;
        return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key };
    }
    const snapshot = execute();
    return { ...snapshot, idempotent: false, idempotency_key: key };
}
/** Applies graph operations to the transaction working copy. */
export function handleTxApply(context, input) {
    const opId = resolveOperationId(input.op_id, "tx_apply_op");
    // Retrieve a defensive copy so mutations occur on a fresh descriptor.
    const workingCopy = context.transactions.getWorkingCopy(input.tx_id);
    const metadata = context.transactions.describe(input.tx_id);
    context.locks.assertCanMutate(metadata.graphId, metadata.owner);
    const mutateInput = {
        graph: serialiseNormalisedGraph(workingCopy),
        operations: input.operations,
    };
    const result = handleGraphMutate(mutateInput);
    const normalisedGraph = normaliseGraphPayload(result.graph);
    const validation = validateGraph(normalisedGraph);
    if (!validation.ok) {
        throw new GraphValidationError(validation.violations, validation.invariants);
    }
    const invariants = (validation.invariants ?? { ok: true });
    context.transactions.setWorkingCopy(input.tx_id, normalisedGraph);
    const changed = result.applied.some((entry) => entry.changed);
    const previewVersion = changed ? metadata.baseVersion + 1 : metadata.baseVersion;
    const diff = diffGraphs(workingCopy, normalisedGraph);
    void recordOperation({
        kind: "tx_apply",
        graph_id: metadata.graphId,
        op_id: opId,
        operations: input.operations.length,
        changed,
    }, input.tx_id);
    fireAndForgetGraphWal("tx_apply", {
        tx_id: input.tx_id,
        graph_id: metadata.graphId,
        op_id: opId,
        operations: input.operations.length,
        changed,
        owner: metadata.owner,
        note: metadata.note,
    });
    return {
        op_id: opId,
        tx_id: input.tx_id,
        graph_id: metadata.graphId,
        base_version: metadata.baseVersion,
        preview_version: previewVersion,
        owner: metadata.owner,
        note: metadata.note,
        expires_at: metadata.expiresAt,
        changed,
        applied: result.applied,
        diff: diff.operations,
        diff_summary: diff.summary,
        graph: result.graph,
        invariants,
    };
}
/** Commits the transaction, returning the updated graph descriptor. */
export function handleTxCommit(context, input) {
    const opId = resolveOperationId(input.op_id, "tx_commit_op");
    const metadata = context.transactions.describe(input.tx_id);
    context.locks.assertCanMutate(metadata.graphId, metadata.owner);
    const workingCopy = context.transactions.getWorkingCopy(input.tx_id);
    assertValidGraph(workingCopy);
    const committed = context.transactions.commit(input.tx_id, workingCopy);
    context.resources.markGraphSnapshotCommitted({
        graphId: committed.graphId,
        txId: committed.txId,
        committedAt: committed.committedAt,
        finalVersion: committed.version,
        finalGraph: committed.graph,
    });
    context.resources.recordGraphVersion({
        graphId: committed.graphId,
        version: committed.version,
        committedAt: committed.committedAt,
        graph: committed.graph,
    });
    fireAndForgetGraphWal("tx_commit_tool", {
        tx_id: committed.txId,
        graph_id: committed.graphId,
        op_id: opId,
        committed_version: committed.version,
        committed_at: committed.committedAt,
        owner: metadata.owner,
        note: metadata.note,
    });
    return {
        op_id: opId,
        tx_id: committed.txId,
        graph_id: committed.graphId,
        version: committed.version,
        committed_at: committed.committedAt,
        graph: serialiseNormalisedGraph(committed.graph),
    };
}
/** Rolls back the transaction, returning the original snapshot. */
export function handleTxRollback(context, input) {
    const opId = resolveOperationId(input.op_id, "tx_rollback_op");
    const rolled = context.transactions.rollback(input.tx_id);
    context.resources.markGraphSnapshotRolledBack(rolled.graphId, rolled.txId);
    fireAndForgetGraphWal("tx_rollback_tool", {
        tx_id: rolled.txId,
        graph_id: rolled.graphId,
        op_id: opId,
        base_version: rolled.version,
        rolled_back_at: rolled.rolledBackAt,
    });
    return {
        op_id: opId,
        tx_id: rolled.txId,
        graph_id: rolled.graphId,
        version: rolled.version,
        rolled_back_at: rolled.rolledBackAt,
        snapshot: serialiseNormalisedGraph(rolled.snapshot),
    };
}
function formatBeginResult(opened, opId) {
    return {
        op_id: opId,
        tx_id: opened.txId,
        graph_id: opened.graphId,
        base_version: opened.baseVersion,
        started_at: opened.startedAt,
        owner: opened.owner,
        note: opened.note,
        expires_at: opened.expiresAt,
        graph: serialiseNormalisedGraph(opened.workingCopy),
    };
}
/**
 * Retrieves the base graph used to open a transaction, either from the request
 * payload or from the committed state tracked by the manager/registry.
 */
function resolveBaseGraph(context, input) {
    if (input.graph) {
        const normalised = normaliseGraphPayload(input.graph);
        if (normalised.graphId !== input.graph_id) {
            throw new GraphTransactionError(ERROR_CODES.TX_INVALID_INPUT, "graph payload mismatch", "ensure graph_id matches descriptor");
        }
        return normalised;
    }
    const state = context.transactions.getCommittedState(input.graph_id);
    if (state) {
        return state.graph;
    }
    try {
        const resource = context.resources.read(`sc://graphs/${input.graph_id}`);
        if (resource.kind !== "graph") {
            throw new GraphTransactionError(ERROR_CODES.TX_NOT_FOUND, "graph unavailable", "publish the graph via resources before opening transactions");
        }
        const payload = resource.payload;
        return structuredClone(payload.graph);
    }
    catch (error) {
        if (error instanceof GraphTransactionError) {
            throw error;
        }
        throw new GraphTransactionError(ERROR_CODES.TX_UNEXPECTED, error instanceof Error ? error.message : "graph lookup failed", "retry once the registry becomes reachable");
    }
}
//# sourceMappingURL=txTools.js.map