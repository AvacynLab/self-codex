import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { VectorMemoryIndex } from "../memory/vector.js";
import {
  BudgetExceededError,
  type BudgetCharge,
  estimateTokenUsage,
} from "../infra/budget.js";
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
  MemorySearchHitSchema,
  MemorySearchInputSchema,
  MemorySearchOutputSchema,
} from "../rpc/schemas.js";

/** Canonical façade identifier exposed in the manifest catalogue. */
export const MEMORY_SEARCH_TOOL_NAME = "memory_search" as const;

/**
 * Manifest draft registered with the tool catalogue. The budget remains
 * conservative as vector lookups are CPU bound; most queries complete in well
 * under one second even with the default limit.
 */
export const MemorySearchManifestDraft: ToolManifestDraft = {
  name: MEMORY_SEARCH_TOOL_NAME,
  title: "Rechercher dans la mémoire vectorielle",
  description:
    "Interroge l'index mémoire vectorielle et retourne les souvenirs les plus proches avec leurs métadonnées.",
  kind: "dynamic",
  category: "memory",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 3_000,
    tool_calls: 1,
    bytes_out: 16_384,
  },
};

/** Context dependencies used by {@link createMemorySearchHandler}. */
export interface MemorySearchToolContext {
  /** Persistent vector index storing orchestrator long-term memories. */
  readonly vectorIndex: VectorMemoryIndex;
  /** Structured logger fulfilling the observability checklist. */
  readonly logger: StructuredLogger;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Serialises the façade response for textual transports. */
function asJsonPayload(payload: unknown): string {
  return JSON.stringify({ tool: MEMORY_SEARCH_TOOL_NAME, result: payload }, null, 2);
}

/** Builds the degraded response returned when the request exceeds its budget. */
function buildBudgetExceededResponse(idempotencyKey: string, error: BudgetExceededError) {
  return MemorySearchOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant la recherche mémoire",
    details: {
      idempotency_key: idempotencyKey,
      reason: "budget_exhausted" as const,
      dimension: error.dimension,
      attempted: error.attempted,
      remaining: error.remaining,
      limit: error.limit,
    },
  });
}

/** Builds the degraded response returned when the index lookup fails. */
function buildOperationFailedResponse(idempotencyKey: string, message: string) {
  return MemorySearchOutputSchema.parse({
    ok: false,
    summary: "échec de la recherche mémoire",
    details: {
      idempotency_key: idempotencyKey,
      reason: "operation_failed" as const,
      message,
    },
  });
}

/**
 * Factory returning the MCP handler powering the `memory_search` façade.
 */
export function createMemorySearchHandler(context: MemorySearchToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = MemorySearchInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const tokenEstimate = estimateTokenUsage(parsed.query);

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, tokens: tokenEstimate },
          { actor: "facade", operation: MEMORY_SEARCH_TOOL_NAME, detail: "memory_search" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const degraded = buildBudgetExceededResponse(idempotencyKey, error);
          context.logger.warn("memory_search_budget_exhausted", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          return {
            isError: true,
            content: [{ type: "text", text: asJsonPayload(degraded) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    let structuredHits;
    let tookMs = 0;
    try {
      const started = Date.now();
      const rawHits = context.vectorIndex.search(parsed.query, {
        limit: parsed.limit,
        minScore: parsed.min_score,
      });
      tookMs = Date.now() - started;

      const filtered = parsed.tags_filter?.length
        ? rawHits.filter((hit) =>
            parsed.tags_filter!.every((tag) => hit.document.tags.includes(tag)),
          )
        : rawHits;

      structuredHits = filtered.map((hit) =>
        MemorySearchHitSchema.parse({
          document_id: hit.document.id,
          text: hit.document.text,
          score: Number(hit.score.toFixed(6)),
          tags: [...hit.document.tags],
          metadata: parsed.include_metadata ? { ...hit.document.metadata } : null,
          created_at: hit.document.createdAt,
          updated_at: hit.document.updatedAt,
        }),
      );
    } catch (error) {
      if (rpcContext?.budget && charge) {
        rpcContext.budget.refund(charge);
      }
      const degraded = buildOperationFailedResponse(
        idempotencyKey,
        error instanceof Error ? error.message : String(error),
      );
      context.logger.error("memory_search_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        isError: true,
        content: [{ type: "text", text: asJsonPayload(degraded) }],
        structuredContent: degraded,
      };
    }

    const structured = MemorySearchOutputSchema.parse({
      ok: true,
      summary: structuredHits.length === 0 ? "aucun souvenir correspondant" : "souvenirs récupérés",
      details: {
        idempotency_key: idempotencyKey,
        query: parsed.query,
        returned: structuredHits.length,
        total: structuredHits.length,
        took_ms: tookMs,
        hits: structuredHits,
      },
    });

    context.logger.info("memory_search_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      returned: structuredHits.length,
      limit: parsed.limit,
      took_ms: tookMs,
    });

    if (rpcContext?.budget && charge) {
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(structured) }],
      structuredContent: structured,
    };
  };
}

/** Registers the façade with the tool registry. */
export async function registerMemorySearchTool(
  registry: ToolRegistry,
  context: MemorySearchToolContext,
): Promise<ToolManifest> {
  return await registry.register(MemorySearchManifestDraft, createMemorySearchHandler(context), {
    inputSchema: MemorySearchInputSchema.shape,
    outputSchema: MemorySearchOutputSchema.shape,
    annotations: { intent: "memory_search" },
  });
}

