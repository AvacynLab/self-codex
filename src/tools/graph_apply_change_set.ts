import { randomUUID } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { JsonPatchOperation } from "../graph/diff.js";
import { GraphLockManager } from "../graph/locks.js";
import {
  GraphTransactionManager,
  GraphTransactionError,
  GraphVersionConflictError,
} from "../graph/tx.js";
import type { GraphValidationError } from "../graph/validate.js";
import type { NormalisedGraph } from "../graph/types.js";
import { recordOperation } from "../graph/oplog.js";
import { recordGraphWal } from "../graph/wal.js";
import type { ResourceRegistry } from "../resources/registry.js";
import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { IdempotencyRegistry, buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { computeGraphChangeSet, type GraphChangeSetComputation } from "../infra/graphChangeSet.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import type { GraphWorkerPool } from "../infra/workerPool.js";
import { StructuredLogger } from "../logger.js";
import type {
  ToolImplementation,
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
} from "../mcp/registry.js";
import {
  GraphApplyChangeSetInputSchema,
  GraphApplyChangeSetOutputSchema,
  GraphApplyChangeSetSuccessDetailsSchema,
  type GraphApplyChangeSetInput,
  type GraphApplyChangeSetOutput,
} from "../rpc/schemas.js";
import { serialiseNormalisedGraph } from "./graph/snapshot.js";
import { resolveOperationId } from "./operationIds.js";
import { coerceNullToUndefined } from "../utils/object.js";
import { ERROR_CODES } from "../types.js";
import { buildToolErrorResult, buildToolSuccessResult } from "./shared.js";

/** Canonical façade name surfaced through the MCP registry. */
export const GRAPH_APPLY_CHANGE_SET_TOOL_NAME = "graph_apply_change_set" as const;

/**
 * Manifest draft registered with the {@link ToolRegistry}. The façade is tagged
 * as both a "facade" and "ops" capability so operators can opt-in easily.
 */
export const GraphApplyChangeSetManifestDraft: ToolManifestDraft = {
  name: GRAPH_APPLY_CHANGE_SET_TOOL_NAME,
  title: "Appliquer un change-set sur le graphe",
  description:
    "Applique un ensemble de mutations RFC 6902 sur le graphe courant en garantissant idempotence, budgets et validation.",
  kind: "dynamic",
  category: "graph",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 7_000,
    tool_calls: 1,
    bytes_out: 24_576,
  },
};

/** Shared execution context injected when constructing the façade handler. */
export interface GraphApplyChangeSetToolContext {
  /** Structured logger wired to the orchestrator telemetry pipeline. */
  readonly logger: StructuredLogger;
  /** Transaction manager exposing begin/commit/rollback primitives. */
  readonly transactions: GraphTransactionManager;
  /** Cooperative lock manager preventing concurrent conflicting mutations. */
  readonly locks: GraphLockManager;
  /** Resource registry used to persist graph snapshots and versions. */
  readonly resources: ResourceRegistry;
  /** Optional idempotency registry replaying cached outcomes. */
  readonly idempotency?: IdempotencyRegistry;
  /** Optional worker pool offloading diff/validate workloads for large change-sets. */
  readonly workerPool?: GraphWorkerPool;
}

/** Internal snapshot persisted in the idempotency registry. */
interface GraphApplyChangeSetSnapshot {
  readonly output: GraphApplyChangeSetOutput;
}

/** Payload used to fingerprint requests for idempotency caching. */
interface GraphApplyChangeSetFingerprint {
  readonly graph_id: string;
  readonly expected_version?: number;
  readonly dry_run: boolean;
  readonly rationale?: string;
  readonly owner?: string;
  readonly note?: string;
  readonly metadata?: Record<string, unknown>;
  readonly changes: Array<{ op: string; path: string[]; value?: unknown }>;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ChangeSetExecution = GraphApplyChangeSetSnapshot;

/** Utility returning a JSON serialisation suitable for the textual channel. */
function asJsonPayload(output: GraphApplyChangeSetOutput): string {
  return JSON.stringify({ tool: GRAPH_APPLY_CHANGE_SET_TOOL_NAME, result: output }, null, 2);
}

/** Clone metadata defensively to avoid mutating caller-provided structures. */
function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

/** Escape a path segment so it can be embedded into a RFC 6901 JSON pointer. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Convert change-set path segments into a JSON pointer string. */
function toJsonPointer(path: string[]): string {
  return `/${path.map((segment) => escapePointerSegment(segment)).join("/")}`;
}

/**
 * Build a degraded output describing a budget exhaustion. The payload is
 * validated against the shared schema to guarantee downstream consumers always
 * receive a predictable structure.
 */
function buildBudgetExceededOutput(
  opId: string,
  idempotencyKey: string,
  graphId: string,
  error: BudgetExceededError,
): GraphApplyChangeSetOutput {
  return GraphApplyChangeSetOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant l'application du change-set",
    details: {
      reason: "budget_exhausted",
      dimension: error.dimension,
      attempted: error.attempted,
      remaining: error.remaining,
      limit: error.limit,
      op_id: opId,
      idempotency_key: idempotencyKey,
      graph_id: graphId,
    },
  });
}

/**
 * Build a degraded output describing a structural validation failure. The
 * result is cached so callers observing an idempotent replay receive the same
 * diagnostics payload.
 */
function buildValidationFailedOutput(
  opId: string,
  idempotencyKey: string,
  graphId: string,
  baseVersion: number,
  violations: GraphValidationError["violations"],
): GraphApplyChangeSetOutput {
  return GraphApplyChangeSetOutputSchema.parse({
    ok: false,
    summary: "le graphe résultant viole les invariants déclarés",
    details: {
      reason: "validation_failed",
      op_id: opId,
      idempotency_key: idempotencyKey,
      graph_id: graphId,
      base_version: baseVersion,
      violations: violations.map((violation) => ({
        code: violation.code,
        message: violation.message,
        path: violation.path,
        hint: violation.hint,
        details: violation.details,
      })),
    },
  });
}

/**
 * Execute the change-set against the latest committed graph and return the
 * structured façade response. Errors thrown by the function are surfaced as
 * JSON-RPC failures by the transport layer.
 */
async function executeChangeSet(
  context: GraphApplyChangeSetToolContext,
  parsed: GraphApplyChangeSetInput,
  idempotencyKey: string,
  opId: string,
  metadata: Record<string, unknown> | undefined,
): Promise<ChangeSetExecution> {
  const committed = context.transactions.getCommittedState(parsed.graph_id);
  if (!committed) {
    throw new GraphTransactionError(
      ERROR_CODES.TX_NOT_FOUND,
      "graph state unavailable",
      "initialise the graph before applying change-sets",
    );
  }

  if (
    parsed.expected_version !== undefined &&
    committed.version !== parsed.expected_version
  ) {
    throw new GraphVersionConflictError(parsed.graph_id, committed.version, parsed.expected_version);
  }

  context.locks.assertCanMutate(parsed.graph_id, parsed.owner ?? null);

  const tx = context.transactions.begin(committed.graph, {
    owner: parsed.owner ?? null,
    note: parsed.note ?? null,
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

  const patchOperations: JsonPatchOperation[] = parsed.changes.map((change) => {
    const pointer = toJsonPointer(change.path);
    switch (change.op) {
      case "add":
        return { op: "add", path: pointer, value: change.value };
      case "update":
        return { op: "replace", path: pointer, value: change.value };
      case "remove":
        return { op: "remove", path: pointer };
      default:
        return { op: "replace", path: pointer, value: change.value };
    }
  });

  let patchedGraph: NormalisedGraph;
  let validation: GraphChangeSetComputation["validation"];
  let diff: GraphChangeSetComputation["diff"];
  let offloaded = false;

  const computeChangeSet = (): GraphChangeSetComputation =>
    computeGraphChangeSet(committed.graph, patchOperations);

  try {
    if (context.workerPool) {
      const execution = await context.workerPool.execute({
        changeSetSize: parsed.changes.length,
        baseGraph: committed.graph,
        operations: patchOperations,
      });
      ({ patchedGraph, validation, diff } = execution.result);
      offloaded = execution.offloaded;
      if (offloaded) {
        const stats = context.workerPool.getStatistics();
        context.logger.debug("graph_apply_change_set_offloaded", {
          graph_id: parsed.graph_id,
          change_set_operations: parsed.changes.length,
          recorded_executions: stats.executed,
          offload_threshold: stats.threshold,
        });
      }
    } else {
      ({ patchedGraph, validation, diff } = computeChangeSet());
    }

    if (!validation.ok) {
      context.transactions.rollback(tx.txId);
      context.resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
      void recordOperation(
        {
          kind: GRAPH_APPLY_CHANGE_SET_TOOL_NAME,
          graph_id: parsed.graph_id,
          op_id: opId,
          operations: parsed.changes.length,
          changed: false,
          accepted: false,
          reason: "validation_failed",
        },
        tx.txId,
      );
      await recordGraphWal("graph_apply_change_set_validation_failed", {
        tx_id: tx.txId,
        graph_id: parsed.graph_id,
        op_id: opId,
        base_version: committed.version,
        owner: tx.owner,
        note: tx.note,
        violations: validation.violations,
      });
      const degraded = buildValidationFailedOutput(
        opId,
        idempotencyKey,
        parsed.graph_id,
        committed.version,
        validation.violations,
      );
      return { output: degraded };
    }

    const summary = {
      name_changed: diff.summary.nameChanged,
      metadata_changed: diff.summary.metadataChanged,
      nodes_changed: diff.summary.nodesChanged,
      edges_changed: diff.summary.edgesChanged,
    };

    const dryRun = parsed.dry_run === true;
    const invariants = validation.invariants ?? null;
    let committedVersion: number | null = null;
    let committedAt: number | null = null;
    let resultGraph: NormalisedGraph = patchedGraph;

    if (!dryRun) {
      context.locks.assertCanMutate(parsed.graph_id, parsed.owner ?? null);
      context.transactions.setWorkingCopy(tx.txId, patchedGraph);
      const committedResult = context.transactions.commit(tx.txId, patchedGraph);
      committedVersion = committedResult.version;
      committedAt = committedResult.committedAt;
      resultGraph = committedResult.graph;
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
      void recordOperation(
        {
          kind: GRAPH_APPLY_CHANGE_SET_TOOL_NAME,
          graph_id: committedResult.graphId,
          op_id: opId,
          operations: parsed.changes.length,
          changed: diff.changed,
          accepted: true,
        },
        committedResult.txId,
      );
      await recordGraphWal("graph_apply_change_set_applied", {
        tx_id: committedResult.txId,
        graph_id: committedResult.graphId,
        op_id: opId,
        committed_version: committedResult.version,
        committed_at: committedResult.committedAt,
        operations_requested: parsed.changes.length,
        changed: diff.changed,
        owner: tx.owner,
        note: tx.note,
      });
    } else {
      context.transactions.rollback(tx.txId);
      context.resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
      void recordOperation(
        {
          kind: GRAPH_APPLY_CHANGE_SET_TOOL_NAME,
          graph_id: parsed.graph_id,
          op_id: opId,
          operations: parsed.changes.length,
          changed: diff.changed,
          accepted: false,
          reason: "dry_run",
        },
        tx.txId,
      );
      await recordGraphWal("graph_apply_change_set_dry_run", {
        tx_id: tx.txId,
        graph_id: parsed.graph_id,
        op_id: opId,
        base_version: committed.version,
        operations_requested: parsed.changes.length,
        changed: diff.changed,
        owner: tx.owner,
        note: tx.note,
      });
    }

    const structured = GraphApplyChangeSetOutputSchema.parse({
      ok: true,
      summary: dryRun
        ? diff.changed
          ? "simulation effectuée, modifications détectées"
          : "simulation effectuée, aucune modification"
        : diff.changed
        ? "change-set appliqué avec succès"
        : "aucune modification nécessaire",
      details: GraphApplyChangeSetSuccessDetailsSchema.parse({
        op_id: opId,
        idempotency_key: idempotencyKey,
        graph_id: parsed.graph_id,
        base_version: committed.version,
        committed_version: committedVersion,
        committed_at: committedAt,
        dry_run: dryRun,
        changed: diff.changed,
        operations_requested: parsed.changes.length,
        operations_applied: patchOperations.length,
        diff: {
          operations: diff.operations,
          summary,
        },
        graph: serialiseNormalisedGraph(resultGraph),
        validation: {
          ok: true,
        },
        invariants,
        ...(parsed.rationale !== undefined
          ? { rationale: coerceNullToUndefined(parsed.rationale) }
          : {}),
        ...(metadata ? { metadata } : {}),
        idempotent: false,
      }),
    });

    return { output: structured };
  } catch (error) {
    try {
      context.transactions.rollback(tx.txId);
      context.resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
    } catch {
      // Ignore rollback errors, the original exception is more actionable.
    }
    throw error;
  }
}

/**
 * Factory returning the MCP handler that powers the `graph_apply_change_set`
 * façade.
 */
export function createGraphApplyChangeSetHandler(
  context: GraphApplyChangeSetToolContext,
): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = GraphApplyChangeSetInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = cloneMetadata(parsed.metadata);
    const dryRun = parsed.dry_run === true;

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const opId = resolveOperationId(parsed.op_id, "graph_apply_change_set_op");

    let charge: BudgetCharge | null = null;
    try {
      if (rpcContext?.budget) {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          {
            actor: "facade",
            operation: GRAPH_APPLY_CHANGE_SET_TOOL_NAME,
            detail: dryRun ? "evaluate_change_set" : "apply_change_set",
          },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("graph_apply_change_set_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          dimension: error.dimension,
          attempted: error.attempted,
          remaining: error.remaining,
          limit: error.limit,
          graph_id: parsed.graph_id,
        });
        const degraded = buildBudgetExceededOutput(opId, idempotencyKey, parsed.graph_id, error);
        return buildToolErrorResult(asJsonPayload(degraded), degraded);
      }
      throw error;
    }

    const fingerprint = {
      graph_id: parsed.graph_id,
      dry_run: dryRun,
      ...(parsed.expected_version !== undefined ? { expected_version: parsed.expected_version } : {}),
      ...(parsed.rationale !== undefined ? { rationale: parsed.rationale } : {}),
      ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      changes: parsed.changes.map((change) => ({
        op: change.op,
        path: [...change.path],
        value: change.value,
      })),
    } satisfies GraphApplyChangeSetFingerprint;

    const cacheKey = context.idempotency
      ? buildIdempotencyCacheKey(GRAPH_APPLY_CHANGE_SET_TOOL_NAME, idempotencyKey, fingerprint)
      : null;

    const execute = async (): Promise<ChangeSetExecution> =>
      await executeChangeSet(context, parsed, idempotencyKey, opId, metadata);

    try {
      let execution: ChangeSetExecution;
      let idempotent = false;
      if (cacheKey && context.idempotency) {
        const hit = await context.idempotency.remember(cacheKey, execute);
        execution = hit.value;
        idempotent = hit.idempotent;
      } else {
        execution = await execute();
      }

      let structured = execution.output;

      if (structured.ok && structured.details.idempotent !== idempotent) {
        structured = GraphApplyChangeSetOutputSchema.parse({
          ok: true,
          summary: structured.summary,
          details: { ...structured.details, idempotent },
        });
      }

      if (structured.ok) {
        context.logger.info("graph_apply_change_set_completed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: structured.details.graph_id,
          op_id: structured.details.op_id,
          base_version: structured.details.base_version,
          committed_version: structured.details.committed_version,
          dry_run: structured.details.dry_run,
          changed: structured.details.changed,
          idempotent,
        });
      } else if (structured.details.reason === "validation_failed") {
        context.logger.warn("graph_apply_change_set_validation_failed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: structured.details.graph_id,
          op_id: structured.details.op_id,
          base_version: structured.details.base_version,
          violations: structured.details.violations.length,
          idempotent,
        });
      } else {
        context.logger.warn("graph_apply_change_set_degraded", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: structured.details.graph_id,
          op_id: structured.details.op_id,
          reason: structured.details.reason,
          dimension: structured.details.dimension,
          idempotent,
        });
      }

      if (rpcContext?.budget && charge) {
        rpcContext.budget.snapshot();
      }

      const payload = asJsonPayload(structured);
      return structured.ok
        ? buildToolSuccessResult(payload, structured)
        : buildToolErrorResult(payload, structured);
    } catch (error) {
      if (rpcContext?.budget && charge) {
        rpcContext.budget.refund(charge);
      }
      throw error;
    }
  };
}

/** Registers the façade with the tool registry. */
export async function registerGraphApplyChangeSetTool(
  registry: ToolRegistry,
  context: GraphApplyChangeSetToolContext,
): Promise<ToolManifest> {
  return await registry.register(
    GraphApplyChangeSetManifestDraft,
    createGraphApplyChangeSetHandler(context),
    {
      inputSchema: GraphApplyChangeSetInputSchema.shape,
      annotations: { intent: GRAPH_APPLY_CHANGE_SET_TOOL_NAME },
    },
  );
}
