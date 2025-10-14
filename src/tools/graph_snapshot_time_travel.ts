import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { diffGraphs } from "../graph/diff.js";
import { GraphLockManager } from "../graph/locks.js";
import type { NormalisedGraph } from "../graph/types.js";
import { GraphTransactionManager, GraphVersionConflictError } from "../graph/tx.js";
import { validateGraph, type GraphValidationIssue } from "../graph/validate.js";
import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { IdempotencyRegistry, buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type {
  ToolImplementation,
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
} from "../mcp/registry.js";
import { ResourceRegistry } from "../resources/registry.js";
import {
  GraphSnapshotDescriptorSchema,
  GraphSnapshotTimeTravelInputSchema,
  GraphSnapshotTimeTravelOutputSchema,
  type GraphSnapshotDescriptor,
  type GraphSnapshotTimeTravelMode,
  type GraphSnapshotTimeTravelOutput,
} from "../rpc/graphSnapshotTimeTravelSchemas.js";
import { snapshotList, snapshotLoad, type SnapshotMetadata, type SnapshotRecord } from "../state/snapshot.js";
import { recordGraphWal } from "../graph/wal.js";
import { recordOperation } from "../graph/oplog.js";

/** Canonical façade identifier exposed through the registry. */
export const GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME = "graph_snapshot_time_travel" as const;

/**
 * Manifest draft describing the façade at registration time. Budgets are tuned
 * for moderately sized graphs – the bytes budget accommodates including the
 * graph payload in preview mode while leaving headroom for metadata.
 */
export const GraphSnapshotTimeTravelManifestDraft: ToolManifestDraft = {
  name: GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME,
  title: "Explorer les snapshots du graphe",
  description:
    "Liste, prévisualise et restaure les snapshots historiques d'un graphe avec budgets, idempotence et journalisation.",
  kind: "dynamic",
  category: "graph",
  tags: ["facade", "ops"],
  hidden: false,
  budgets: {
    time_ms: 7_000,
    tool_calls: 1,
    bytes_out: 32_768,
  },
};

/**
 * Context dependencies injected when constructing the façade handler. Tests
 * provide fakes for the registries while the production server wires concrete
 * instances.
 */
export interface GraphSnapshotTimeTravelToolContext {
  readonly logger: StructuredLogger;
  readonly transactions: GraphTransactionManager;
  readonly locks: GraphLockManager;
  readonly resources: ResourceRegistry;
  readonly idempotency?: IdempotencyRegistry;
  /** Optional runs root override used when querying the snapshot store. */
  readonly runsRoot?: string;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Namespace used when persisting graph snapshots on disk. */
function resolveSnapshotNamespace(graphId: string): string {
  return `graph/${graphId}`;
}

/** Serialises a result into the textual MCP channel payload. */
function asJsonPayload(output: GraphSnapshotTimeTravelOutput): string {
  return JSON.stringify({ tool: GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME, result: output }, null, 2);
}

/** Map the raw snapshot metadata returned by the persistence layer to the façade descriptor. */
function mapSnapshotMetadata(metadata: SnapshotMetadata): GraphSnapshotDescriptor {
  const version = Number(metadata.metadata?.version);
  const committedAt = Number(metadata.metadata?.committed_at);
  const txId = metadata.metadata?.tx_id;
  return GraphSnapshotDescriptorSchema.parse({
    snapshot_id: metadata.id,
    created_at: metadata.createdAt,
    version: Number.isFinite(version) ? Math.max(0, Math.floor(version)) : null,
    committed_at: Number.isFinite(committedAt) ? Math.max(0, Math.floor(committedAt)) : null,
    tx_id: typeof txId === "string" && txId.trim().length > 0 ? txId : null,
    size_bytes: metadata.sizeBytes,
    metadata: metadata.metadata,
  });
}

/** Compute a deterministic hash of the graph payload to aid observability. */
function hashGraph(graph: NormalisedGraph): string {
  const serialised = JSON.stringify(graph);
  return createHash("sha256").update(serialised).digest("hex");
}

/** Summarise the basic topology characteristics of a graph. */
function summariseGraph(graph: NormalisedGraph): { nodes: number; edges: number } {
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  };
}

/** Normalises the diff summary into the schema-friendly snake_case structure. */
function normaliseDiffSummary(
  summary: ReturnType<typeof diffGraphs>["summary"] | undefined,
): { name_changed: boolean; metadata_changed: boolean; nodes_changed: boolean; edges_changed: boolean } | undefined {
  if (!summary) {
    return undefined;
  }
  return {
    name_changed: summary.nameChanged ?? false,
    metadata_changed: summary.metadataChanged ?? false,
    nodes_changed: summary.nodesChanged ?? false,
    edges_changed: summary.edgesChanged ?? false,
  };
}

/** Builds a degraded response when the caller exhausts one of its budgets. */
function buildBudgetExceededOutput(
  graphId: string,
  mode: GraphSnapshotTimeTravelMode,
  idempotencyKey: string,
  error: BudgetExceededError,
  metadata: Record<string, unknown> | undefined,
): GraphSnapshotTimeTravelOutput {
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant l'opération sur les snapshots",
    details: {
      mode,
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      metadata,
      budget: {
        reason: "budget_exhausted",
        dimension: error.dimension,
        attempted: error.attempted,
        remaining: error.remaining,
        limit: error.limit,
      },
    },
  });
}

/** Builds a degraded response when the targeted graph has no committed state. */
function buildGraphUnavailableOutput(
  graphId: string,
  mode: GraphSnapshotTimeTravelMode,
  idempotencyKey: string,
  metadata: Record<string, unknown> | undefined,
): GraphSnapshotTimeTravelOutput {
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: false,
    summary: "aucun graphe committé n'a été trouvé",
    details: {
      mode,
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      metadata,
      error: {
        reason: "graph_not_found",
        message: "aucun état de graphe n'est disponible pour ce graph_id",
      },
    },
  });
}

/** Builds a degraded response when the snapshot identifier cannot be resolved. */
function buildSnapshotMissingOutput(
  graphId: string,
  mode: GraphSnapshotTimeTravelMode,
  idempotencyKey: string,
  snapshotId: string | null,
  metadata: Record<string, unknown> | undefined,
): GraphSnapshotTimeTravelOutput {
  const provided = snapshotId && snapshotId.trim().length > 0 ? snapshotId : "<aucun>";
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: false,
    summary: "snapshot introuvable",
    details: {
      mode,
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      metadata,
      error: {
        reason: "snapshot_not_found",
        message: `le snapshot '${provided}' est introuvable pour ce graphe`,
      },
    },
  });
}

/** Builds a degraded response describing validation failures. */
function buildValidationFailedOutput(
  graphId: string,
  mode: GraphSnapshotTimeTravelMode,
  idempotencyKey: string,
  metadata: Record<string, unknown> | undefined,
  violations: GraphValidationIssue[],
): GraphSnapshotTimeTravelOutput {
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: false,
    summary: "le snapshot viole les invariants du graphe",
    details: {
      mode,
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      metadata,
      error: {
        reason: "validation_failed",
        message: "le graphe issu du snapshot ne respecte pas les contraintes",
        diagnostics: { violations },
      },
    },
  });
}

/**
 * Extract the persisted graph from a snapshot record while ensuring the shape
 * matches the expectations of the transaction manager.
 */
function extractSnapshotGraph(record: SnapshotRecord<{ graph: NormalisedGraph }>): NormalisedGraph {
  if (!record.state || typeof record.state !== "object") {
    throw new Error("snapshot payload missing state");
  }
  const graph = (record.state as { graph?: NormalisedGraph }).graph;
  if (!graph || typeof graph !== "object") {
    throw new Error("snapshot payload missing graph descriptor");
  }
  return structuredClone(graph) as NormalisedGraph;
}

/** Builds a structured success payload for the list operation. */
function buildListOutput(
  graphId: string,
  idempotencyKey: string,
  snapshots: GraphSnapshotDescriptor[],
  metadata: Record<string, unknown> | undefined,
): GraphSnapshotTimeTravelOutput {
  const summary = snapshots.length
    ? `${snapshots.length} snapshot${snapshots.length > 1 ? "s" : ""} disponible${snapshots.length > 1 ? "s" : ""}`
    : "aucun snapshot enregistré";
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: true,
    summary,
    details: {
      mode: "list",
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      snapshots,
      metadata,
    },
  });
}

/** Builds a structured success payload for the preview operation. */
function buildPreviewOutput(
  graphId: string,
  idempotencyKey: string,
  snapshotId: string,
  graph: NormalisedGraph,
  committedVersion: number | null,
  committedAt: number | null,
  txId: string | null,
  metadata: Record<string, unknown> | undefined,
  diffSummary: ReturnType<typeof diffGraphs>["summary"] | undefined,
  includeGraph: boolean,
): GraphSnapshotTimeTravelOutput {
  const { nodes, edges } = summariseGraph(graph);
  const hash = hashGraph(graph);
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: true,
    summary: `snapshot ${snapshotId} pré-visualisé (${nodes} nœuds / ${edges} arêtes)`,
    details: {
      mode: "preview",
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      snapshot_id: snapshotId,
      nodes,
      edges,
      version: committedVersion,
      committed_at: committedAt,
      tx_id: txId,
      diff_summary: normaliseDiffSummary(diffSummary),
      graph_hash: hash,
      included_graph: includeGraph,
      graph: includeGraph ? graph : undefined,
      metadata,
    },
  });
}

/** Builds a structured success payload for the restore operation. */
function buildRestoreOutput(
  graphId: string,
  idempotencyKey: string,
  snapshotId: string,
  baseVersion: number,
  restoredVersion: number | null,
  restoredAt: number | null,
  graph: NormalisedGraph,
  diffSummary: ReturnType<typeof diffGraphs>["summary"] | undefined,
  metadata: Record<string, unknown> | undefined,
  idempotent: boolean,
): GraphSnapshotTimeTravelOutput {
  const { nodes, edges } = summariseGraph(graph);
  return GraphSnapshotTimeTravelOutputSchema.parse({
    ok: true,
    summary: restoredVersion
      ? `snapshot ${snapshotId} restauré (version ${restoredVersion})`
      : `snapshot ${snapshotId} pré-validé sans commit`,
    details: {
      mode: "restore",
      graph_id: graphId,
      idempotency_key: idempotencyKey,
      snapshot_id: snapshotId,
      base_version: baseVersion,
      restored_version: restoredVersion,
      restored_at: restoredAt,
      nodes,
      edges,
      diff_summary: normaliseDiffSummary(diffSummary),
      metadata,
      idempotent,
    },
  });
}

/** Creates the façade handler invoked by the MCP server. */
export function createGraphSnapshotTimeTravelHandler(
  context: GraphSnapshotTimeTravelToolContext,
): ToolImplementation {
  return async function handleGraphSnapshotTimeTravel(
    input: unknown,
    extra: RpcExtra,
  ): Promise<CallToolResult> {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const parsed = GraphSnapshotTimeTravelInputSchema.parse(args);

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = parsed.metadata;
    const mode: GraphSnapshotTimeTravelMode = parsed.mode ?? "list";
    const limit = parsed.limit ?? 10;

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    let charge: BudgetCharge | null = null;
    try {
      if (rpcContext?.budget) {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          {
            actor: "facade",
            operation: GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME,
            detail: mode,
          },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("graph_snapshot_time_travel_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: parsed.graph_id,
          mode,
          dimension: error.dimension,
          attempted: error.attempted,
          remaining: error.remaining,
          limit: error.limit,
        });
        const degraded = buildBudgetExceededOutput(parsed.graph_id, mode, idempotencyKey, error, metadata);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(degraded) }],
          structuredContent: degraded,
        };
      }
      throw error;
    }

    const fingerprint = {
      graph_id: parsed.graph_id,
      mode,
      snapshot_id: parsed.snapshot_id ?? null,
      limit,
      include_graph: parsed.include_graph ?? false,
      metadata,
    };
    const cacheKey = context.idempotency
      ? buildIdempotencyCacheKey(GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME, idempotencyKey, fingerprint)
      : null;

    const execute = async (): Promise<GraphSnapshotTimeTravelOutput> => {
      const namespace = resolveSnapshotNamespace(parsed.graph_id);
      const runsRoot = context.runsRoot ? { runsRoot: context.runsRoot } : undefined;

      if (mode === "list") {
        const entries = await snapshotList(namespace, runsRoot);
        const mapped = entries.slice(0, limit).map(mapSnapshotMetadata);
        const structured = buildListOutput(parsed.graph_id, idempotencyKey, mapped, metadata);
        context.logger.info("graph_snapshot_time_travel_listed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: parsed.graph_id,
          snapshots: mapped.length,
        });
        return structured;
      }

      const snapshotId = parsed.snapshot_id ?? null;
      if (!snapshotId) {
        return buildSnapshotMissingOutput(parsed.graph_id, mode, idempotencyKey, snapshotId, metadata);
      }

      let snapshot: SnapshotRecord<{ graph: NormalisedGraph; version?: number; committed_at?: number; tx_id?: string }>;
      try {
        snapshot = await snapshotLoad(namespace, snapshotId, runsRoot);
      } catch (error) {
        context.logger.warn("graph_snapshot_time_travel_snapshot_load_failed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: parsed.graph_id,
          snapshot_id: snapshotId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return buildSnapshotMissingOutput(parsed.graph_id, mode, idempotencyKey, snapshotId, metadata);
      }

      let graph: NormalisedGraph;
      try {
        graph = extractSnapshotGraph(snapshot);
      } catch (error) {
        context.logger.warn("graph_snapshot_time_travel_invalid_snapshot", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: parsed.graph_id,
          snapshot_id: snapshotId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return GraphSnapshotTimeTravelOutputSchema.parse({
          ok: false,
          summary: "snapshot invalide",
          details: {
            mode,
            graph_id: parsed.graph_id,
            idempotency_key: idempotencyKey,
            metadata,
            error: {
              reason: "invalid_snapshot",
              message: "le snapshot ne contient pas un graphe exploitable",
            },
          },
        });
      }

      const committed = context.transactions.getCommittedState(parsed.graph_id);
      if (!committed) {
        return buildGraphUnavailableOutput(parsed.graph_id, mode, idempotencyKey, metadata);
      }

      const diff = diffGraphs(committed.graph, graph);
      const validation = validateGraph(graph);
      if (!validation.ok) {
        return buildValidationFailedOutput(parsed.graph_id, mode, idempotencyKey, metadata, validation.violations);
      }

      if (mode === "preview") {
        const includeGraph = parsed.include_graph === true;
        if (includeGraph && rpcContext?.budget) {
          try {
            const estimatedBytes = Buffer.byteLength(JSON.stringify(graph), "utf8");
            if (estimatedBytes > 0) {
              rpcContext.budget.consume(
                { bytesOut: estimatedBytes },
                {
                  actor: "facade",
                  operation: GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME,
                  detail: "preview_bytes",
                },
              );
            }
          } catch (error) {
            if (error instanceof BudgetExceededError) {
              context.logger.warn("graph_snapshot_time_travel_preview_bytes_budget_exhausted", {
                request_id: rpcContext?.requestId ?? extra.requestId ?? null,
                trace_id: traceContext?.traceId ?? null,
                graph_id: parsed.graph_id,
                snapshot_id: snapshotId,
                dimension: error.dimension,
                attempted: error.attempted,
                remaining: error.remaining,
                limit: error.limit,
              });
              return buildBudgetExceededOutput(parsed.graph_id, mode, idempotencyKey, error, metadata);
            }
            throw error;
          }
        }

        const structured = buildPreviewOutput(
          parsed.graph_id,
          idempotencyKey,
          snapshotId,
          graph,
          typeof snapshot.state?.version === "number" ? Math.max(0, Math.floor(snapshot.state.version)) : committed.version,
          typeof snapshot.state?.committed_at === "number"
            ? Math.max(0, Math.floor(snapshot.state.committed_at))
            : committed.committedAt ?? null,
          typeof snapshot.state?.tx_id === "string" ? snapshot.state.tx_id : null,
          metadata,
          diff.summary,
          parsed.include_graph === true,
        );

        context.logger.info("graph_snapshot_time_travel_previewed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: parsed.graph_id,
          snapshot_id: snapshotId,
          include_graph: parsed.include_graph === true,
        });

        return structured;
      }

      // Restore mode
      context.locks.assertCanMutate(parsed.graph_id, null);
      const tx = context.transactions.begin(committed.graph);
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

      try {
        const nextGraph: NormalisedGraph = {
          ...graph,
          graphId: parsed.graph_id,
          graphVersion: committed.version + 1,
        } as NormalisedGraph;
        context.transactions.setWorkingCopy(tx.txId, nextGraph);
        const committedResult = context.transactions.commit(tx.txId, nextGraph);

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

        await recordGraphWal("graph_snapshot_time_travel_restore", {
          graph_id: committedResult.graphId,
          snapshot_id: snapshotId,
          restored_version: committedResult.version,
        });
        void recordOperation(
          {
            kind: "graph_patch",
            graph_id: committedResult.graphId,
            snapshot_id: snapshotId,
            restored_version: committedResult.version,
          },
          tx.txId,
        );

        const structured = buildRestoreOutput(
          parsed.graph_id,
          idempotencyKey,
          snapshotId,
          committed.version,
          committedResult.version,
          committedResult.committedAt,
          committedResult.graph,
          diff.summary,
          metadata,
          false,
        );

        context.logger.info("graph_snapshot_time_travel_restored", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          graph_id: parsed.graph_id,
          snapshot_id: snapshotId,
          base_version: committed.version,
          restored_version: committedResult.version,
        });

        return structured;
      } catch (error) {
        context.resources.markGraphSnapshotRolledBack(parsed.graph_id, tx.txId);
        try {
          context.transactions.rollback(tx.txId);
        } catch (rollbackError) {
          context.logger.warn("graph_snapshot_time_travel_restore_rollback_failed", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            graph_id: parsed.graph_id,
            snapshot_id: snapshotId,
            reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }

        if (error instanceof GraphVersionConflictError) {
          context.logger.warn("graph_snapshot_time_travel_conflict", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            graph_id: parsed.graph_id,
            snapshot_id: snapshotId,
            reason: error.message,
            expected_version: error.details.expected,
            found_version: error.details.found,
          });
          return GraphSnapshotTimeTravelOutputSchema.parse({
            ok: false,
            summary: "conflit de version lors de la restauration",
            details: {
              mode,
              graph_id: parsed.graph_id,
              idempotency_key: idempotencyKey,
              metadata,
              error: {
                reason: "invalid_snapshot",
                message: "le snapshot ne peut pas être restauré car la version actuelle a changé",
                diagnostics: {
                  conflict: {
                    expected: error.details.expected,
                    actual: error.details.found,
                  },
                },
              },
            },
          });
        }
        throw error;
      }
    };

    let structured: GraphSnapshotTimeTravelOutput;
    let idempotent = false;
    if (cacheKey && context.idempotency && mode === "restore") {
      const hit = await context.idempotency.remember(cacheKey, execute);
      structured = hit.value;
      idempotent = hit.idempotent;
    } else {
      structured = await execute();
    }

    if (structured.ok && structured.details.mode === "restore" && structured.details.idempotent !== idempotent) {
      structured = GraphSnapshotTimeTravelOutputSchema.parse({
        ok: true,
        summary: structured.summary,
        details: { ...structured.details, idempotent },
      });
    }

    if (rpcContext?.budget) {
      rpcContext.budget.snapshot();
    }

    const payload = asJsonPayload(structured);
    return {
      content: [{ type: "text", text: payload }],
      structuredContent: structured,
    };
  };
}

/** Registers the façade within the Tool Registry. */
export async function registerGraphSnapshotTimeTravelTool(
  registry: ToolRegistry,
  context: GraphSnapshotTimeTravelToolContext,
): Promise<ToolManifest> {
  return await registry.register(
    GraphSnapshotTimeTravelManifestDraft,
    createGraphSnapshotTimeTravelHandler(context),
    {
      inputSchema: GraphSnapshotTimeTravelInputSchema.shape,
      outputSchema: GraphSnapshotTimeTravelOutputSchema.shape,
      annotations: { intent: GRAPH_SNAPSHOT_TIME_TRAVEL_TOOL_NAME },
    },
  );
}
