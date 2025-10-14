import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { writeArtifact } from "../artifacts.js";
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
import {
  ArtifactBudgetDiagnosticSchema,
  ArtifactOperationErrorSchema,
  ArtifactWriteInputSchema,
  ArtifactWriteOutputSchema,
  type ArtifactWriteOutput,
} from "../rpc/artifactSchemas.js";

/** Canonical name advertised by the façade manifest. */
export const ARTIFACT_WRITE_TOOL_NAME = "artifact_write" as const;

/** Default manifest registered with the tool catalogue. */
export const ArtifactWriteManifestDraft: ToolManifestDraft = {
  name: ARTIFACT_WRITE_TOOL_NAME,
  title: "Enregistrer un artefact",
  description: "Persiste un artefact dans l'outbox d'un enfant en respectant l'idempotence et les budgets.",
  kind: "dynamic",
  category: "artifact",
  tags: ["facade", "authoring"],
  hidden: false,
  budgets: {
    time_ms: 5_000,
    tool_calls: 1,
    bytes_out: 8_192,
  },
};

/** Context forwarded to the façade handler. */
export interface ArtifactWriteToolContext {
  /** Structured logger complying with the observability checklist. */
  readonly logger: StructuredLogger;
  /** Root directory that stores child workspaces (logs, artefacts, …). */
  readonly childrenRoot: string;
  /** Optional idempotency registry replaying cached write results. */
  readonly idempotency?: IdempotencyRegistry;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Snapshot cached in the idempotency registry so replays can surface the same
 * payload without re-executing filesystem writes.
 */
interface ArtifactWriteSnapshot {
  readonly bytesWritten: number;
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
  readonly sha256: string;
}

/** Serialises a JSON payload suitable for the textual MCP channel. */
function asJsonPayload(result: ArtifactWriteOutput): string {
  return JSON.stringify({ tool: ARTIFACT_WRITE_TOOL_NAME, result }, null, 2);
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
): ArtifactWriteOutput {
  const diagnostic = ArtifactBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });
  return ArtifactWriteOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant l'écriture de l'artefact",
    details: {
      idempotency_key: idempotencyKey,
      child_id: childId,
      path,
      budget: diagnostic,
      ...(metadata ? { metadata } : {}),
    },
  });
}

/** Builds a degraded payload describing an IO failure. */
function buildIoErrorResult(
  idempotencyKey: string,
  childId: string,
  path: string,
  metadata: Record<string, unknown> | undefined,
  error: unknown,
): ArtifactWriteOutput {
  const diagnostic = ArtifactOperationErrorSchema.parse({
    reason: "io_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  });
  return ArtifactWriteOutputSchema.parse({
    ok: false,
    summary: "échec de l'écriture de l'artefact",
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
 * Factory returning the MCP handler that powers the `artifact_write` façade.
 */
export function createArtifactWriteHandler(context: ArtifactWriteToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = ArtifactWriteInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = cloneMetadata(parsed.metadata);

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const encoding = (parsed.encoding ?? "utf8") as BufferEncoding;
    const buffer = Buffer.from(parsed.content, encoding);
    const bytesIn = buffer.byteLength;

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, bytesIn },
          { actor: "facade", operation: ARTIFACT_WRITE_TOOL_NAME, detail: "write_artifact" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          context.logger.warn("artifact_write_budget_exhausted", {
            request_id: rpcContext.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: parsed.child_id,
            path: parsed.path,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          const degraded = buildBudgetExceededResult(idempotencyKey, parsed.child_id, parsed.path, metadata, error);
          return {
            isError: true,
            content: [{ type: "text", text: asJsonPayload(degraded) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    const fingerprint = {
      child_id: parsed.child_id,
      path: parsed.path,
      mime_type: parsed.mime_type,
      encoding,
      content_sha256: createHash("sha256").update(buffer).digest("hex"),
    };

    const executeWrite = async (): Promise<ArtifactWriteSnapshot> => {
      try {
        const entry = await writeArtifact({
          childrenRoot: context.childrenRoot,
          childId: parsed.child_id,
          relativePath: parsed.path,
          data: buffer,
          mimeType: parsed.mime_type,
          encoding,
        });
        return {
          bytesWritten: bytesIn,
          path: entry.path,
          size: entry.size,
          mimeType: entry.mimeType,
          sha256: entry.sha256,
        };
      } catch (error) {
        if (rpcContext?.budget && charge) {
          rpcContext.budget.refund(charge);
        }
        context.logger.error("artifact_write_failed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          child_id: parsed.child_id,
          path: parsed.path,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    let snapshot: ArtifactWriteSnapshot;
    let idempotent = false;
    if (context.idempotency) {
      const cacheKey = buildIdempotencyCacheKey(ARTIFACT_WRITE_TOOL_NAME, idempotencyKey, fingerprint);
      try {
        const hit = await context.idempotency.remember(cacheKey, executeWrite);
        snapshot = hit.value;
        idempotent = hit.idempotent;
      } catch (error) {
        const degraded = buildIoErrorResult(idempotencyKey, parsed.child_id, parsed.path, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(degraded) }],
          structuredContent: degraded,
        };
      }
    } else {
      try {
        snapshot = await executeWrite();
      } catch (error) {
        const degraded = buildIoErrorResult(idempotencyKey, parsed.child_id, parsed.path, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(degraded) }],
          structuredContent: degraded,
        };
      }
    }

    const structured = ArtifactWriteOutputSchema.parse({
      ok: true,
      summary: idempotent ? "artefact rejoué depuis le cache d'idempotence" : "artefact persistant dans l'outbox",
      details: {
        idempotency_key: idempotencyKey,
        child_id: parsed.child_id,
        path: snapshot.path,
        bytes_written: snapshot.bytesWritten,
        size: snapshot.size,
        mime_type: snapshot.mimeType,
        sha256: snapshot.sha256,
        idempotent,
        ...(metadata ? { metadata } : {}),
      },
    });

    context.logger.info("artifact_write_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      child_id: parsed.child_id,
      path: snapshot.path,
      bytes_written: snapshot.bytesWritten,
      idempotent,
      mime_type: snapshot.mimeType,
      sha256: snapshot.sha256,
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
export async function registerArtifactWriteTool(
  registry: ToolRegistry,
  context: ArtifactWriteToolContext,
): Promise<ToolManifest> {
  return await registry.register(ArtifactWriteManifestDraft, createArtifactWriteHandler(context), {
    inputSchema: ArtifactWriteInputSchema.shape,
    outputSchema: ArtifactWriteOutputSchema.shape,
    annotations: { intent: "artifact_write" },
  });
}
