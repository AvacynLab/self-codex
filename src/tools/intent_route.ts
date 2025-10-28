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
  ToolRegistry,
  ToolImplementation,
  ToolBudgets,
} from "../mcp/registry.js";
import type {
  ToolRouter,
  ToolRouterDecision,
  ToolRouterDecisionRecord,
  ToolRoutingCandidate,
  ToolRoutingContext,
} from "./toolRouter.js";
import { resolveToolRouterTopKLimit } from "./toolRouter.js";
import {
  IntentRouteInputSchema,
  IntentRouteOutputSchema,
  type IntentRouteOutput,
  type IntentRouteRecommendation as IntentRouteRecommendationPayload,
} from "../rpc/schemas.js";
import { buildToolErrorResult, buildToolSuccessResult } from "./shared.js";

/**
 * Describes the structured payload returned by the intent routing façade.
 *
 * The façade intentionally keeps the result concise so upstream automation can
 * reason about the chosen action without parsing unbounded free-form text.
 */
/** Structured result returned to callers (success and degraded branches). */
export type IntentRouteResult = IntentRouteOutput;
/** Recommendation entry included in the success payload. */
export type IntentRouteRecommendation = IntentRouteRecommendationPayload;

/**
 * Context forwarded to {@link createIntentRouteHandler}. Tests provide a
 * lightweight logger instance so they can assert correlation metadata without
 * writing to disk.
 */
export interface IntentRouteToolContext {
  /** Structured logger mirroring observability requirements from the checklist. */
  readonly logger: StructuredLogger;
  /** Optional lookup returning the budgets advertised by a façade manifest. */
  readonly resolveBudget?: (tool: string) => ToolBudgets | undefined;
  /** Optional contextual tool router used to refine fallback candidates. */
  readonly toolRouter?: ToolRouter;
  /** Callback recording router decisions for observability dashboards. */
  readonly recordRouterDecision?: (record: ToolRouterDecisionRecord) => void;
  /** Feature toggle guard returning `true` when the router is available. */
  readonly isRouterEnabled?: () => boolean;
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

/** Rationale strings surfaced for fallback suggestions. */
const FALLBACK_RATIONALES: Record<(typeof FALLBACK_CANDIDATES)[number], string> = {
  tools_help: "aucune règle précise trouvée : proposer la documentation interactive",
  artifact_search: "aucune règle précise trouvée : suggérer l'exploration des artefacts",
  child_orchestrate: "aucune règle précise trouvée : envisager un enfant opérateur",
};

/**
 * Static budget hints mirroring the manifests declared by façade modules. The
 * handler falls back to these values when the registry does not expose a
 * runtime manifest (e.g. unit tests wiring a minimal registry stub).
 */
const ESTIMATED_BUDGET_HINTS: Record<string, ToolBudgets> = {
  graph_apply_change_set: { time_ms: 7_000, tool_calls: 1, bytes_out: 24_576 },
  graph_snapshot_time_travel: { time_ms: 7_000, tool_calls: 1, bytes_out: 32_768 },
  plan_compile_execute: { time_ms: 10_000, tool_calls: 1, bytes_out: 32_768 },
  artifact_write: { time_ms: 5_000, tool_calls: 1, bytes_out: 8_192 },
  artifact_read: { time_ms: 3_000, tool_calls: 1, bytes_out: 16_384 },
  artifact_search: { time_ms: 4_000, tool_calls: 1, bytes_out: 24_576 },
  memory_search: { time_ms: 3_000, tool_calls: 1, bytes_out: 16_384 },
  memory_upsert: { time_ms: 5_000, tool_calls: 1, bytes_out: 12_288 },
  child_orchestrate: { time_ms: 15_000, tool_calls: 1, bytes_out: 32_768 },
  runtime_observe: { time_ms: 1_000, tool_calls: 1, bytes_out: 12_288 },
  tools_help: { time_ms: 1_000, tool_calls: 1, bytes_out: 16_384 },
  "search.run": { time_ms: 60_000, tool_calls: 1, bytes_out: 96_000 },
  "search.index": { time_ms: 45_000, tool_calls: 1, bytes_out: 64_000 },
  "search.status": { time_ms: 5_000, tool_calls: 1, bytes_out: 8_000 },
};

/** Heuristic rule examined sequentially until one matches the intent. */
interface IntentHeuristicRule {
  /** Identifier of the façade triggered by the rule. */
  readonly tool: string;
  /** Human readable label exposed in the structured diagnostics. */
  readonly label: string;
  /** Predicate returning `true` when the natural language goal matches. */
  readonly matcher: (normalisedGoal: string) => boolean;
  /** Confidence score (0-1) associated with the rule when it matches. */
  readonly confidence: number;
  /** Concise explanation surfaced alongside the recommendation. */
  readonly successRationale: string;
}

/** Ordered heuristic catalogue that favours precise routes before broader ones. */
const HEURISTIC_RULES: readonly IntentHeuristicRule[] = [
  {
    tool: "graph_apply_change_set",
    label: "graph_mutation",
    matcher: (goal) => /(graph|graphe|noeud|edge|arête|patch)/i.test(goal),
    confidence: 0.95,
    successRationale: "l'intention mentionne explicitement une modification du graphe",
  },
  {
    tool: "graph_snapshot_time_travel",
    label: "graph_snapshot",
    matcher: (goal) => /(snapshot|travel|historique|rollback|restore)/i.test(goal),
    confidence: 0.9,
    successRationale: "l'objectif demande d'explorer ou restaurer un snapshot de graphe",
  },
  {
    tool: "plan_compile_execute",
    label: "plan_pipeline",
    matcher: (goal) => /(plan|pipeline|workflow|planifier|schedule)/i.test(goal),
    confidence: 0.9,
    successRationale: "la requête évoque la compilation ou l'exécution d'un plan",
  },
  {
    tool: "artifact_write",
    label: "artifact_write",
    matcher: (goal) => /(fichier|artefact|artifact|write|enregistrer|save)/i.test(goal),
    confidence: 0.85,
    successRationale: "l'intention mentionne l'enregistrement ou l'écriture d'un artefact",
  },
  {
    tool: "artifact_read",
    label: "artifact_read",
    matcher: (goal) =>
      /(lire|read|inspect|ouvrir|afficher)/i.test(goal) && /(fichier|artefact|artifact)/i.test(goal),
    confidence: 0.85,
    successRationale: "la requête mentionne la lecture ou l'inspection d'un artefact",
  },
  {
    tool: "artifact_search",
    label: "artifact_search",
    matcher: (goal) =>
      /(chercher|search|rechercher|find)/i.test(goal) && /(fichier|artefact|artifact)/i.test(goal),
    confidence: 0.8,
    successRationale: "l'objectif décrit une recherche d'artefacts dans le dépôt",
  },
  {
    tool: "memory_search",
    label: "memory_search",
    matcher: (goal) => /(mémoire|memory|rappel|souvenir)/i.test(goal) && /(chercher|search|lookup)/i.test(goal),
    confidence: 0.85,
    successRationale: "l'intention demande de retrouver une information dans la mémoire",
  },
  {
    tool: "memory_upsert",
    label: "memory_upsert",
    matcher: (goal) => /(mémoire|memory)/i.test(goal) && /(ajout|add|write|store|enregistrer)/i.test(goal),
    confidence: 0.8,
    successRationale: "la demande mentionne l'ajout ou la mise à jour d'une mémoire",
  },
  {
    tool: "child_orchestrate",
    label: "child_orchestration",
    matcher: (goal) =>
      /(child|enfant|runtime|agent)/i.test(goal) && /(spawn|orchestrate|coordonner|manage)/i.test(goal),
    confidence: 0.9,
    successRationale: "l'intention cible la gestion ou la coordination d'un enfant Codex",
  },
  {
    tool: "runtime_observe",
    label: "runtime_observe",
    matcher: (goal) => /(metrics|observe|latence|latency|stats|statistiques)/i.test(goal),
    confidence: 0.75,
    successRationale: "la requête évoque l'observation des métriques runtime",
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
  primary: IntentHeuristicRule | null;
  diagnostics: Array<{ label: string; tool: string; matched: boolean }>;
  evaluations: Array<{ rule: IntentHeuristicRule; matched: boolean }>;
} {
  let primary: IntentHeuristicRule | null = null;
  const diagnostics: Array<{ label: string; tool: string; matched: boolean }> = [];
  const evaluations: Array<{ rule: IntentHeuristicRule; matched: boolean }> = [];

  for (const rule of HEURISTIC_RULES) {
    const matched = rule.matcher(goal);
    diagnostics.push({ label: rule.label, tool: rule.tool, matched });
    evaluations.push({ rule, matched });
    if (!primary && matched) {
      primary = rule;
    }
  }

  return { primary, diagnostics, evaluations };
}

/** Ensures returned budgets are finite non-negative integers. */
function sanitiseBudget(budgets: ToolBudgets | undefined): ToolBudgets {
  const snapshot: { time_ms?: number; tool_calls?: number; bytes_out?: number } = {};
  if (budgets && Number.isFinite(budgets.time_ms ?? NaN) && (budgets.time_ms as number) >= 0) {
    snapshot.time_ms = Math.trunc(budgets.time_ms as number);
  }
  if (budgets && Number.isFinite(budgets.tool_calls ?? NaN) && (budgets.tool_calls as number) >= 0) {
    snapshot.tool_calls = Math.trunc(budgets.tool_calls as number);
  }
  if (budgets && Number.isFinite(budgets.bytes_out ?? NaN) && (budgets.bytes_out as number) >= 0) {
    snapshot.bytes_out = Math.trunc(budgets.bytes_out as number);
  }
  if (snapshot.tool_calls === undefined) {
    snapshot.tool_calls = 1;
  }
  return snapshot;
}

/** Lookup budgets from the registry-aware context or fallback hints. */
function lookupEstimatedBudget(context: IntentRouteToolContext, tool: string): ToolBudgets {
  try {
    const fromContext = context.resolveBudget?.(tool);
    if (fromContext) {
      return sanitiseBudget(fromContext);
    }
  } catch (error) {
    context.logger.warn("intent_route_budget_lookup_failed", {
      tool,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return sanitiseBudget(ESTIMATED_BUDGET_HINTS[tool]);
}

/** Normalises a confidence score to two decimal places in the [0, 1] range. */
function clampScore(confidence: number): number {
  const bounded = Math.max(0, Math.min(1, confidence));
  return Math.round(bounded * 100) / 100;
}

/** Builds ordered recommendations (matched heuristics first, then fallbacks). */
function buildRecommendations(
  evaluations: Array<{ rule: IntentHeuristicRule; matched: boolean }>,
  context: IntentRouteToolContext,
  routerCandidates?: ToolRoutingCandidate[],
): IntentRouteRecommendation[] {
  const recommendations: IntentRouteRecommendation[] = [];
  const matched = evaluations.filter((entry) => entry.matched);

  matched.forEach((entry, index) => {
    if (recommendations.length >= 3) {
      return;
    }
    const score = clampScore(entry.rule.confidence - index * 0.05);
    recommendations.push({
      tool: entry.rule.tool,
      score,
      rationale: entry.rule.successRationale,
      estimated_budget: lookupEstimatedBudget(context, entry.rule.tool),
    });
  });

  if (routerCandidates && routerCandidates.length > 0) {
    for (const candidate of routerCandidates) {
      if (recommendations.length >= 3) {
        break;
      }
      if (recommendations.some((entry) => entry.tool === candidate.tool)) {
        continue;
      }
      recommendations.push({
        tool: candidate.tool,
        score: clampScore(candidate.score),
        rationale: `routeur contextuel : ${candidate.rationale}`,
        estimated_budget: lookupEstimatedBudget(context, candidate.tool),
      });
    }
  }

  if (recommendations.length < 3) {
    for (const fallback of FALLBACK_CANDIDATES) {
      if (recommendations.length >= 3) {
        break;
      }
      if (recommendations.some((entry) => entry.tool === fallback)) {
        continue;
      }
      const scoreOffset = 0.55 - recommendations.length * 0.05;
      recommendations.push({
        tool: fallback,
        score: clampScore(scoreOffset),
        rationale: FALLBACK_RATIONALES[fallback],
        estimated_budget: lookupEstimatedBudget(context, fallback),
      });
    }
  }

  if (recommendations.length === 0) {
    // Defensive guard: if everything fails, fall back to tools_help.
    recommendations.push({
      tool: "tools_help",
      score: 0.5,
      rationale: FALLBACK_RATIONALES.tools_help,
      estimated_budget: lookupEstimatedBudget(context, "tools_help"),
    });
  }

  return recommendations.slice(0, 3);
}

/**
 * Normalises the routing context forwarded to the contextual tool router. The helper extracts
 * optional hints from the user-provided metadata (category, tags, preferred tools) and enriches
 * the context with matched heuristic labels so the router can learn from existing rules.
 */
function buildRoutingContext(
  goal: string,
  metadata: Record<string, unknown> | undefined,
  diagnostics: Array<{ label: string; tool: string; matched: boolean }>,
): ToolRoutingContext {
  /**
   * Collects tags emitted by both heuristics and planner metadata. The helper is scoped to the
   * routing-context builder so we can keep the normalisation rules (trim, lowercase) close to the
   * logic that consumes them.
   */
  const appendTag = (bucket: Set<string>, value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) {
      bucket.add(trimmed);
    }
  };

  /** Normalises tool names advertised by planners without forcing lowercase (tool ids are case-sensitive). */
  const appendPreferredTool = (bucket: Set<string>, value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      bucket.add(trimmed);
    }
  };

  /** Extracts a lowercase category hint from heterogeneous planner metadata. */
  const normaliseCategory = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    return trimmed.toLowerCase();
  };

  const tags = new Set<string>();
  const preferred = new Set<string>();

  // Preserve the caller metadata reference so it can be forwarded verbatim in structured responses.
  const metadataRecord = metadata;
  // Upstream planners can embed a nested `router_context` block. When present, it overrides generic
  // hints so we treat it as the most precise source of routing directives.
  const routerContext = metadataRecord && typeof metadataRecord.router_context === "object"
    ? (metadataRecord.router_context as Record<string, unknown>)
    : null;

  // Accumulate potential category hints by priority (router_context > metadata.category > fallbacks).
  const candidateCategories: Array<string | undefined> = [];
  if (routerContext?.category !== undefined) {
    candidateCategories.push(normaliseCategory(routerContext.category));
  }
  if (metadataRecord?.category !== undefined) {
    candidateCategories.push(normaliseCategory(metadataRecord.category));
  }
  if (Array.isArray(metadataRecord?.categories)) {
    for (const entry of metadataRecord.categories as unknown[]) {
      const normalised = normaliseCategory(entry);
      if (normalised) {
        candidateCategories.push(normalised);
        break;
      }
    }
  }
  if (typeof metadataRecord?.domain === "string") {
    candidateCategories.push(normaliseCategory(metadataRecord.domain));
  }

  const category = candidateCategories.find(
    (value): value is string => typeof value === "string",
  );

  // Normalises a wide range of metadata shapes (`string`, arrays, comma separated lists) and forwards
  // the entries to the provided handler.
  const ingestStringCollection = (
    values: unknown,
    handler: (bucket: Set<string>, entry: unknown) => void,
    bucket: Set<string>,
  ) => {
    if (!values) {
      return;
    }
    if (Array.isArray(values)) {
      for (const entry of values) {
        handler(bucket, entry);
      }
      return;
    }
    if (typeof values === "string" && /[,;\n]/.test(values)) {
      for (const chunk of values.split(/[,;\n]/)) {
        handler(bucket, chunk);
      }
      return;
    }
    handler(bucket, values);
  };

  if (metadataRecord) {
    ingestStringCollection(metadataRecord.tags, appendTag, tags);
    ingestStringCollection((metadataRecord as Record<string, unknown>).goal_keywords, appendTag, tags);
    ingestStringCollection((metadataRecord as Record<string, unknown>).keywords, appendTag, tags);
    ingestStringCollection(metadataRecord.domains, appendTag, tags);
    ingestStringCollection(metadataRecord.domain, appendTag, tags);
    ingestStringCollection((metadataRecord as Record<string, unknown>).preferred_tools, appendPreferredTool, preferred);
  }

  if (routerContext) {
    ingestStringCollection(routerContext.tags, appendTag, tags);
    ingestStringCollection(routerContext.keywords, appendTag, tags);
    ingestStringCollection(routerContext.domains, appendTag, tags);
    ingestStringCollection(routerContext.preferred_tools, appendPreferredTool, preferred);
  }

  // Enrich the context with heuristic labels so the router can learn from legacy routing rules.
  diagnostics
    .filter((entry) => entry.matched)
    .forEach((entry) => appendTag(tags, entry.label));

  const routingContext: ToolRoutingContext = { goal };
  if (category !== undefined) {
    // Optional hints are only forwarded when callers explicitly provided them to keep
    // compatibility with `exactOptionalPropertyTypes`.
    routingContext.category = category;
  }
  if (tags.size > 0) {
    routingContext.tags = Array.from(tags);
  }
  if (preferred.size > 0) {
    routingContext.preferredTools = Array.from(preferred);
  }
  if (metadataRecord !== undefined) {
    routingContext.metadata = metadataRecord;
  }
  return routingContext;
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
 * Builds a deterministic degraded payload when the contextual router is
 * disabled. Returning the union-backed structure ensures the façade keeps
 * honouring the documented schema while signalling the disabled state through
 * the `reason` discriminator.
 */
function buildRouterDisabledResult(idempotencyKey: string): IntentRouteResult {
  return IntentRouteOutputSchema.parse({
    ok: false,
    summary: "routeur d'intentions désactivé",
    details: {
      reason: "router_disabled",
      idempotency_key: idempotencyKey,
      diagnostics: [],
    },
  });
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

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const parsed = IntentRouteInputSchema.parse(args);
    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    if (context.isRouterEnabled && !context.isRouterEnabled()) {
      context.logger.warn("intent_route_feature_disabled", {
        request_id: extra?.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
      });
      const structured = buildRouterDisabledResult(idempotencyKey);
      return buildToolErrorResult(asJsonPayload(structured), structured);
    }

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
        return buildToolErrorResult(asJsonPayload(structured), structured);
      }
      throw error;
    }

    const goal = parsed.natural_language_goal.trim().toLowerCase();
    const { primary, diagnostics, evaluations } = evaluateHeuristics(goal);
    let routerDecision: ToolRouterDecision | null = null;
    let routerCandidates: ToolRoutingCandidate[] | undefined;
    let routingContext: ToolRoutingContext | null = null;
    const routerTopKLimit = resolveToolRouterTopKLimit();

    const routerActive = !context.isRouterEnabled || context.isRouterEnabled();
    if (context.toolRouter && routerActive) {
      routingContext = buildRoutingContext(goal, parsed.metadata, diagnostics);
      try {
        routerDecision = context.toolRouter.route(routingContext);
        routerCandidates = routerDecision.candidates.slice(0, routerTopKLimit);
      } catch (error) {
        context.logger.warn("intent_route_router_failed", {
          goal: parsed.natural_language_goal,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const recommendations = buildRecommendations(evaluations, context, routerCandidates);

    const structured: IntentRouteResult = {
      ok: true,
      summary:
        recommendations.length > 0
          ? `top recommandation : ${recommendations[0]!.tool}`
          : "aucune recommandation disponible",
      details: {
        idempotency_key: idempotencyKey,
        recommendations,
        diagnostics,
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      },
    };

    if (routerDecision && routingContext && context.recordRouterDecision && routerActive) {
      const requestIdSource = rpcContext?.requestId ?? extra?.requestId ?? null;
      const requestId =
        typeof requestIdSource === "string" || typeof requestIdSource === "number"
          ? String(requestIdSource)
          : null;
      context.recordRouterDecision({
        context: routingContext,
        decision: routerDecision,
        requestId,
        traceId: traceContext?.traceId ?? null,
        childId: rpcContext?.childId ?? null,
        runId: null,
        jobId: null,
        elapsedMs: null,
      });
    }

    context.logger.info("intent_route_evaluated", {
      goal: parsed.natural_language_goal,
      top_tool: recommendations[0]?.tool ?? null,
      primary_rule: primary ? primary.label : null,
      recommendations,
      diagnostics,
      router_decision: routerDecision
        ? {
            tool: routerDecision.tool,
            score: routerDecision.score,
            reason: routerDecision.reason,
          }
        : null,
      router_candidates: routerDecision ? (routerCandidates ?? routerDecision.candidates.slice(0, routerTopKLimit)) : null,
      idempotency_key: idempotencyKey,
      request_id: rpcContext?.requestId ?? extra?.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
    });

    if (charge && rpcContext?.budget) {
      // The handler has no meaningful refund to apply, however registering the
      // usage ensures downstream snapshots expose the association with the
      // intent router for auditing purposes.
      rpcContext.budget.snapshot();
    }

    return buildToolSuccessResult(asJsonPayload(structured), structured);
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
