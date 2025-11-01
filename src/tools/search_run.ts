import { createHash, randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
  type SearchJobError,
  type SearchJobParameters,
  type SearchJobResult,
} from "../search/index.js";
import {
  SearchRunDocumentSchema,
  SearchRunErrorSchema,
  SearchRunInputSchema,
  SearchRunOutputSchema,
} from "../rpc/searchSchemas.js";
import { buildToolErrorResult, buildToolSuccessResult, formatBudgetUsage } from "./shared.js";

/** Canonical façade identifier registered with the MCP server. */
export const SEARCH_RUN_TOOL_NAME = "search.run" as const;

/**
 * Manifest draft describing the high level capabilities of the façade. The
 * conservative budget mirrors the cost of orchestrating a full web crawl while
 * leaving enough headroom for media-heavy documents.
 */
export const SearchRunManifestDraft: ToolManifestDraft = {
  name: SEARCH_RUN_TOOL_NAME,
  title: "Recherche web structurée",
  description:
    "Interroge SearxNG, extrait les contenus pertinents puis les ingère dans le graphe de connaissances et l'index vectoriel. Exemple : search.run {\"query\":\"site:arxiv.org rag pdf\"}",
  kind: "dynamic",
  category: "runtime",
  tags: ["search", "web", "ingest", "rag"],
  hidden: false,
  budgets: {
    time_ms: 90_000,
    tool_calls: 1,
    bytes_out: 96_000,
  },
};

/** Context injected when binding the search façade. */
export interface SearchRunToolContext {
  /** High level orchestrator wrapping Searx, fetching and ingestion. */
  readonly pipeline: SearchPipeline;
  /** Structured logger forwarded to emit detailed diagnostics. */
  readonly logger: StructuredLogger;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ParsedInput = z.infer<typeof SearchRunInputSchema>;

type SearchRunOutput = z.infer<typeof SearchRunOutputSchema>;
type SearchRunSuccessOutput = Extract<SearchRunOutput, { ok: true }>;
type SearchRunBudgetFailureOutput = Extract<SearchRunOutput, { ok: false; reason: "budget_exhausted" }>;
type SearchRunOperationFailureOutput = Extract<SearchRunOutput, { ok: false; reason: "operation_failed" }>;

/** Serialises the façade response for textual transports. */
function asJsonPayload(payload: unknown): string {
  return JSON.stringify({ tool: SEARCH_RUN_TOOL_NAME, result: payload }, null, 2);
}

/** Builds the degraded response returned when the request exhausts its budget. */
function buildBudgetExceededResponse(
  idempotencyKey: string,
  error: BudgetExceededError,
): SearchRunBudgetFailureOutput {
  return SearchRunOutputSchema.parse({
    ok: false,
    idempotency_key: idempotencyKey,
    summary: "budget épuisé avant la recherche",
    reason: "budget_exhausted" as const,
    count: 0,
    docs: [],
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  }) as SearchRunBudgetFailureOutput;
}

/** Builds the degraded response returned when the pipeline throws. */
function buildOperationFailedResponse(
  idempotencyKey: string,
  message: string,
): SearchRunOperationFailureOutput {
  return SearchRunOutputSchema.parse({
    ok: false,
    idempotency_key: idempotencyKey,
    summary: "échec du pipeline de recherche",
    reason: "operation_failed" as const,
    count: 0,
    docs: [],
    message,
  }) as SearchRunOperationFailureOutput;
}

/** Maps pipeline job results to the façade JSON payload. */
function buildSuccessResponse(
  idempotencyKey: string,
  job: SearchJobResult,
  budgetUsed: ReturnType<typeof formatBudgetUsage>,
): SearchRunSuccessOutput {
  const docs = job.documents.map((doc) =>
    SearchRunDocumentSchema.parse({
      id: doc.id,
      url: doc.url,
      title: doc.title,
      language: doc.language,
    }),
  );

  const warnings = job.errors.map((error) => normaliseJobWarning(error));

  return SearchRunOutputSchema.parse({
    ok: true,
    idempotency_key: idempotencyKey,
    summary: `recherche terminée (${docs.length} document${docs.length > 1 ? "s" : ""})`,
    job_id: job.jobId,
    count: docs.length,
    docs,
    ...(warnings.length > 0 ? { warnings } : {}),
    stats: {
      requested: job.stats.requestedResults,
      received: job.stats.receivedResults,
      fetched: job.stats.fetchedDocuments,
      structured: job.stats.structuredDocuments,
      graph_ingested: job.stats.graphIngested,
      vector_ingested: job.stats.vectorIngested,
    },
    ...(budgetUsed ? { budget_used: budgetUsed } : {}),
  }) as SearchRunSuccessOutput;
}

/** Normalises pipeline errors so they pass schema validation. */
function normaliseJobWarning(error: SearchJobError) {
  return SearchRunErrorSchema.parse({
    stage: error.stage,
    url: error.url,
    message: error.message,
    code: error.code,
  });
}

/**
 * Factory returning the MCP handler that powers the `search.run` façade.
 */
export function createSearchRunHandler(context: SearchRunToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed = SearchRunInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const deterministicKey = deriveDeterministicIdempotencyKey(parsed);
    const idempotencyKey = resolveIdempotencyKey(
      parsed.idempotency_key,
      rpcContext?.idempotencyKey,
      deterministicKey,
    );

    const tokenEstimate = estimateTokenUsage(parsed.query) + estimateTokenUsage(parsed.categories ?? []) + estimateTokenUsage(parsed.engines ?? []);

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, tokens: tokenEstimate },
          { actor: "facade", operation: SEARCH_RUN_TOOL_NAME, detail: "search.run" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const degraded = buildBudgetExceededResponse(idempotencyKey, error);
          context.logger.warn("search_run_budget_exhausted", {
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

    const jobParameters: SearchJobParameters = {
      query: parsed.query,
      ...(parsed.categories ? { categories: parsed.categories } : {}),
      ...(parsed.engines ? { engines: parsed.engines } : {}),
      maxResults: parsed.max_results,
      ...(parsed.language ? { language: parsed.language } : {}),
      ...(parsed.safe_search !== undefined ? { safeSearch: parsed.safe_search } : {}),
      ...(parsed.job_id ? { jobId: parsed.job_id } : {}),
      ...(parsed.fetch_content !== undefined ? { fetchContent: parsed.fetch_content } : {}),
      ...(parsed.inject_graph !== undefined ? { injectGraph: parsed.inject_graph } : {}),
      ...(parsed.inject_vector !== undefined ? { injectVector: parsed.inject_vector } : {}),
    };

    let result: SearchJobResult;
    try {
      result = await context.pipeline.runSearchJob(jobParameters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const degraded = buildOperationFailedResponse(idempotencyKey, message);
      context.logger.error("search_run_pipeline_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        idempotency_key: idempotencyKey,
        error: message,
      });
      return buildToolErrorResult(asJsonPayload(degraded), degraded);
    }

    const structured = buildSuccessResponse(idempotencyKey, result, formatBudgetUsage(charge));

    context.logger.info("search_run_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      idempotency_key: idempotencyKey,
      query_length: parsed.query.length,
      categories: parsed.categories ?? null,
      engines: parsed.engines ?? null,
      documents: structured.count,
      warnings: structured.warnings?.length ?? 0,
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
export async function registerSearchRunTool(
  registry: ToolRegistry,
  context: SearchRunToolContext,
): Promise<ToolManifest> {
  return await registry.register(SearchRunManifestDraft, createSearchRunHandler(context), {
    inputSchema: SearchRunInputSchema.shape,
    annotations: { intent: SEARCH_RUN_TOOL_NAME },
    meta: {
      help: 'search.run {"query":"site:arxiv.org rag pdf"}',
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
 * Produces a deterministic idempotency key derived from the structured input.
 * The helper keeps the payload intentionally small to avoid leaking optional
 * metadata such as job identifiers while still capturing every flag that
 * impacts the pipeline behaviour.
 */
function deriveDeterministicIdempotencyKey(parsed: ParsedInput): string | null {
  try {
    const fingerprint = {
      query: parsed.query,
      categories: parsed.categories ?? [],
      engines: parsed.engines ?? [],
      max_results: parsed.max_results ?? null,
      language: parsed.language ?? null,
      safe_search: parsed.safe_search ?? null,
      fetch_content: parsed.fetch_content ?? null,
      inject_graph: parsed.inject_graph ?? null,
      inject_vector: parsed.inject_vector ?? null,
    } satisfies Record<string, unknown>;
    const digest = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    return `search.run:${digest}`;
  } catch {
    return null;
  }
}

