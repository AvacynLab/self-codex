import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

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
  SearchStatusInputSchema,
  SearchStatusInputShape,
  SearchStatusJobRecord,
  SearchStatusOutputSchema,
} from "../rpc/searchSchemas.js";
import type { SearchStatusInput, SearchStatusOutput } from "../rpc/searchSchemas.js";
import type { JobRecord, JobStatus, ListFilter, SearchJobStore } from "../search/jobStore.js";
import { buildToolSuccessResult } from "./shared.js";

/** Canonical façade identifier registered with the MCP server. */
export const SEARCH_STATUS_TOOL_NAME = "search.status" as const;

/** Manifest describing the current (degraded) capabilities of the façade. */
export const SearchStatusManifestDraft: ToolManifestDraft = {
  name: SEARCH_STATUS_TOOL_NAME,
  title: "Statut des recherches",
  description:
    "Retourne l'état détaillé d'un job de recherche ou liste les exécutions récentes selon des filtres (statut, tags, période). Exemple : search.status {\"status\":\"running\"}",
  kind: "dynamic",
  category: "runtime",
  tags: ["search", "web", "ops"],
  hidden: false,
  budgets: {
    time_ms: 5_000,
    tool_calls: 1,
    bytes_out: 8_000,
  },
};

/** Default maximum number of job records returned when filters omit `limit`. */
const DEFAULT_SEARCH_STATUS_LIMIT = 25;

/** Dependencies injected when binding the façade. */
export interface SearchStatusToolContext {
  readonly logger: StructuredLogger;
  readonly jobStore: SearchJobStore | null;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function dedupeStatuses(status: JobStatus | readonly JobStatus[]): JobStatus | readonly JobStatus[] {
  if (!Array.isArray(status)) {
    return status;
  }
  const unique = Array.from(new Set(status));
  return unique.length === 1 ? unique[0]! : unique;
}

function normaliseTags(values: readonly string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const trimmed = Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildListFilter(input: SearchStatusInput): ListFilter {
  const tag = input.tag?.trim();
  const tags = normaliseTags(input.tags);
  return {
    limit: input.limit ?? DEFAULT_SEARCH_STATUS_LIMIT,
    ...(input.status !== undefined ? { status: dedupeStatuses(input.status) } : {}),
    ...(tag && tag.length > 0 ? { tag } : {}),
    ...(tags ? { tags } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
  } satisfies ListFilter;
}

function serialiseJobRecord(record: JobRecord): SearchStatusJobRecord {
  const { meta, state, provenance } = record;
  return {
    job_id: meta.id,
    meta: {
      id: meta.id,
      created_at: meta.createdAt,
      query: meta.query,
      normalized_query: meta.normalizedQuery,
      tags: [...meta.tags],
      requester: meta.requester ?? null,
      budget: {
        max_duration_ms: meta.budget.maxDurationMs ?? null,
        max_tool_calls: meta.budget.maxToolCalls ?? null,
        max_bytes_out: meta.budget.maxBytesOut ?? null,
      },
    },
    state: {
      status: state.status,
      created_at: state.createdAt,
      updated_at: state.updatedAt,
      started_at: state.startedAt ?? null,
      completed_at: state.completedAt ?? null,
      failed_at: state.failedAt ?? null,
      progress: state.progress
        ? {
            step: state.progress.step,
            message: state.progress.message ?? null,
            ratio: state.progress.ratio ?? null,
            updated_at: state.progress.updatedAt,
          }
        : null,
      summary: state.summary
        ? {
            considered_results: state.summary.consideredResults,
            fetched_documents: state.summary.fetchedDocuments,
            ingested_documents: state.summary.ingestedDocuments,
            skipped_documents: state.summary.skippedDocuments,
            artifacts: [...state.summary.artifacts],
            metrics: { ...state.summary.metrics },
            notes: state.summary.notes ?? null,
          }
        : null,
      errors: state.errors.map((failure) => ({
        code: failure.code,
        message: failure.message,
        stage: failure.stage ?? null,
        occurred_at: failure.occurredAt,
        details: failure.details ?? null,
      })),
    },
    provenance: {
      trigger: provenance.trigger,
      transport: provenance.transport,
      request_id: provenance.requestId ?? null,
      requester: provenance.requester ?? null,
      remote_address: provenance.remoteAddress ?? null,
      extra: { ...provenance.extra },
    },
  } satisfies SearchStatusJobRecord;
}

/**
 * Factory returning the handler for the `search.status` façade. The handler
 * inspects the configured job store and either retrieves a single job or lists
 * matching records while guaranteeing that the structured payload matches the
 * published schema (no `undefined`, camelCase → snake_case conversion).
 */
export function createSearchStatusHandler(context: SearchStatusToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed: SearchStatusInput = SearchStatusInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const baseLogContext = {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      job_id: parsed.job_id ?? null,
    } as const;

    if (!context.jobStore) {
      const payload: SearchStatusOutput = SearchStatusOutputSchema.parse({
        ok: false,
        code: "persistence_unavailable" as const,
        message: "la persistance des jobs de recherche est désactivée ou indisponible",
      });
      context.logger.warn("search_status_persistence_unavailable", baseLogContext);
      return buildToolSuccessResult(
        JSON.stringify({ tool: SEARCH_STATUS_TOOL_NAME, result: payload }, null, 2),
        payload,
      );
    }

    if (parsed.job_id) {
      const record = await context.jobStore.get(parsed.job_id);
      if (!record) {
        const payload: SearchStatusOutput = SearchStatusOutputSchema.parse({
          ok: false,
          code: "not_found" as const,
          message: `aucun job trouvé pour l'identifiant ${parsed.job_id}`,
        });
        context.logger.warn("search_status_job_not_found", baseLogContext);
        return buildToolSuccessResult(
          JSON.stringify({ tool: SEARCH_STATUS_TOOL_NAME, result: payload }, null, 2),
          payload,
        );
      }

      const payload: SearchStatusOutput = SearchStatusOutputSchema.parse({
        ok: true,
        result: serialiseJobRecord(record),
      });
      context.logger.info("search_status_job_resolved", {
        ...baseLogContext,
        status: record.state.status,
      });
      return buildToolSuccessResult(
        JSON.stringify({ tool: SEARCH_STATUS_TOOL_NAME, result: payload }, null, 2),
        payload,
      );
    }

    const filter = buildListFilter(parsed);
    const records = await context.jobStore.list(filter);
    const payload: SearchStatusOutput = SearchStatusOutputSchema.parse({
      ok: true,
      result: records.map(serialiseJobRecord),
    });
    context.logger.info("search_status_list_resolved", {
      ...baseLogContext,
      filters: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.tag ? { tag: filter.tag } : {}),
        ...(filter.tags ? { tags: filter.tags } : {}),
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        limit: filter.limit ?? DEFAULT_SEARCH_STATUS_LIMIT,
      },
      results: records.length,
    });
    return buildToolSuccessResult(
      JSON.stringify({ tool: SEARCH_STATUS_TOOL_NAME, result: payload }, null, 2),
      payload,
    );
  };
}

/** Registers the façade with the tool registry. */
export async function registerSearchStatusTool(
  registry: ToolRegistry,
  context: SearchStatusToolContext,
): Promise<ToolManifest> {
  return await registry.register(SearchStatusManifestDraft, createSearchStatusHandler(context), {
    inputSchema: SearchStatusInputShape,
    annotations: { intent: SEARCH_STATUS_TOOL_NAME },
    meta: {
      help: 'search.status {"job_id":"search:job:123"}',
    },
  });
}
