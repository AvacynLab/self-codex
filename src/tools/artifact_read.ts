import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { readArtifact } from "../artifacts.js";
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
  ArtifactReadInputSchema,
  ArtifactReadOutputSchema,
  type ArtifactReadOutput,
} from "../rpc/schemas.js";
import {
  buildPathLogFields,
  redactPathForLogs,
  sanitizeArtifactPath,
} from "./artifact_paths.js";

/** Canonical name advertised by the façade manifest. */
export const ARTIFACT_READ_TOOL_NAME = "artifact_read" as const;

/** Default manifest registered with the tool catalogue. */
export const ArtifactReadManifestDraft: ToolManifestDraft = {
  name: ARTIFACT_READ_TOOL_NAME,
  title: "Lire un artefact",
  description: "Récupère un artefact depuis l'outbox d'un enfant avec gestion des budgets et diagnostics.",
  kind: "dynamic",
  category: "artifact",
  tags: ["facade", "authoring"],
  hidden: false,
  budgets: {
    time_ms: 3_000,
    tool_calls: 1,
    bytes_out: 16_384,
  },
};

/** Context forwarded to the façade handler. */
export interface ArtifactReadToolContext {
  readonly logger: StructuredLogger;
  readonly childrenRoot: string;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Serialises a JSON payload suitable for the textual MCP channel. */
function asJsonPayload(result: ArtifactReadOutput): string {
  return JSON.stringify({ tool: ARTIFACT_READ_TOOL_NAME, result }, null, 2);
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
  path: string,
  metadata: Record<string, unknown> | undefined,
  error: BudgetExceededError,
): ArtifactReadOutput {
  const diagnostic = ArtifactBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });
  return ArtifactReadOutputSchema.parse({
    ok: false,
    summary: "budget épuisé lors de la lecture de l'artefact",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      path,
      budget: diagnostic,
      ...(metadata ? { metadata } : {}),
    },
  });
}

/** Builds a degraded payload describing an artifact that could not be located. */
function buildNotFoundResult(
  idempotencyKey: string,
  childId: string,
  path: string,
  metadata: Record<string, unknown> | undefined,
): ArtifactReadOutput {
  const diagnostic = ArtifactOperationErrorSchema.parse({
    reason: "artifact_not_found",
    message: "aucun artefact ne correspond au chemin fourni",
    retryable: false,
  });
  return ArtifactReadOutputSchema.parse({
    ok: false,
    summary: "artefact introuvable",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      path,
      error: diagnostic,
      ...(metadata ? { metadata } : {}),
    },
  });
}

/** Builds a degraded payload for IO failures unrelated to missing files. */
function buildIoErrorResult(
  idempotencyKey: string,
  childId: string,
  path: string,
  metadata: Record<string, unknown> | undefined,
  error: unknown,
): ArtifactReadOutput {
  const diagnostic = ArtifactOperationErrorSchema.parse({
    reason: "io_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
  return ArtifactReadOutputSchema.parse({
    ok: false,
    summary: "échec de la lecture de l'artefact",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      path,
      error: diagnostic,
      ...(metadata ? { metadata } : {}),
    },
  });
}

function buildInvalidPathResult(
  idempotencyKey: string,
  childId: string,
  path: string,
  metadata: Record<string, unknown> | undefined,
): ArtifactReadOutput {
  const diagnostic = ArtifactOperationErrorSchema.parse({
    reason: "io_error",
    message: "chemin d'artefact invalide",
    retryable: false,
  });
  return ArtifactReadOutputSchema.parse({
    ok: false,
    summary: "chemin d'artefact invalide",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      path,
      error: diagnostic,
      ...(metadata ? { metadata } : {}),
    },
  });
}

/**
 * Factory returning the MCP handler that powers the `artifact_read` façade.
 */
export function createArtifactReadHandler(context: ArtifactReadToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = ArtifactReadInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = cloneMetadata(parsed.metadata);

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const format = parsed.format ?? "text";
    const encoding = (parsed.encoding ?? "utf8") as BufferEncoding;

    let sanitizedPath;
    try {
      sanitizedPath = sanitizeArtifactPath(context.childrenRoot, parsed.child_id, parsed.path);
    } catch (error) {
      const redacted = redactPathForLogs(parsed.path);
      context.logger.warn("artifact_read_invalid_path", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        child_id: parsed.child_id,
        path_hash: redacted,
        error: error instanceof Error ? error.message : String(error),
      });
      const degraded = buildInvalidPathResult(idempotencyKey, parsed.child_id, parsed.path, metadata);
      return {
        isError: true,
        content: [{ type: "text", text: asJsonPayload(degraded) }],
        structuredContent: degraded,
      };
    }

    const pathLogFields = buildPathLogFields(sanitizedPath);

    let toolCallCharge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        toolCallCharge = rpcContext.budget.consume(
          { toolCalls: 1 },
          { actor: "facade", operation: ARTIFACT_READ_TOOL_NAME, detail: "read_artifact" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          context.logger.warn("artifact_read_budget_exhausted", {
            request_id: rpcContext.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: parsed.child_id,
            ...pathLogFields,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          const degraded = buildBudgetExceededResult(
            idempotencyKey,
            parsed.child_id,
            sanitizedPath.relative,
            metadata,
            error,
          );
          return {
            isError: true,
            content: [{ type: "text", text: asJsonPayload(degraded) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    let buffer: Buffer;
    try {
      const value = await readArtifact({
        childrenRoot: context.childrenRoot,
        childId: parsed.child_id,
        relativePath: sanitizedPath.relative,
      });
      buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        if (rpcContext?.budget && toolCallCharge) {
          rpcContext.budget.refund(toolCallCharge);
        }
        context.logger.warn("artifact_read_not_found", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          child_id: parsed.child_id,
          ...pathLogFields,
        });
        const degraded = buildNotFoundResult(
          idempotencyKey,
          parsed.child_id,
          sanitizedPath.relative,
          metadata,
        );
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(degraded) }],
          structuredContent: degraded,
        };
      }
      if (rpcContext?.budget && toolCallCharge) {
        rpcContext.budget.refund(toolCallCharge);
      }
      context.logger.error("artifact_read_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        child_id: parsed.child_id,
        ...pathLogFields,
        error: error instanceof Error ? error.message : String(error),
      });
      const degraded = buildIoErrorResult(
        idempotencyKey,
        parsed.child_id,
        sanitizedPath.relative,
        metadata,
        error,
      );
      return {
        isError: true,
        content: [{ type: "text", text: asJsonPayload(degraded) }],
        structuredContent: degraded,
      };
    }

    const size = buffer.length;
    const limit = parsed.max_bytes ?? size;
    const truncated = size > limit;
    const payloadBuffer = truncated ? buffer.subarray(0, limit) : buffer;
    const bytesReturned = payloadBuffer.length;

    if (rpcContext?.budget && bytesReturned > 0) {
      try {
        rpcContext.budget.consume(
          { bytesOut: bytesReturned },
          { actor: "facade", operation: ARTIFACT_READ_TOOL_NAME, detail: "emit_artifact" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          context.logger.warn("artifact_read_bytes_budget_exhausted", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: parsed.child_id,
            ...pathLogFields,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          const degraded = buildBudgetExceededResult(
            idempotencyKey,
            parsed.child_id,
            sanitizedPath.relative,
            metadata,
            error,
          );
          return {
            isError: true,
            content: [{ type: "text", text: asJsonPayload(degraded) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    let content: string | undefined;
    if (format === "base64") {
      content = payloadBuffer.toString("base64");
    } else {
      content = payloadBuffer.toString(encoding);
    }

    const structured = ArtifactReadOutputSchema.parse({
      ok: true,
      summary: truncated ? `artefact lu (tronqué à ${bytesReturned} octets)` : "artefact lu",
      details: {
        idempotency_key: idempotencyKey,
        child_id: parsed.child_id,
        path: sanitizedPath.relative,
        format,
        bytes_returned: bytesReturned,
        size,
        sha256,
        content,
        ...(truncated ? { truncated: true } : {}),
        ...(metadata ? { metadata } : {}),
      },
    });

    context.logger.info("artifact_read_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      child_id: parsed.child_id,
      ...pathLogFields,
      format,
      bytes_returned: bytesReturned,
      truncated,
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
export async function registerArtifactReadTool(
  registry: ToolRegistry,
  context: ArtifactReadToolContext,
): Promise<ToolManifest> {
  return await registry.register(ArtifactReadManifestDraft, createArtifactReadHandler(context), {
    inputSchema: ArtifactReadInputSchema.shape,
    outputSchema: ArtifactReadOutputSchema.shape,
    annotations: { intent: "artifact_read" },
  });
}
