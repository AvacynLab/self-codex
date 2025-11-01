import { createHash, randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

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
  SearchPipeline,
  type DirectIngestParameters,
  type SearchJobError,
} from "../search/index.js";
import {
  SearchIndexDocumentSchema,
  SearchIndexInputSchema,
  SearchIndexOutputSchema,
  SearchRunErrorSchema,
} from "../rpc/searchSchemas.js";
import type { SearchIndexDocument, SearchIndexInput, SearchIndexOutput } from "../rpc/searchSchemas.js";
import { buildToolErrorResult, buildToolSuccessResult, formatBudgetUsage } from "./shared.js";

/** Canonical façade identifier registered with the MCP server. */
export const SEARCH_INDEX_TOOL_NAME = "search.index" as const;

/**
 * Manifest describing the capability exposed by the indexing façade. The
 * budgets are intentionally tighter than `search.run` as the operation skips
 * the Searx query phase and only orchestrates fetching/extraction/ingestion.
 */
export const SearchIndexManifestDraft: ToolManifestDraft = {
  name: SEARCH_INDEX_TOOL_NAME,
  title: "Indexation directe d'URL",
  description:
    "Télécharge et structure une liste d'URL puis ingère les documents dans le graphe de connaissances et l'index vectoriel. Exemple : search.index {\"urls\":[\"https://example.org\"]}",
  kind: "dynamic",
  category: "runtime",
  tags: ["search", "web", "ingest", "rag"],
  hidden: false,
  budgets: {
    time_ms: 90_000,
    tool_calls: 1,
    bytes_out: 64_000,
  },
};

/** Dependencies required by the indexing façade. */
export interface SearchIndexToolContext {
  readonly pipeline: SearchPipeline;
  readonly logger: StructuredLogger;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ParsedInput = SearchIndexInput;

type SearchIndexSuccessOutput = Extract<SearchIndexOutput, { ok: true }>;
type SearchIndexBudgetFailureOutput = Extract<SearchIndexOutput, { ok: false; reason: "budget_exhausted" }>;
type SearchIndexOperationFailureOutput = Extract<SearchIndexOutput, { ok: false; reason: "operation_failed" }>;

/** Serialises the façade response for textual transports. */
function asJsonPayload(payload: unknown): string {
  return JSON.stringify({ tool: SEARCH_INDEX_TOOL_NAME, result: payload }, null, 2);
}

/** Builds the degraded response returned when the request exhausts its budget. */
function buildBudgetExceededResponse(
  idempotencyKey: string,
  error: BudgetExceededError,
): SearchIndexBudgetFailureOutput {
  return SearchIndexOutputSchema.parse({
    ok: false,
    idempotency_key: idempotencyKey,
    summary: "budget épuisé avant l'indexation",
    reason: "budget_exhausted" as const,
    count: 0,
    docs: [],
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  }) as SearchIndexBudgetFailureOutput;
}

/** Builds the degraded response returned when the pipeline throws. */
function buildOperationFailedResponse(
  idempotencyKey: string,
  message: string,
): SearchIndexOperationFailureOutput {
  return SearchIndexOutputSchema.parse({
    ok: false,
    idempotency_key: idempotencyKey,
    summary: "échec de l'indexation directe",
    reason: "operation_failed" as const,
    count: 0,
    docs: [],
    message,
  }) as SearchIndexOperationFailureOutput;
}

/** Maps pipeline errors to the shared schema used by search façades. */
function normaliseJobError(error: SearchJobError) {
  return SearchRunErrorSchema.parse({
    stage: error.stage,
    url: error.url,
    message: error.message,
    code: error.code,
  });
}

/** Builds the success payload returned when the ingestion completes. */
function buildSuccessResponse(
  idempotencyKey: string,
  result: Awaited<ReturnType<SearchPipeline["ingestDirect"]>>,
  budgetUsed: ReturnType<typeof formatBudgetUsage>,
): SearchIndexSuccessOutput {
  const docs: Array<SearchIndexDocument> = result.documents.map((doc) =>
    SearchIndexDocumentSchema.parse({
      id: doc.id,
      url: doc.url,
      title: doc.title,
    }),
  );

  const errors = result.errors.map((error) => normaliseJobError(error));

  return SearchIndexOutputSchema.parse({
    ok: true,
    idempotency_key: idempotencyKey,
    summary: `indexation terminée (${docs.length} document${docs.length > 1 ? "s" : ""})`,
    job_id: result.jobId,
    count: docs.length,
    docs,
    ...(errors.length > 0 ? { errors } : {}),
    stats: {
      requested: result.stats.requestedResults,
      received: result.stats.receivedResults,
      fetched: result.stats.fetchedDocuments,
      structured: result.stats.structuredDocuments,
      graph_ingested: result.stats.graphIngested,
      vector_ingested: result.stats.vectorIngested,
    },
    ...(budgetUsed ? { budget_used: budgetUsed } : {}),
  }) as SearchIndexSuccessOutput;
}

/**
 * Accepts legacy payloads that use `url`/`urls` fields and converts them to the
 * canonical `items` array before Zod validation. The helper keeps backwards
 * compatibility with early clients while ensuring the handler only deals with
 * the modern schema internally.
 */
function normaliseIndexInputPayload(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const source = input as Record<string, unknown>;
  if (Array.isArray(source.items)) {
    return input;
  }

  const urls = new Set<string>();

  const pushUrl = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      urls.add(trimmed);
    }
  };

  pushUrl(source.url);
  const rawUrls = source.urls;
  if (Array.isArray(rawUrls)) {
    for (const entry of rawUrls) {
      pushUrl(entry);
    }
  } else {
    pushUrl(rawUrls);
  }

  if (urls.size === 0) {
    return input;
  }

  const rest: Record<string, unknown> = { ...source };
  delete rest.url;
  delete rest.urls;

  return {
    ...rest,
    items: Array.from(urls).map((url) => ({ url })),
  };
}

/**
 * Factory returning the MCP handler that powers the `search.index` façade.
 */
export function createSearchIndexHandler(context: SearchIndexToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed: ParsedInput = SearchIndexInputSchema.parse(normaliseIndexInputPayload(input));
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const deterministicKey = deriveDeterministicIdempotencyKey(parsed);
    const idempotencyKey = resolveIdempotencyKey(
      parsed.idempotency_key,
      rpcContext?.idempotencyKey,
      deterministicKey,
    );

    const tokenEstimate =
      estimateTokenUsage(parsed.label ?? "") +
      parsed.items.reduce((acc, item) => acc + estimateTokenUsage(item.url), 0);

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, tokens: tokenEstimate },
          { actor: "facade", operation: SEARCH_INDEX_TOOL_NAME, detail: "search.index" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const degraded = buildBudgetExceededResponse(idempotencyKey, error);
          context.logger.warn("search_index_budget_exhausted", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            idempotency_key: idempotencyKey,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          return buildToolErrorResult(asJsonPayload(degraded), degraded);
        }
        throw error;
      }
    }

    const ingestParameters: DirectIngestParameters = {
      sources: parsed.items.map((item) => ({
        url: item.url,
        title: item.title ?? null,
        snippet: item.snippet ?? null,
        categories: item.categories ?? [],
        engines: item.engines ?? [],
        ...(item.position !== undefined ? { position: item.position } : {}),
      })),
      ...(parsed.job_id ? { jobId: parsed.job_id } : {}),
      ...(parsed.label ? { label: parsed.label } : {}),
      ...(parsed.inject_graph !== undefined ? { injectGraph: parsed.inject_graph } : {}),
      ...(parsed.inject_vector !== undefined ? { injectVector: parsed.inject_vector } : {}),
    };

    let result: Awaited<ReturnType<SearchPipeline["ingestDirect"]>>;
    try {
      result = await context.pipeline.ingestDirect(ingestParameters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const degraded = buildOperationFailedResponse(idempotencyKey, message);
      context.logger.error("search_index_pipeline_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        idempotency_key: idempotencyKey,
        error: message,
      });
      return buildToolErrorResult(asJsonPayload(degraded), degraded);
    }

    const structured = buildSuccessResponse(idempotencyKey, result, formatBudgetUsage(charge));

    context.logger.info("search_index_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      idempotency_key: idempotencyKey,
      items: parsed.items.length,
      documents: structured.count,
      errors: structured.errors?.length ?? 0,
      stats: structured.stats,
      budget_used: structured.budget_used ?? null,
    });

    if (rpcContext?.budget && charge) {
      rpcContext.budget.snapshot();
    }

    return buildToolSuccessResult(asJsonPayload(structured), structured);
  };
}

/** Registers the façade with the tool registry. */
export async function registerSearchIndexTool(
  registry: ToolRegistry,
  context: SearchIndexToolContext,
): Promise<ToolManifest> {
  return await registry.register(SearchIndexManifestDraft, createSearchIndexHandler(context), {
    inputSchema: SearchIndexInputSchema.shape,
    annotations: { intent: SEARCH_INDEX_TOOL_NAME },
    meta: {
      help: 'search.index {"urls":["https://example.org"]}',
    },
  });
}

function resolveIdempotencyKey(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return randomUUID();
}

/**
 * Generates a stable idempotency key derived from the manual ingestion input.
 * Ordering is preserved so callers can trigger a reindex by submitting the
 * same URLs with different sequencing or flags without collisions.
 */
function deriveDeterministicIdempotencyKey(parsed: ParsedInput): string | null {
  try {
    const fingerprint = {
      label: parsed.label ?? null,
      inject_graph: parsed.inject_graph ?? null,
      inject_vector: parsed.inject_vector ?? null,
      items: parsed.items.map((item) => ({
        url: item.url,
        title: item.title ?? null,
        snippet: item.snippet ?? null,
        categories: item.categories ?? [],
        engines: item.engines ?? [],
        position: item.position ?? null,
      })),
    } satisfies Record<string, unknown>;
    const digest = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    return `search.index:${digest}`;
  } catch {
    return null;
  }
}
