import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type {
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
  ToolImplementation,
} from "../mcp/registry.js";
import { IntentRouteInputSchema, IntentRouteOutputSchema } from "../rpc/intentRouteSchemas.js";

/**
 * Describes the structured payload returned by the intent routing façade.
 *
 * The façade intentionally keeps the result concise so upstream automation can
 * reason about the chosen action without parsing unbounded free-form text.
 */
export type IntentRouteResult = z.infer<typeof IntentRouteOutputSchema>;

/**
 * Context forwarded to {@link createIntentRouteHandler}. Tests provide a
 * lightweight logger instance so they can assert correlation metadata without
 * writing to disk.
 */
export interface IntentRouteToolContext {
  /** Structured logger mirroring observability requirements from the checklist. */
  readonly logger: StructuredLogger;
}

/** Canonical name advertised by the façade manifest. */
export const INTENT_ROUTE_TOOL_NAME = "intent_route" as const;

/**
 * Default manifest used when registering the façade with the tool registry.
 * Tags intentionally include `facade` so the catalogue exposes the tool in
 * "basic" mode even when other primitives remain hidden.
 */
export const IntentRouteManifestDraft: ToolManifestDraft = {
  name: INTENT_ROUTE_TOOL_NAME,
  title: "Intent router",
  description: "Route une intention exprimée en langage naturel vers la façade la plus pertinente.",
  kind: "dynamic",
  category: "runtime",
  tags: ["facade", "ops"],
  hidden: false,
  budgets: {
    time_ms: 750,
    tool_calls: 1,
    bytes_out: 2_048,
  },
};

/**
 * Short-list of façade candidates surfaced when no heuristic produces an exact
 * match. The list mirrors the onboarding recommendation from the brief so
 * clients are nudged towards safe discovery operations.
 */
const FALLBACK_CANDIDATES = ["tools_help", "artifact_search", "child_orchestrate"] as const;

/** Heuristic rule examined sequentially until one matches the intent. */
interface IntentHeuristicRule {
  /** Identifier of the façade triggered by the rule. */
  readonly tool: string;
  /** Human readable label exposed in the structured diagnostics. */
  readonly label: string;
  /** Predicate returning `true` when the natural language goal matches. */
  readonly matcher: (normalisedGoal: string) => boolean;
}

/** Ordered heuristic catalogue that favours precise routes before broader ones. */
const HEURISTIC_RULES: readonly IntentHeuristicRule[] = [
  {
    tool: "graph_apply_change_set",
    label: "graph_mutation",
    matcher: (goal) => /(graph|graphe|noeud|edge|arête|patch)/i.test(goal),
  },
  {
    tool: "graph_snapshot_time_travel",
    label: "graph_snapshot",
    matcher: (goal) => /(snapshot|travel|historique|rollback|restore)/i.test(goal),
  },
  {
    tool: "plan_compile_execute",
    label: "plan_pipeline",
    matcher: (goal) => /(plan|pipeline|workflow|planifier|schedule)/i.test(goal),
  },
  {
    tool: "artifact_write",
    label: "artifact_write",
    matcher: (goal) => /(fichier|artefact|artifact|write|enregistrer|save)/i.test(goal),
  },
  {
    tool: "artifact_read",
    label: "artifact_read",
    matcher: (goal) => /(lire|read|inspect|ouvrir|afficher)/i.test(goal) && /(fichier|artefact|artifact)/i.test(goal),
  },
  {
    tool: "artifact_search",
    label: "artifact_search",
    matcher: (goal) => /(chercher|search|rechercher|find)/i.test(goal) && /(fichier|artefact|artifact)/i.test(goal),
  },
  {
    tool: "memory_search",
    label: "memory_search",
    matcher: (goal) => /(mémoire|memory|rappel|souvenir)/i.test(goal) && /(chercher|search|lookup)/i.test(goal),
  },
  {
    tool: "memory_upsert",
    label: "memory_upsert",
    matcher: (goal) => /(mémoire|memory)/i.test(goal) && /(ajout|add|write|store|enregistrer)/i.test(goal),
  },
  {
    tool: "child_orchestrate",
    label: "child_orchestration",
    matcher: (goal) => /(child|enfant|runtime|agent)/i.test(goal) && /(spawn|orchestrate|coordonner|manage)/i.test(goal),
  },
  {
    tool: "runtime_observe",
    label: "runtime_observe",
    matcher: (goal) => /(metrics|observe|latence|latency|stats|statistiques)/i.test(goal),
  },
];

/**
 * Creates a JSON serialisable payload ready to be surfaced in both the
 * structured MCP result and the text channel used by legacy consumers.
 */
function asJsonPayload(result: IntentRouteResult): string {
  return JSON.stringify({ tool: INTENT_ROUTE_TOOL_NAME, result }, null, 2);
}

/**
 * Evaluates the configured heuristics and returns the matching tool if any.
 * The function also surfaces diagnostic data so callers understand why a rule
 * triggered (or not) without having to re-evaluate the goal client-side.
 */
function evaluateHeuristics(goal: string): {
  chosen: string | null;
  diagnostics: Array<{ label: string; tool: string; matched: boolean }>;
} {
  let chosen: string | null = null;
  const diagnostics: Array<{ label: string; tool: string; matched: boolean }> = [];

  for (const rule of HEURISTIC_RULES) {
    const matched = rule.matcher(goal);
    diagnostics.push({ label: rule.label, tool: rule.tool, matched });
    if (!chosen && matched) {
      chosen = rule.tool;
    }
  }

  return { chosen, diagnostics };
}

/** Builds a failure response when budget consumption raises an error. */
function buildBudgetExceededResult(
  idempotencyKey: string,
  error: BudgetExceededError,
): IntentRouteResult {
  return {
    ok: false,
    summary: "budget épuisé avant le routage de l'intention",
    details: {
      reason: "budget_exhausted",
      dimension: error.dimension,
      attempted: error.attempted,
      remaining: error.remaining,
      limit: error.limit,
      idempotency_key: idempotencyKey,
      diagnostics: [],
    },
  };
}

/**
 * Creates the asynchronous handler invoked by the MCP server once the façade
 * is registered. The handler takes care of validation, budget consumption,
 * heuristic evaluation and structured logging.
 */
export function createIntentRouteHandler(
  context: IntentRouteToolContext,
): ToolImplementation {
  return async function handleIntentRoute(
    input: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const parsed = IntentRouteInputSchema.parse(args);

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
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
          {
            actor: "facade",
            operation: INTENT_ROUTE_TOOL_NAME,
            detail: "heuristic_evaluation",
          },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("intent_route_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          dimension: error.dimension,
          remaining: error.remaining,
          attempted: error.attempted,
          limit: error.limit,
        });
        const structured = buildBudgetExceededResult(idempotencyKey, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
      throw error;
    }

    const goal = parsed.natural_language_goal.trim().toLowerCase();
    const { chosen, diagnostics } = evaluateHeuristics(goal);

    const structured: IntentRouteResult = {
      ok: true,
      summary: chosen
        ? `façade sélectionnée : ${chosen}`
        : "aucune façade unique détectée, candidats proposés",
      details: {
        idempotency_key: idempotencyKey,
        chosen: chosen ?? undefined,
        candidates: chosen ? undefined : [...FALLBACK_CANDIDATES],
        diagnostics,
        metadata: parsed.metadata ?? undefined,
      },
    };

    context.logger.info("intent_route_evaluated", {
      goal: parsed.natural_language_goal,
      chosen: chosen ?? null,
      candidates: chosen ? [chosen] : [...FALLBACK_CANDIDATES],
      diagnostics,
      idempotency_key: idempotencyKey,
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
    });

    if (charge && rpcContext?.budget) {
      // The handler has no meaningful refund to apply, however registering the
      // usage ensures downstream snapshots expose the association with the
      // intent router for auditing purposes.
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(structured) }],
      structuredContent: structured,
    };
  };
}

/**
 * Registers the façade with the tool registry and returns the persisted
 * manifest. The helper centralises manifest construction so tests can rely on
 * the exported draft while keeping the registration logic free of duplication.
 */
export async function registerIntentRouteTool(
  registry: ToolRegistry,
  context: IntentRouteToolContext,
): Promise<ToolManifest> {
  return await registry.register(IntentRouteManifestDraft, createIntentRouteHandler(context), {
    inputSchema: IntentRouteInputSchema.shape,
    outputSchema: IntentRouteOutputSchema.shape,
    annotations: { intent: "routing" },
  });
}
