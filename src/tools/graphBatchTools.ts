import { z } from "zod";

import {
  GraphTransactionManager,
  GraphTransactionError,
  GraphVersionConflictError,
} from "../graph/tx.js";
import type { GraphLockManager } from "../graph/locks.js";
import type { ResourceRegistry } from "../resources/registry.js";
import { IdempotencyRegistry } from "../infra/idempotency.js";
import { ERROR_CODES } from "../types.js";
import {
  GraphMutateInputSchema,
  handleGraphMutate,
  normaliseGraphPayload,
  serialiseNormalisedGraph,
  type GraphMutateInput,
  type GraphMutationRecord,
} from "./graphTools.js";
import { resolveOperationId } from "./operationIds.js";

/** Context injected in the graph batch mutation handler. */
export interface GraphBatchToolContext {
  transactions: GraphTransactionManager;
  resources: ResourceRegistry;
  locks: GraphLockManager;
  idempotency?: IdempotencyRegistry;
}

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

export type GraphBatchMutateInput = z.infer<typeof GraphBatchMutateInputSchema>;

interface GraphBatchMutateSnapshot extends Record<string, unknown> {
  op_id: string;
  graph_id: string;
  base_version: number;
  committed_version: number;
  committed_at: number;
  changed: boolean;
  operations_applied: number;
  applied: GraphMutationRecord[];
  graph: ReturnType<typeof serialiseNormalisedGraph>;
  owner: string | null;
  note: string | null;
}

/** Result returned by {@link handleGraphBatchMutate}. */
export interface GraphBatchMutateResult extends GraphBatchMutateSnapshot {
  idempotent: boolean;
  idempotency_key: string | null;
}

/**
 * Applies a batch of idempotent graph operations on the latest committed
 * descriptor. The helper opens an ephemeral transaction, ensuring callers
 * observe the mutation atomically while replaying cached results when an
 * idempotency key is provided.
 */
export async function handleGraphBatchMutate(
  context: GraphBatchToolContext,
  input: GraphBatchMutateInput,
): Promise<GraphBatchMutateResult> {
  const key = input.idempotency_key ?? null;
  const existingEntry =
    key && context.idempotency
      ? context.idempotency.peek<GraphBatchMutateSnapshot>(`graph_batch_mutate:${key}`)
      : null;
  const existingOpId = existingEntry?.value?.op_id;
  const opId = resolveOperationId(input.op_id ?? existingOpId, "graph_batch_mutate_op");

  const execute = async (): Promise<GraphBatchMutateSnapshot> => {
    const committed = context.transactions.getCommittedState(input.graph_id);
    if (!committed) {
      throw new GraphTransactionError(
        ERROR_CODES.TX_NOT_FOUND,
        "graph state unavailable",
        "commit an initial version before using graph_batch_mutate",
      );
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

    let committedResult: ReturnType<GraphTransactionManager["commit"]> | null = null;
    try {
      const mutateInput: GraphMutateInput = {
        graph: serialiseNormalisedGraph(tx.workingCopy),
        operations: input.operations as GraphMutateInput["operations"],
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
    } catch (error) {
      try {
        context.transactions.rollback(tx.txId);
        context.resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
      } catch {
        // Ignored: the initial error is more relevant for callers.
      }
      throw error;
    }
  };

  if (context.idempotency && key) {
    const hit = await context.idempotency.remember<GraphBatchMutateSnapshot>(
      `graph_batch_mutate:${key}`,
      execute,
    );
    const snapshot = hit.value as GraphBatchMutateSnapshot;
    return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key };
  }

  const snapshot = await execute();
  return { ...snapshot, idempotent: false, idempotency_key: key };
}

