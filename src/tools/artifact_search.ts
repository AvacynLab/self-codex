import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { scanArtifacts } from "../artifacts.js";
import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type {
  ToolImplementation,
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
} from "../mcp/registry.js";
import {
  ArtifactBudgetDiagnosticSchema,
  ArtifactOperationErrorSchema,
  ArtifactSearchInputSchema,
  ArtifactSearchOutputSchema,
  type ArtifactSearchOutput,
} from "../rpc/schemas.js";

/** Canonical name advertised by the façade manifest. */
export const ARTIFACT_SEARCH_TOOL_NAME = "artifact_search" as const;

/** Default manifest registered with the tool catalogue. */
export const ArtifactSearchManifestDraft: ToolManifestDraft = {
  name: ARTIFACT_SEARCH_TOOL_NAME,
  title: "Lister les artefacts",
  description: "Explore les artefacts d'un enfant en appliquant filtres et budgets.",
  kind: "dynamic",
  category: "artifact",
  tags: ["facade", "authoring"],
  hidden: false,
  budgets: {
    time_ms: 4_000,
    tool_calls: 1,
    bytes_out: 24_576,
  },
};

/** Context forwarded to the façade handler. */
export interface ArtifactSearchToolContext {
  readonly logger: StructuredLogger;
  readonly childrenRoot: string;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Serialises a JSON payload suitable for the textual MCP channel. */
function asJsonPayload(result: ArtifactSearchOutput): string {
  return JSON.stringify({ tool: ARTIFACT_SEARCH_TOOL_NAME, result }, null, 2);
}

/** Defensive clone so caller supplied metadata cannot mutate internal state. */
function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata));
}

/** Builds a degraded payload describing a budget exhaustion. */
function buildBudgetExceededResult(
  idempotencyKey: string,
  childId: string,
  metadata: Record<string, unknown> | undefined,
  filters: { query?: string; mime_types?: string[]; limit?: number },
  error: BudgetExceededError,
): ArtifactSearchOutput {
  const diagnostic = ArtifactBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });
  return ArtifactSearchOutputSchema.parse({
    ok: false,
    summary: "budget épuisé lors de l'inventaire des artefacts",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      total: 0,
      returned: 0,
      filters,
      artifacts: [],
      budget: diagnostic,
      ...(metadata ? { metadata } : {}),
    },
  });
}

/** Builds a degraded payload when the filesystem lookup fails. */
function buildIoErrorResult(
  idempotencyKey: string,
  childId: string,
  metadata: Record<string, unknown> | undefined,
  filters: { query?: string; mime_types?: string[]; limit?: number },
  error: unknown,
): ArtifactSearchOutput {
  const context = ArtifactOperationErrorSchema.parse({
    reason: "io_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
  return ArtifactSearchOutputSchema.parse({
    ok: false,
    summary: "échec de la recherche d'artefacts",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      total: 0,
      returned: 0,
      filters,
      artifacts: [],
      error: context,
      ...(metadata ? { metadata } : {}),
    },
  });
}

/**
 * Factory returning the MCP handler that powers the `artifact_search` façade.
 */
export function createArtifactSearchHandler(context: ArtifactSearchToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = ArtifactSearchInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = cloneMetadata(parsed.metadata);

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const filters: { query?: string; mime_types?: string[]; limit?: number } = {};
    if (parsed.query) {
      filters.query = parsed.query;
    }
    if (parsed.mime_types) {
      filters.mime_types = [...parsed.mime_types];
    }
    if (parsed.limit) {
      filters.limit = parsed.limit;
    }

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          { actor: "facade", operation: ARTIFACT_SEARCH_TOOL_NAME, detail: "list_artifacts" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          context.logger.warn("artifact_search_budget_exhausted", {
            request_id: rpcContext.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: parsed.child_id,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          const degraded = buildBudgetExceededResult(idempotencyKey, parsed.child_id, metadata, filters, error);
          return {
            isError: true,
            content: [{ type: "text", text: asJsonPayload(degraded) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    let artifacts;
    try {
      artifacts = await scanArtifacts(context.childrenRoot, parsed.child_id);
    } catch (error) {
      if (rpcContext?.budget && charge) {
        rpcContext.budget.refund(charge);
      }
      context.logger.error("artifact_search_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        child_id: parsed.child_id,
        error: error instanceof Error ? error.message : String(error),
      });
      const degraded = buildIoErrorResult(idempotencyKey, parsed.child_id, metadata, filters, error);
      return {
        isError: true,
        content: [{ type: "text", text: asJsonPayload(degraded) }],
        structuredContent: degraded,
      };
    }

    const normalisedQuery = parsed.query ? parsed.query.toLowerCase() : null;
    const allowedMime = parsed.mime_types ? new Set(parsed.mime_types.map((value) => value.toLowerCase())) : null;

    let filtered = artifacts;
    if (normalisedQuery) {
      filtered = filtered.filter((entry) => entry.path.toLowerCase().includes(normalisedQuery));
    }
    if (allowedMime && allowedMime.size > 0) {
      filtered = filtered.filter((entry) => allowedMime.has(entry.mimeType.toLowerCase()));
    }

    const total = filtered.length;
    const limit = parsed.limit ?? total;
    const limited = filtered.slice(0, limit);

    const estimatedBytes = Buffer.byteLength(JSON.stringify(limited));
    if (rpcContext?.budget && estimatedBytes > 0) {
      try {
        rpcContext.budget.consume(
          { bytesOut: estimatedBytes },
          { actor: "facade", operation: ARTIFACT_SEARCH_TOOL_NAME, detail: "emit_catalogue" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          context.logger.warn("artifact_search_bytes_budget_exhausted", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: parsed.child_id,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          const degraded = buildBudgetExceededResult(idempotencyKey, parsed.child_id, metadata, filters, error);
          return {
            isError: true,
            content: [{ type: "text", text: asJsonPayload(degraded) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    const structured = ArtifactSearchOutputSchema.parse({
      ok: true,
      summary:
        total === 0
          ? "aucun artefact trouvé"
          : `${limited.length} artefact${limited.length > 1 ? "s" : ""} sur ${total}`,
      details: {
        idempotency_key: idempotencyKey,
        child_id: parsed.child_id,
        total,
        returned: limited.length,
        filters,
        artifacts: limited.map((entry) => ({
          path: entry.path,
          size: entry.size,
          mime_type: entry.mimeType,
          sha256: entry.sha256,
        })),
        ...(metadata ? { metadata } : {}),
      },
    });

    context.logger.info("artifact_search_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      child_id: parsed.child_id,
      total,
      returned: limited.length,
      filters,
    });

    if (rpcContext?.budget) {
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(structured) }],
      structuredContent: structured,
    };
  };
}

/** Registers the façade with the tool registry. */
export async function registerArtifactSearchTool(
  registry: ToolRegistry,
  context: ArtifactSearchToolContext,
): Promise<ToolManifest> {
  return await registry.register(ArtifactSearchManifestDraft, createArtifactSearchHandler(context), {
    inputSchema: ArtifactSearchInputSchema.shape,
    outputSchema: ArtifactSearchOutputSchema.shape,
    annotations: { intent: "artifact_search" },
  });
}
