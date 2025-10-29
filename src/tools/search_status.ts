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
  SearchStatusOutputSchema,
} from "../rpc/searchSchemas.js";
import type { SearchStatusInput, SearchStatusOutput } from "../rpc/searchSchemas.js";
import { buildToolSuccessResult } from "./shared.js";

/** Canonical façade identifier registered with the MCP server. */
export const SEARCH_STATUS_TOOL_NAME = "search.status" as const;

/** Manifest describing the current (degraded) capabilities of the façade. */
export const SearchStatusManifestDraft: ToolManifestDraft = {
  name: SEARCH_STATUS_TOOL_NAME,
  title: "Statut des recherches",
  description:
    "Retourne l'état d'un job de recherche si la persistance est activée. Actuellement renvoie une information d'indisponibilité. Exemple : search.status {\"job_id\":\"abc123\"}",
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

/** Dependencies injected when binding the façade. */
export interface SearchStatusToolContext {
  readonly logger: StructuredLogger;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Factory returning the handler for the `search.status` façade. The current
 * implementation surfaces a deterministic not-implemented response while the
 * persistence layer is under construction.
 */
export function createSearchStatusHandler(context: SearchStatusToolContext): ToolImplementation {
  return async (input: unknown, extra: RpcExtra): Promise<CallToolResult> => {
    const parsed: SearchStatusInput = SearchStatusInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const payload: SearchStatusOutput = SearchStatusOutputSchema.parse({
      ok: false,
      code: "not_implemented" as const,
      message: "la persistance des jobs de recherche n'est pas encore disponible",
    });

    context.logger.warn("search_status_not_implemented", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      job_id: parsed.job_id ?? null,
    });

    return buildToolSuccessResult(JSON.stringify({ tool: SEARCH_STATUS_TOOL_NAME, result: payload }, null, 2), payload);
  };
}

/** Registers the façade with the tool registry. */
export async function registerSearchStatusTool(
  registry: ToolRegistry,
  context: SearchStatusToolContext,
): Promise<ToolManifest> {
  return await registry.register(SearchStatusManifestDraft, createSearchStatusHandler(context), {
    inputSchema: SearchStatusInputSchema.shape,
    annotations: { intent: SEARCH_STATUS_TOOL_NAME },
  });
}
