import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type {
  ToolManifest,
  ToolManifestDraft,
  ToolPack,
  ToolRegistry,
  ToolVisibilityMode,
  ToolImplementation,
} from "../mcp/registry.js";
import {
  resolveToolPackFromEnv,
  resolveToolVisibilityModeFromEnv,
} from "../mcp/registry.js";
import {
  TOOL_HELP_CATEGORIES,
  ToolsHelpBudgetDiagnosticSchema,
  ToolsHelpInputSchema,
  ToolsHelpOutputSchema,
  ToolsHelpPackSchema,
  ToolsHelpVisibilityModeSchema,
  type ToolsHelpInput,
  type ToolsHelpOutput,
  type ToolsHelpToolSummary,
} from "../rpc/toolsHelpSchemas.js";

/** Canonical name advertised by the façade manifest. */
export const TOOLS_HELP_TOOL_NAME = "tools_help" as const;

/**
 * Draft manifest supplied to the ToolRegistry. Tags include `facade` so the
 * tool stays visible when the orchestrator runs in basic exposure mode.
 */
export const ToolsHelpManifestDraft: ToolManifestDraft = {
  name: TOOLS_HELP_TOOL_NAME,
  title: "Guide des outils",
  description: "Expose un aperçu filtrable des façades et primitives disponibles.",
  kind: "dynamic",
  category: "admin",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 1_000,
    tool_calls: 1,
    bytes_out: 16_384,
  },
};

/**
 * Minimal registry interface consumed by the façade. Tests provide lightweight
 * implementations to assert the behaviour without requiring the full runtime
 * registry machinery.
 */
export interface ToolsHelpRegistryView {
  list(): ToolManifest[];
  listVisible(mode?: ToolVisibilityMode, pack?: ToolPack): ToolManifest[];
}

/** Context forwarded to the façade handler. */
export interface ToolsHelpToolContext {
  readonly registry: ToolsHelpRegistryView;
  readonly logger: StructuredLogger;
}

type ToolsHelpCategory = (typeof TOOL_HELP_CATEGORIES)[number];

/** Structure representing the filters used to build the façade response. */
interface ToolsHelpFilters {
  categories?: ToolsHelpCategory[];
  tags?: string[];
  search?: string;
  limit?: number;
}

/** Builds a serialisable JSON string for the textual channel. */
function asJsonPayload(result: ToolsHelpOutput): string {
  return JSON.stringify({ tool: TOOLS_HELP_TOOL_NAME, result }, null, 2);
}

/**
 * Normalises the optional filter fields provided by the caller into a compact
 * structure surfaced inside the response details and structured logs.
 */
function extractFilters(input: ToolsHelpInput): ToolsHelpFilters {
  const filters: ToolsHelpFilters = {};
  if (input.categories && input.categories.length > 0) {
    filters.categories = [...input.categories];
  }
  if (input.tags && input.tags.length > 0) {
    filters.tags = [...input.tags];
  }
  if (input.search && input.search.trim().length > 0) {
    filters.search = input.search.trim();
  }
  if (typeof input.limit === "number") {
    filters.limit = input.limit;
  }
  return filters;
}

/** Clones metadata records so callers cannot mutate internal references. */
function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata));
}

/**
 * Converts a manifest entry into the façade-friendly summary validated by the
 * public schema.
 */
function toToolSummary(manifest: ToolManifest): ToolsHelpToolSummary {
  const summary: ToolsHelpToolSummary = {
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    category: manifest.category,
    hidden: manifest.hidden,
    tags: manifest.tags ? [...manifest.tags] : undefined,
    deprecated: manifest.deprecated
      ? manifest.deprecated.replace_with
        ? { since: manifest.deprecated.since, replace_with: manifest.deprecated.replace_with }
        : { since: manifest.deprecated.since }
      : undefined,
    budgets: manifest.budgets
      ? {
          ...(typeof manifest.budgets.time_ms === "number" ? { time_ms: manifest.budgets.time_ms } : {}),
          ...(typeof manifest.budgets.tool_calls === "number" ? { tool_calls: manifest.budgets.tool_calls } : {}),
          ...(typeof manifest.budgets.bytes_out === "number" ? { bytes_out: manifest.budgets.bytes_out } : {}),
        }
      : undefined,
  };
  return summary;
}

/**
 * Builds a degraded response when the caller exhausted its budget before the
 * façade could assemble the requested catalogue information.
 */
function buildBudgetExceededResult(
  idempotencyKey: string,
  mode: ToolVisibilityMode,
  pack: ToolPack,
  includeHidden: boolean,
  filters: ToolsHelpFilters,
  metadata: Record<string, unknown> | undefined,
  error: BudgetExceededError,
): ToolsHelpOutput {
  const diagnostic = ToolsHelpBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });

  return ToolsHelpOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant la génération du guide des outils",
    details: {
      idempotency_key: idempotencyKey,
      mode,
      pack,
      include_hidden: includeHidden,
      total: 0,
      returned: 0,
      filters,
      tools: [],
      metadata,
      budget: diagnostic,
    },
  });
}

/**
 * Creates the façade handler. The implementation validates the input payload,
 * consumes the request budget, filters the manifest catalogue, and emits
 * structured diagnostics for observability consumers.
 */
export function createToolsHelpHandler(context: ToolsHelpToolContext): ToolImplementation {
  return async function handleToolsHelp(
    input: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const parsed = ToolsHelpInputSchema.parse(args);

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const resolvedMode: ToolVisibilityMode = parsed.mode
      ? ToolsHelpVisibilityModeSchema.parse(parsed.mode)
      : resolveToolVisibilityModeFromEnv();
    const resolvedPack: ToolPack = parsed.pack
      ? ToolsHelpPackSchema.parse(parsed.pack)
      : resolveToolPackFromEnv();
    const includeHidden = parsed.include_hidden === true;
    const filters = extractFilters(parsed);
    const metadata = cloneMetadata(parsed.metadata);

    let charge: BudgetCharge | null = null;
    try {
      if (rpcContext?.budget) {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          { actor: "facade", operation: TOOLS_HELP_TOOL_NAME, detail: "manifest_listing" },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("tools_help_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          dimension: error.dimension,
          remaining: error.remaining,
          attempted: error.attempted,
          limit: error.limit,
        });
        const structured = buildBudgetExceededResult(
          idempotencyKey,
          resolvedMode,
          resolvedPack,
          includeHidden,
          filters,
          metadata,
          error,
        );
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
      throw error;
    }

    const manifests = includeHidden
      ? context.registry.list()
      : context.registry.listVisible(resolvedMode, resolvedPack);

    let filtered = manifests;
    if (filters.categories && filters.categories.length > 0) {
      const allowed = new Set(filters.categories);
      filtered = filtered.filter((manifest) => allowed.has(manifest.category));
    }
    if (filters.tags && filters.tags.length > 0) {
      const requiredTags = new Set(filters.tags.map((tag) => tag.toLowerCase()));
      filtered = filtered.filter((manifest) => {
        const tags = manifest.tags ?? [];
        return tags.some((tag) => requiredTags.has(tag.toLowerCase()));
      });
    }
    if (filters.search && filters.search.length > 0) {
      const needle = filters.search.toLowerCase();
      filtered = filtered.filter((manifest) => {
        const fields = [manifest.name, manifest.title, manifest.description ?? ""];
        return fields.some((field) => field.toLowerCase().includes(needle));
      });
    }

    const limited = typeof filters.limit === "number" ? filtered.slice(0, filters.limit) : filtered;
    const summaries = limited.map((manifest) => toToolSummary(manifest));

    const structured: ToolsHelpOutput = {
      ok: true,
      summary:
        summaries.length === 0
          ? "aucun outil ne correspond aux filtres fournis"
          : `${summaries.length} outil${summaries.length > 1 ? "s" : ""} correspondant${summaries.length > 1 ? "s" : ""}`,
      details: {
        idempotency_key: idempotencyKey,
        mode: resolvedMode,
        pack: resolvedPack,
        include_hidden: includeHidden,
        total: filtered.length,
        returned: summaries.length,
        filters,
        tools: summaries,
        ...(metadata ? { metadata } : {}),
      },
    };

    const validated = ToolsHelpOutputSchema.parse(structured);

    context.logger.info("tools_help_listed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      idempotency_key: idempotencyKey,
      mode: resolvedMode,
      pack: resolvedPack,
      include_hidden: includeHidden,
      total: filtered.length,
      returned: summaries.length,
      filters,
    });

    if (charge && rpcContext?.budget) {
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(validated) }],
      structuredContent: validated,
    };
  };
}

/**
 * Registers the façade with the tool registry.
 */
export async function registerToolsHelpTool(
  registry: ToolRegistry,
  context: Omit<ToolsHelpToolContext, "registry">,
): Promise<ToolManifest> {
  return await registry.register(ToolsHelpManifestDraft, createToolsHelpHandler({ ...context, registry }), {
    inputSchema: ToolsHelpInputSchema.shape,
    outputSchema: ToolsHelpOutputSchema.shape,
    annotations: { intent: "discovery" },
  });
}
