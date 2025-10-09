import { z } from "zod";

import {
  GraphTransactionManager,
  GraphTransactionError,
  GraphVersionConflictError,
  type BeginTransactionResult,
} from "../graph/tx.js";
import type { GraphLockManager } from "../graph/locks.js";
import { IdempotencyRegistry, buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { normaliseGraphPayload, serialiseNormalisedGraph, GraphDescriptorSchema, GraphMutateInputSchema, handleGraphMutate } from "./graphTools.js";
import type { GraphMutateInput } from "./graphTools.js";
import type { ResourceGraphPayload, ResourceRegistry } from "../resources/registry.js";
import type { NormalisedGraph } from "../graph/types.js";
import { evaluateGraphInvariants, GraphInvariantError, type GraphInvariantReport } from "../graph/invariants.js";
import { diffGraphs } from "../graph/diff.js";
import { ERROR_CODES } from "../types.js";
import { resolveOperationId } from "./operationIds.js";

/** Context injected in the transaction tool handlers. */
export interface TxToolContext {
  /** Shared transaction manager guarding optimistic concurrency. */
  transactions: GraphTransactionManager;
  /** Resource registry capturing snapshots and committed versions. */
  resources: ResourceRegistry;
  /** Cooperative lock manager guarding graph mutations. */
  locks: GraphLockManager;
  /** Optional idempotency registry replaying cached transaction descriptors. */
  idempotency?: IdempotencyRegistry;
}

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

export type TxBeginInput = z.infer<typeof TxBeginInputSchema>;
export type TxApplyInput = z.infer<typeof TxApplyInputSchema>;
export type TxCommitInput = z.infer<typeof TxCommitInputSchema>;
export type TxRollbackInput = z.infer<typeof TxRollbackInputSchema>;

/** Result returned by {@link handleTxBegin}. */
export interface TxBeginResult {
  /** Correlation identifier propagated back to clients. */
  op_id: string;
  tx_id: string;
  graph_id: string;
  base_version: number;
  started_at: number;
  owner: string | null;
  note: string | null;
  expires_at: number | null;
  graph: ReturnType<typeof serialiseNormalisedGraph>;
  idempotent: boolean;
  idempotency_key: string | null;
}

/** Result returned by {@link handleTxApply}. */
export interface TxApplyResult {
  /** Correlation identifier propagated back to clients. */
  op_id: string;
  tx_id: string;
  graph_id: string;
  base_version: number;
  /** Indicates the optimistic version the graph would reach if committed. */
  preview_version: number;
  owner: string | null;
  note: string | null;
  expires_at: number | null;
  /** Set to true when at least one operation mutated the working copy. */
  changed: boolean;
  applied: ReturnType<typeof handleGraphMutate>["applied"];
  /**
   * JSON Patch transforming the pre-mutation working copy into the updated
   * descriptor. Aligns with the documentation examples so external clients can
   * consume previews without bespoke conversions.
   */
  diff: ReturnType<typeof diffGraphs>["operations"];
  /** Aggregated summary of the high-level sections impacted by the batch. */
  diff_summary: ReturnType<typeof diffGraphs>["summary"];
  graph: ReturnType<typeof serialiseNormalisedGraph>;
  invariants: GraphInvariantReport;
}

/** Result returned by {@link handleTxCommit}. */
export interface TxCommitResult {
  /** Correlation identifier propagated back to clients. */
  op_id: string;
  tx_id: string;
  graph_id: string;
  version: number;
  committed_at: number;
  graph: ReturnType<typeof serialiseNormalisedGraph>;
}

/** Result returned by {@link handleTxRollback}. */
export interface TxRollbackResult {
  /** Correlation identifier propagated back to clients. */
  op_id: string;
  tx_id: string;
  graph_id: string;
  version: number;
  rolled_back_at: number;
  snapshot: ReturnType<typeof serialiseNormalisedGraph>;
}

/** Opens a new transaction, returning a working copy that can be mutated server-side. */
export function handleTxBegin(context: TxToolContext, input: TxBeginInput): TxBeginResult {
  const opId = resolveOperationId(input.op_id, "tx_begin_op");
  const execute = (): TxBeginSnapshot => {
    const baseGraph = resolveBaseGraph(context, input);
    // Validate the provided or committed base graph before opening the transaction.
    const invariants = evaluateGraphInvariants(baseGraph);
    if (!invariants.ok) {
      throw new GraphInvariantError(invariants.violations);
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

    return formatBeginResult(opened, opId);
  };

  const key = input.idempotency_key ?? null;
  if (context.idempotency && key) {
    const { op_id: _omitOpId, idempotency_key: _omitKey, ...fingerprint } = input;
    const cacheKey = buildIdempotencyCacheKey("tx_begin", key, fingerprint);
    const hit = context.idempotency.rememberSync<TxBeginSnapshot>(cacheKey, execute);
    const snapshot = hit.value as TxBeginSnapshot;
    return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key } as TxBeginResult;
  }

  const snapshot = execute();
  return { ...snapshot, idempotent: false, idempotency_key: key } as TxBeginResult;
}

/** Applies graph operations to the transaction working copy. */
export function handleTxApply(context: TxToolContext, input: TxApplyInput): TxApplyResult {
  const opId = resolveOperationId(input.op_id, "tx_apply_op");
  // Retrieve a defensive copy so mutations occur on a fresh descriptor.
  const workingCopy = context.transactions.getWorkingCopy(input.tx_id);
  const metadata = context.transactions.describe(input.tx_id);

  context.locks.assertCanMutate(metadata.graphId, metadata.owner);

  const mutateInput: GraphMutateInput = {
    graph: serialiseNormalisedGraph(workingCopy),
    operations: input.operations as GraphMutateInput["operations"],
  };
  const result = handleGraphMutate(mutateInput);
  const normalisedGraph = normaliseGraphPayload(result.graph);
  const invariants = evaluateGraphInvariants(normalisedGraph);
  if (!invariants.ok) {
    throw new GraphInvariantError(invariants.violations);
  }
  context.transactions.setWorkingCopy(input.tx_id, normalisedGraph);

  const changed = result.applied.some((entry) => entry.changed);
  const previewVersion = changed ? metadata.baseVersion + 1 : metadata.baseVersion;
  const diff = diffGraphs(workingCopy, normalisedGraph);

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
  } satisfies TxApplyResult;
}

/** Commits the transaction, returning the updated graph descriptor. */
export function handleTxCommit(context: TxToolContext, input: TxCommitInput): TxCommitResult {
  const opId = resolveOperationId(input.op_id, "tx_commit_op");
  const metadata = context.transactions.describe(input.tx_id);
  context.locks.assertCanMutate(metadata.graphId, metadata.owner);

  const workingCopy = context.transactions.getWorkingCopy(input.tx_id);
  const invariants = evaluateGraphInvariants(workingCopy);
  if (!invariants.ok) {
    throw new GraphInvariantError(invariants.violations);
  }
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
export function handleTxRollback(context: TxToolContext, input: TxRollbackInput): TxRollbackResult {
  const opId = resolveOperationId(input.op_id, "tx_rollback_op");
  const rolled = context.transactions.rollback(input.tx_id);
  context.resources.markGraphSnapshotRolledBack(rolled.graphId, rolled.txId);
  return {
    op_id: opId,
    tx_id: rolled.txId,
    graph_id: rolled.graphId,
    version: rolled.version,
    rolled_back_at: rolled.rolledBackAt,
    snapshot: serialiseNormalisedGraph(rolled.snapshot),
  };
}

/** Formats the begin result into the tool payload. */
type TxBeginSnapshot = Omit<TxBeginResult, "idempotent" | "idempotency_key">;

function formatBeginResult(opened: BeginTransactionResult, opId: string): TxBeginSnapshot {
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
function resolveBaseGraph(context: TxToolContext, input: TxBeginInput): NormalisedGraph {
  if (input.graph) {
    const normalised = normaliseGraphPayload(input.graph);
    if (normalised.graphId !== input.graph_id) {
      throw new GraphTransactionError(
        ERROR_CODES.TX_INVALID_INPUT,
        "graph payload mismatch",
        "ensure graph_id matches descriptor",
      );
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
      throw new GraphTransactionError(
        ERROR_CODES.TX_NOT_FOUND,
        "graph unavailable",
        "publish the graph via resources before opening transactions",
      );
    }
    const payload = resource.payload as ResourceGraphPayload;
    return structuredClone(payload.graph) as NormalisedGraph;
  } catch (error) {
    if (error instanceof GraphTransactionError) {
      throw error;
    }
    throw new GraphTransactionError(
      ERROR_CODES.TX_UNEXPECTED,
      error instanceof Error ? error.message : "graph lookup failed",
      "retry once the registry becomes reachable",
    );
  }
}
