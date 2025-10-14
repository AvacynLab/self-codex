import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { collectMethodMetrics, getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type { ToolImplementation, ToolManifest, ToolManifestDraft, ToolRegistry } from "../mcp/registry.js";
import { getMcpRuntimeSnapshot } from "../mcp/info.js";
import {
  RUNTIME_OBSERVE_SECTIONS,
  RuntimeObserveBudgetDiagnosticSchema,
  RuntimeObserveInputSchema,
  RuntimeObserveMethodMetricSchema,
  RuntimeObserveOutputSchema,
  RuntimeObserveSnapshotSchema,
  type RuntimeObserveInput,
  type RuntimeObserveOutput,
} from "../rpc/runtimeObserveSchemas.js";

/** Canonical façade identifier exposed through the manifest catalogue. */
export const RUNTIME_OBSERVE_TOOL_NAME = "runtime_observe" as const;

/**
 * Draft manifest supplied to the registry. The façade is tagged as `facade` so
 * it remains visible even when the orchestrator runs in the basic exposure mode
 * while `ops` helps operators discover it from operational packs.
 */
export const RuntimeObserveManifestDraft: ToolManifestDraft = {
  name: RUNTIME_OBSERVE_TOOL_NAME,
  title: "Observer le runtime",
  description: "Collecte un instantané du runtime MCP ainsi que les métriques JSON-RPC récentes.",
  kind: "dynamic",
  category: "runtime",
  tags: ["facade", "ops"],
  hidden: false,
  budgets: {
    time_ms: 1_000,
    tool_calls: 1,
    bytes_out: 12_288,
  },
};

/** Context forwarded to the façade handler. */
export interface RuntimeObserveToolContext {
  /** Structured logger compliant with the observability guidelines. */
  readonly logger: StructuredLogger;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
/** Literal union matching the allowed runtime_observe sections. */
type RuntimeObserveSection = (typeof RUNTIME_OBSERVE_SECTIONS)[number];

/** Serialises a JSON payload suitable for the textual MCP channel. */
function asJsonPayload(result: RuntimeObserveOutput): string {
  return JSON.stringify({ tool: RUNTIME_OBSERVE_TOOL_NAME, result }, null, 2);
}

/** Defensive clone so caller metadata cannot mutate the handler state. */
function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata));
}

/**
 * Builds a degraded payload when the caller exhausts its request budget before
 * the façade can gather the requested observability artefacts.
 */
function buildBudgetExceededResult(
  idempotencyKey: string,
  sections: RuntimeObserveInput["sections"],
  metadata: Record<string, unknown> | undefined,
  error: BudgetExceededError,
): RuntimeObserveOutput {
  const resolvedSections = sections && sections.length > 0 ? sections : [...RUNTIME_OBSERVE_SECTIONS];
  const diagnostic = RuntimeObserveBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });
  return RuntimeObserveOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant la collecte des métriques runtime",
    details: {
      idempotency_key: idempotencyKey,
      sections: resolvedSections,
      metadata,
      budget: diagnostic,
    },
  });
}

/** Resolves the sections requested by the caller or falls back to the defaults. */
function resolveSections(sections: RuntimeObserveInput["sections"]): RuntimeObserveSection[] {
  if (!sections || sections.length === 0) {
    return [...RUNTIME_OBSERVE_SECTIONS];
  }
  return [...sections];
}

/**
 * Extracts and optionally filters the method metrics recorded by the tracing
 * infrastructure.
 */
function buildMetricsSection(
  input: RuntimeObserveInput,
): { total: number; returned: number; methods: Array<ReturnType<typeof RuntimeObserveMethodMetricSchema["parse"]>> } {
  const snapshots = collectMethodMetrics();
  const total = snapshots.length;

  let filtered = snapshots;
  if (input.methods && input.methods.length > 0) {
    const allowed = new Set(input.methods.map((method) => method.trim()));
    filtered = filtered.filter((snapshot) => allowed.has(snapshot.method));
  }
  if (typeof input.limit === "number") {
    filtered = filtered.slice(0, input.limit);
  }

  const methods = filtered.map((snapshot) =>
    RuntimeObserveMethodMetricSchema.parse({
      method: snapshot.method,
      count: snapshot.count,
      error_count: snapshot.errorCount,
      p50_ms: snapshot.p50,
      p95_ms: snapshot.p95,
      p99_ms: snapshot.p99,
      ...(input.include_error_codes ? { error_codes: { ...snapshot.errorCodes } } : {}),
    }),
  );

  return { total, returned: methods.length, methods };
}

/**
 * Creates the façade handler. The implementation validates the payload, applies
 * the request budget, collects the requested sections, and emits correlated
 * observability logs for downstream tooling.
 */
export function createRuntimeObserveHandler(context: RuntimeObserveToolContext): ToolImplementation {
  return async function handleRuntimeObserve(input: unknown, extra: RpcExtra): Promise<CallToolResult> {
    const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const parsed = RuntimeObserveInputSchema.parse(args);

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const sections = resolveSections(parsed.sections);
    const metadata = cloneMetadata(parsed.metadata);

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    let charge: BudgetCharge | null = null;
    try {
      if (rpcContext?.budget) {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          { actor: "facade", operation: RUNTIME_OBSERVE_TOOL_NAME, detail: "collect_sections" },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("runtime_observe_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          dimension: error.dimension,
          remaining: error.remaining,
          attempted: error.attempted,
          limit: error.limit,
        });
        const structured = buildBudgetExceededResult(idempotencyKey, parsed.sections, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
      throw error;
    }

    const details: RuntimeObserveOutput["details"] = {
      idempotency_key: idempotencyKey,
      sections,
      ...(metadata ? { metadata } : {}),
    };

    if (sections.includes("snapshot")) {
      details.snapshot = RuntimeObserveSnapshotSchema.parse(getMcpRuntimeSnapshot());
    }

    if (sections.includes("metrics")) {
      const metrics = buildMetricsSection(parsed);
      details.metrics = {
        total_methods: metrics.total,
        returned_methods: metrics.returned,
        methods: metrics.methods,
      };
    }

    const structured = RuntimeObserveOutputSchema.parse({
      ok: true,
      summary: sections.includes("metrics")
        ? "instantané runtime et métriques JSON-RPC collectés"
        : "instantané runtime collecté",
      details,
    });

    context.logger.info("runtime_observe_collected", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      sections,
      methods_total: structured.details.metrics?.total_methods ?? 0,
      methods_returned: structured.details.metrics?.returned_methods ?? 0,
      filters: {
        methods: parsed.methods ?? null,
        limit: parsed.limit ?? null,
        include_error_codes: parsed.include_error_codes ?? false,
      },
    });

    if (charge && rpcContext?.budget) {
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(structured) }],
      structuredContent: structured,
    };
  };
}

/** Registers the façade with the tool registry. */
export async function registerRuntimeObserveTool(
  registry: ToolRegistry,
  context: RuntimeObserveToolContext,
): Promise<ToolManifest> {
  return await registry.register(RuntimeObserveManifestDraft, createRuntimeObserveHandler(context), {
    inputSchema: RuntimeObserveInputSchema.shape,
    outputSchema: RuntimeObserveOutputSchema.shape,
    annotations: { intent: "observability" },
  });
}
