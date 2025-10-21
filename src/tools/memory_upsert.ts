import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

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
import {
  IdempotencyRegistry,
  buildIdempotencyCacheKey,
} from "../infra/idempotency.js";
import type {
  ToolImplementation,
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
} from "../mcp/registry.js";
import { MemoryUpsertInputSchema, MemoryUpsertOutputSchema } from "../rpc/schemas.js";

/** Canonical façade identifier exposed to the MCP catalogue. */
export const MEMORY_UPSERT_TOOL_NAME = "memory_upsert" as const;

/**
 * Manifest advertised to clients requesting the `memory_upsert` façade. The
 * defaults assume small textual payloads that should comfortably fit within a
 * few kilobytes while granting enough wall-clock budget for lightweight
 * embeddings to be generated and persisted.
 */
export const MemoryUpsertManifestDraft: ToolManifestDraft = {
  name: MEMORY_UPSERT_TOOL_NAME,
  title: "Indexer un souvenir vectoriel",
  description:
    "Ajoute ou met à jour une entrée dans l'index mémoire vectorielle en appliquant l'idempotence et la budgétisation.",
  kind: "dynamic",
  category: "memory",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 5_000,
    tool_calls: 1,
    bytes_out: 12_288,
  },
};

/** Context dependencies required by {@link createMemoryUpsertHandler}. */
export interface MemoryUpsertToolContext {
  /** Persistent vector index storing orchestrator long-term memories. */
  readonly vectorIndex: VectorMemoryIndex;
  /** Structured logger fulfilling the observability checklist. */
  readonly logger: StructuredLogger;
  /** Optional idempotency registry allowing repeated calls to replay results. */
  readonly idempotency?: IdempotencyRegistry;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Snapshot cached in the idempotency registry for replayed upserts. */
interface MemoryUpsertSnapshot {
  readonly documentId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tokenCount: number;
  readonly tags: string[];
  readonly metadata: Record<string, unknown> | undefined;
}

/** Serialises the façade response for textual transports. */
function asJsonPayload(payload: unknown): string {
  return JSON.stringify({ tool: MEMORY_UPSERT_TOOL_NAME, result: payload }, null, 2);
}

/**
 * Build the degraded response returned when a budget dimension is depleted
 * before the upsert could execute.
 */
function buildBudgetExceededResponse(idempotencyKey: string, error: BudgetExceededError) {
  return MemoryUpsertOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant l'indexation mémoire",
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

/**
 * Build the degraded response returned when the underlying index rejects the
 * upsert request.
 */
function buildOperationFailedResponse(idempotencyKey: string, message: string) {
  return MemoryUpsertOutputSchema.parse({
    ok: false,
    summary: "échec de l'indexation mémoire",
    details: {
      idempotency_key: idempotencyKey,
      reason: "operation_failed" as const,
      message,
    },
  });
}

/** Clone metadata defensively to avoid leaking internal references. */
function cloneMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata));
}

/**
 * Factory producing the MCP handler powering the `memory_upsert` façade.
 */
export function createMemoryUpsertHandler(context: MemoryUpsertToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = MemoryUpsertInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = cloneMetadata(parsed.metadata);

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const textBuffer = Buffer.from(parsed.text, "utf8");
    const bytesIn = textBuffer.byteLength;
    const tokenEstimate = estimateTokenUsage(parsed.text);

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, bytesIn, tokens: tokenEstimate },
          { actor: "facade", operation: MEMORY_UPSERT_TOOL_NAME, detail: "memory_upsert" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const degraded = buildBudgetExceededResponse(idempotencyKey, error);
          context.logger.warn("memory_upsert_budget_exhausted", {
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

    const textHash = createHash("sha256").update(textBuffer).digest("hex");
    const fingerprint = {
      text_sha256: textHash,
      metadata_sha256: metadata ? createHash("sha256").update(JSON.stringify(metadata)).digest("hex") : null,
      tags: parsed.tags ?? [],
      document_id: parsed.document_id ?? null,
      created_at: parsed.created_at ?? null,
    };

    const executeUpsert = async (): Promise<MemoryUpsertSnapshot> => {
      try {
        // Build the vector upsert payload without propagating undefined fields
        // so the vector memory remains compatible with strict optional typing.
        const upsertPayload = {
          text: parsed.text,
          ...(typeof parsed.document_id === "string" ? { id: parsed.document_id } : {}),
          ...(Array.isArray(parsed.tags) ? { tags: parsed.tags } : {}),
          ...(metadata ? { metadata } : {}),
          ...(typeof parsed.created_at === "number" ? { createdAt: parsed.created_at } : {}),
        } satisfies Parameters<typeof context.vectorIndex.upsert>[0];

        const document = await context.vectorIndex.upsert(upsertPayload);
        return {
          documentId: document.id,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          tokenCount: document.tokenCount,
          tags: [...document.tags],
          metadata: metadata ? { ...metadata } : undefined,
        };
      } catch (error) {
        if (rpcContext?.budget && charge) {
          rpcContext.budget.refund(charge);
        }
        const message = error instanceof Error ? error.message : String(error);
        context.logger.error("memory_upsert_failed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          message,
        });
        throw error;
      }
    };

    let snapshot: MemoryUpsertSnapshot;
    let idempotent = false;

    if (context.idempotency) {
      const cacheKey = buildIdempotencyCacheKey(MEMORY_UPSERT_TOOL_NAME, idempotencyKey, fingerprint);
      try {
        const hit = await context.idempotency.remember(cacheKey, executeUpsert);
        snapshot = hit.value;
        idempotent = hit.idempotent;
      } catch (error) {
        const degraded = buildOperationFailedResponse(
          idempotencyKey,
          error instanceof Error ? error.message : String(error),
        );
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(degraded) }],
          structuredContent: degraded,
        };
      }
    } else {
      try {
        snapshot = await executeUpsert();
      } catch (error) {
        const degraded = buildOperationFailedResponse(
          idempotencyKey,
          error instanceof Error ? error.message : String(error),
        );
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(degraded) }],
          structuredContent: degraded,
        };
      }
    }

    const structured = MemoryUpsertOutputSchema.parse({
      ok: true,
      summary: idempotent
        ? "entrée mémoire rejouée depuis le cache d'idempotence"
        : "entrée mémoire persistée",
      details: {
        idempotency_key: idempotencyKey,
        document_id: snapshot.documentId,
        created_at: snapshot.createdAt,
        updated_at: snapshot.updatedAt,
        token_count: snapshot.tokenCount,
        tags: snapshot.tags,
        metadata: snapshot.metadata,
        idempotent,
      },
    });

    context.logger.info("memory_upsert_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      document_id: snapshot.documentId,
      idempotent,
      token_count: snapshot.tokenCount,
      tags: snapshot.tags,
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
export async function registerMemoryUpsertTool(
  registry: ToolRegistry,
  context: MemoryUpsertToolContext,
): Promise<ToolManifest> {
  return await registry.register(MemoryUpsertManifestDraft, createMemoryUpsertHandler(context), {
    inputSchema: MemoryUpsertInputSchema.shape,
    outputSchema: MemoryUpsertOutputSchema.shape,
    annotations: { intent: "memory_upsert" },
  });
}

