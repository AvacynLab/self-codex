import { EventEmitter } from "node:events";

import { readOptionalInt } from "../config/env.js";
import type { ToolBudgets, ToolManifest } from "../mcp/registry.js";
import { omitUndefinedEntries } from "../utils/object.js";

/** Default number of router candidates surfaced to callers. */
const DEFAULT_ROUTER_TOPK = 5;
/** Upper bound applied to operator supplied top-k hints. */
const MAX_ROUTER_TOPK = 10;

/**
 * Resolves how many tool candidates should be surfaced by the router.
 *
 * The helper reads the `TOOLROUTER_TOPK` environment variable and guards
 * against invalid values. Keeping the logic centralised ensures every consumer
 * — façade, runtime logger and registry — honours the same operator override.
 */
export function resolveToolRouterTopKLimit(): number {
  const override = readOptionalInt("TOOLROUTER_TOPK", { min: 1 });
  if (override === undefined) {
    return DEFAULT_ROUTER_TOPK;
  }
  return Math.min(MAX_ROUTER_TOPK, override);
}

/**
 * Describes the contextual signals forwarded to the {@link ToolRouter} when
 * selecting the best façade to execute. The structure intentionally mirrors the
 * information available to upstream planners (intent text, derived tags,
 * metadata hints) so the router can stay pure and side-effect free.
 */
export interface ToolRoutingContext {
  /** Natural language goal extracted from the caller request (lowercased). */
  goal?: string;
  /** Optional coarse-grained category suggested by the orchestrator. */
  category?: string;
  /** Additional tags inferred from the plan or active memories. */
  tags?: string[];
  /**
   * Optional list of tool names explicitly preferred by the caller. The router
   * boosts these candidates without bypassing safety checks such as
   * availability or reliability priors.
   */
  preferredTools?: string[];
  /** Arbitrary metadata attached to the routing request. */
  metadata?: Record<string, unknown>;
}

/** Snapshot returned for each tool scored by the router. */
export interface ToolRoutingCandidate {
  /** Name of the registered façade. */
  tool: string;
  /** Normalised confidence score in the `[0, 1]` range. */
  score: number;
  /** Reliability factor derived from the observed outcomes. */
  reliability: number;
  /** Concise explanation to surface in observability logs. */
  rationale: string;
}

/** Result returned when the router selects a candidate. */
export interface ToolRouterDecision {
  /** Selected façade (fallbacks included). */
  tool: string;
  /** Confidence score associated with the selection. */
  score: number;
  /** Human readable reason summarising the decision. */
  reason: string;
  /** Ordered list of the top scored candidates (including the winner). */
  candidates: ToolRoutingCandidate[];
  /** Timestamp when the decision was taken. */
  decidedAt: number;
}

/** Outcome reported back to the router once the façade finished executing. */
export interface ToolRouterOutcome {
  tool: string;
  /** Whether the execution produced the expected result. */
  success: boolean;
  /** Optional latency observed for the run in milliseconds. */
  latencyMs?: number;
}

/** Structured payload emitted when {@link ToolRouter.recordOutcome} is invoked. */
export interface ToolRouterOutcomeEvent extends ToolRouterOutcome {
  /** Reliability computed after the outcome was processed. */
  reliability: number;
  /** Aggregate success rate in the `[0, 1]` range. */
  successRate: number;
  /** Consecutive failure streak contributing to the backoff penalty. */
  failureStreak: number;
}

/**
 * Input recorded by the resource registry when the router emits a decision.
 * The additional correlation fields allow operators to correlate choices with
 * runs/jobs in dashboards without hard-coding registry internals in the router.
 */
export interface ToolRouterDecisionRecord {
  context: ToolRoutingContext;
  decision: ToolRouterDecision;
  requestId?: string | null;
  traceId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  childId?: string | null;
  elapsedMs?: number | null;
}

/** Options accepted when instantiating a {@link ToolRouter}. */
export interface ToolRouterOptions {
  /** Pre-configured fallback tools suggested when no candidate scores high enough. */
  fallbacks?: Array<{ tool: string; rationale: string; score: number }>;
  /** Minimum score required to accept a candidate instead of using fallbacks. */
  acceptanceThreshold?: number;
  /** Clock override used by tests to obtain deterministic timestamps. */
  now?: () => number;
}

/** Internal statistics accumulated per façade to derive reliability. */
interface ToolStats {
  successes: number;
  failures: number;
  totalLatencyMs: number;
  invocations: number;
  latencySamples: number[];
  failureStreak: number;
  lastFailureAt: number | null;
}

/** Internal record tracking registered tools and their derived keywords. */
interface RegisteredTool {
  manifest: ToolManifest;
  keywords: Set<string>;
  tags: Set<string>;
  embedding: Record<string, number>;
  embeddingNorm: number;
  budgetWeight: number;
}

/** Laplace smoothing constant ensuring reliability never drops to zero. */
const RELIABILITY_PRIOR = 1;

/** Maximum number of latency samples retained per tool. */
const LATENCY_SAMPLE_LIMIT = 32;

/** Consecutive failure window (milliseconds) considered when applying backoff penalties. */
const FAILURE_BACKOFF_WINDOW_MS = 5 * 60 * 1_000;

/** Utility ensuring scores stay within the `[0, 1]` range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/** Builds a normalised token-frequency embedding from the provided tokens. */
function buildEmbedding(tokens: Iterable<string>): { embedding: Record<string, number>; norm: number } {
  const embedding: Record<string, number> = {};
  let count = 0;
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    count += 1;
    embedding[token] = (embedding[token] ?? 0) + 1;
  }
  if (count === 0) {
    return { embedding, norm: 0 };
  }
  for (const key of Object.keys(embedding)) {
    embedding[key] = embedding[key] / count;
  }
  let squared = 0;
  for (const value of Object.values(embedding)) {
    squared += value * value;
  }
  return { embedding, norm: Math.sqrt(squared) };
}

/** Computes cosine similarity between two sparse embeddings. */
function cosineSimilarity(
  query: Record<string, number>,
  queryNorm: number,
  doc: Record<string, number>,
  docNorm: number,
): number {
  if (queryNorm === 0 || docNorm === 0) {
    return 0;
  }
  let dot = 0;
  for (const [token, weight] of Object.entries(query)) {
    const other = doc[token];
    if (typeof other === "number" && other !== 0) {
      dot += weight * other;
    }
  }
  return clamp01(dot / (queryNorm * docNorm));
}

/**
 * Extracts string-like signals from the routing metadata. Only textual hints contribute to the
 * embedding so arbitrary nested objects can be ignored safely.
 */
function collectMetadataTokens(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }
  const bucket: string[] = [];
  const ingest = (value: unknown) => {
    if (typeof value === "string") {
      bucket.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        ingest(entry);
      }
    }
  };
  for (const value of Object.values(metadata)) {
    ingest(value);
  }
  return bucket;
}

/** Builds an embedding directly from the provided routing context. */
function buildContextEmbedding(context: ToolRoutingContext): { embedding: Record<string, number>; norm: number } {
  const tokens: string[] = [];
  tokens.push(...tokenise(context.goal));
  tokens.push(...tokenise(context.category));
  if (context.tags) {
    for (const tag of context.tags) {
      tokens.push(...tokenise(tag));
    }
  }
  if (context.preferredTools) {
    for (const tool of context.preferredTools) {
      tokens.push(...tokenise(tool));
    }
  }
  for (const value of collectMetadataTokens(context.metadata)) {
    tokens.push(...tokenise(value));
  }
  return buildEmbedding(tokens);
}

/**
 * Normalises router metadata by dropping keys with `undefined` values.
 *
 * Keeping the metadata compact avoids leaking undefined placeholders when
 * routing contexts are serialised for observability or persisted in the
 * registry history.
 */
function normaliseRoutingMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Produces a sanitised snapshot of the routing context that omits every
 * optional field left `undefined` by callers. Arrays and metadata are cloned so
 * observers cannot mutate the original context.
 */
function sanitiseRoutingContext(context: ToolRoutingContext): ToolRoutingContext {
  const metadata = normaliseRoutingMetadata(context.metadata);
  const snapshot = omitUndefinedEntries({
    goal: context.goal,
    category: context.category,
    tags: context.tags && context.tags.length > 0 ? [...context.tags] : undefined,
    preferredTools:
      context.preferredTools && context.preferredTools.length > 0
        ? [...context.preferredTools]
        : undefined,
    metadata: metadata ? { ...metadata } : undefined,
  });
  return snapshot as ToolRoutingContext;
}

/** Pre-computes a deterministic budget weight derived from the manifest budgets. */
function computeBudgetWeight(budgets: ToolBudgets | undefined): number {
  if (!budgets) {
    return 1;
  }
  let weight = 1;
  if (typeof budgets.time_ms === "number" && Number.isFinite(budgets.time_ms) && budgets.time_ms > 0) {
    const ratio = budgets.time_ms / 5_000;
    weight *= 1 / (1 + Math.max(0, ratio));
  }
  if (typeof budgets.tool_calls === "number" && Number.isFinite(budgets.tool_calls) && budgets.tool_calls > 0) {
    const extraCalls = Math.max(0, budgets.tool_calls - 1);
    weight *= 1 / (1 + extraCalls * 0.5);
  }
  if (typeof budgets.bytes_out === "number" && Number.isFinite(budgets.bytes_out) && budgets.bytes_out > 0) {
    const ratio = budgets.bytes_out / 32_768;
    weight *= 1 / (1 + Math.max(0, ratio));
  }
  return clamp01(weight);
}

/**
 * Tokenises arbitrary text into normalised keywords. The helper mirrors the
 * approach used by `MetaCritic` so we can reuse deterministic expectations in
 * tests without leaking implementation details across modules.
 */
function tokenise(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Router scoring registered façades using lightweight heuristics (category,
 * tags, keyword overlap) combined with reliability priors derived from runtime
 * feedback. The implementation is intentionally deterministic and does not
 * depend on global orchestrator state so it can be exercised in isolation.
 */
export class ToolRouter extends EventEmitter {
  private readonly fallbacks: Array<{ tool: string; rationale: string; score: number }>;
  private readonly acceptanceThreshold: number;
  private readonly now: () => number;
  private readonly registry = new Map<string, RegisteredTool>();
  private readonly stats = new Map<string, ToolStats>();

  constructor(options: ToolRouterOptions = {}) {
    super();
    this.fallbacks = options.fallbacks ?? [];
    this.acceptanceThreshold = options.acceptanceThreshold ?? 0.45;
    this.now = options.now ?? (() => Date.now());
  }

  /** Clears all registered tools. Mostly used by tests. */
  reset(): void {
    this.registry.clear();
    this.stats.clear();
  }

  /** Registers (or replaces) a façade manifest. */
  register(manifest: ToolManifest): void {
    const keywords = new Set<string>([
      ...tokenise(manifest.name),
      ...tokenise(manifest.title),
      ...tokenise(manifest.description ?? ""),
      ...(manifest.tags ?? []).map((tag) => tag.toLowerCase()),
    ]);
    const tags = new Set<string>((manifest.tags ?? []).map((tag) => tag.toLowerCase()));
    const manifestTokens = [
      ...tokenise(manifest.name),
      ...tokenise(manifest.title),
      ...tokenise(manifest.description ?? ""),
      ...(manifest.tags ?? []).flatMap((tag) => tokenise(tag)),
      ...tokenise(manifest.category),
    ];
    const { embedding, norm } = buildEmbedding(manifestTokens);
    const budgetWeight = computeBudgetWeight(manifest.budgets);
    this.registry.set(manifest.name, { manifest, keywords, tags, embedding, embeddingNorm: norm, budgetWeight });
    if (!this.stats.has(manifest.name)) {
      this.stats.set(manifest.name, {
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        invocations: 0,
        latencySamples: [],
        failureStreak: 0,
        lastFailureAt: null,
      });
    }
  }

  /** Unregisters a façade from the routing table. */
  unregister(tool: string): void {
    this.registry.delete(tool);
    this.stats.delete(tool);
  }

  /** Records a success/failure outcome for reliability computations. */
  recordOutcome(outcome: ToolRouterOutcome): void {
    const stats = this.stats.get(outcome.tool);
    if (!stats) {
      return;
    }
    stats.invocations += 1;
    if (outcome.success) {
      stats.successes += 1;
      stats.failureStreak = 0;
      stats.lastFailureAt = null;
    } else {
      stats.failures += 1;
      stats.failureStreak += 1;
      stats.lastFailureAt = this.now();
    }
    if (Number.isFinite(outcome.latencyMs)) {
      const latency = Math.max(0, Math.round(outcome.latencyMs as number));
      stats.totalLatencyMs += latency;
      stats.latencySamples.push(latency);
      if (stats.latencySamples.length > LATENCY_SAMPLE_LIMIT) {
        stats.latencySamples.splice(0, stats.latencySamples.length - LATENCY_SAMPLE_LIMIT);
      }
    }
    this.stats.set(outcome.tool, stats);
    const reliability = this.computeReliability(outcome.tool);
    const successRate = stats.invocations > 0 ? clamp01(stats.successes / stats.invocations) : 1;
    const payload: ToolRouterOutcomeEvent = {
      tool: outcome.tool,
      success: outcome.success,
      reliability,
      successRate,
      failureStreak: stats.failureStreak,
      // Preserve optional latency telemetry only when callers recorded a valid
      // measurement. This prevents `latencyMs: undefined` from leaking once
      // `exactOptionalPropertyTypes` is enforced.
      ...(Number.isFinite(outcome.latencyMs) ? { latencyMs: outcome.latencyMs } : {}),
    };
    this.emit("outcome", payload);
  }

  /** Returns the registered tool manifests sorted by deterministic order. */
  listRegistered(): ToolManifest[] {
    return Array.from(this.registry.values())
      .map((entry) => ({ ...entry.manifest }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Routes the provided context to the most relevant tool. The method returns
   * both the winning candidate and the scored breakdown so callers can expose
   * rich diagnostics in observability dashboards.
   */
  route(context: ToolRoutingContext): ToolRouterDecision {
    const candidates = this.scoreCandidates(context);
    const topKLimit = resolveToolRouterTopKLimit();
    const best = candidates[0];
    const decisionTime = this.now();
    const contextSnapshot = sanitiseRoutingContext(context);

    if (!best || best.score < this.acceptanceThreshold) {
      const fallback = this.resolveFallbackCandidates(context, topKLimit);
      const winner = fallback[0];
      const reason = winner
        ? `fallback:${winner.tool}`
        : "fallback:unavailable";
      const decision: ToolRouterDecision = {
        tool: winner ? winner.tool : "tools_help",
        score: winner ? winner.score : 0.4,
        reason,
        candidates: fallback,
        decidedAt: decisionTime,
      };
      this.emit("decision", { context: contextSnapshot, decision });
      return decision;
    }

    const limitedCandidates = candidates.slice(0, Math.max(1, topKLimit));

    const reasonParts: string[] = [];
    if (context.category && best.rationale.includes("category")) {
      reasonParts.push(`category:${context.category}`);
    }
    if (context.tags && context.tags.length > 0) {
      reasonParts.push(`tags:${context.tags.slice(0, 3).join(",")}`);
    }
    if (context.goal) {
      reasonParts.push("goal_overlap");
    }
    if (reasonParts.length === 0) {
      reasonParts.push("heuristics");
    }

    const decision: ToolRouterDecision = {
      tool: best.tool,
      score: best.score,
      reason: reasonParts.join("|"),
      candidates: limitedCandidates,
      decidedAt: decisionTime,
    };
    this.emit("decision", { context: contextSnapshot, decision });
    return decision;
  }

  /** Scores every registered tool against the provided context. */
  scoreCandidates(context: ToolRoutingContext): ToolRoutingCandidate[] {
    const goalTokens = new Set(tokenise(context.goal));
    const preferred = new Set((context.preferredTools ?? []).map((tool) => tool.toLowerCase()));
    const tagSet = new Set((context.tags ?? []).map((tag) => tag.toLowerCase()));
    const { embedding: contextEmbedding, norm: contextNorm } = buildContextEmbedding(context);

    const candidates: ToolRoutingCandidate[] = [];
    for (const entry of this.registry.values()) {
      const { manifest, keywords, tags, embedding, embeddingNorm, budgetWeight } = entry;
      if (manifest.hidden === true && !(manifest.tags ?? []).includes("facade")) {
        continue;
      }
      const reasonParts: string[] = [];
      let score = 0;

      if (context.category && manifest.category === context.category) {
        score += 0.35;
        reasonParts.push("category");
      }

      if (tagSet.size > 0 && tags.size > 0) {
        let matched = 0;
        for (const tag of tagSet) {
          if (tags.has(tag)) {
            matched += 1;
          }
        }
        if (matched > 0) {
          score += Math.min(0.25, matched * 0.1);
          reasonParts.push("tags");
        }
      }

      if (goalTokens.size > 0 && keywords.size > 0) {
        let overlap = 0;
        for (const token of goalTokens) {
          if (keywords.has(token)) {
            overlap += 1;
          }
        }
        if (overlap > 0) {
          score += Math.min(0.3, overlap * 0.08);
          reasonParts.push("keywords");
        }
      }

      if (preferred.has(manifest.name.toLowerCase())) {
        score += 0.1;
        reasonParts.push("preferred");
      }

      const similarity = cosineSimilarity(contextEmbedding, contextNorm, embedding, embeddingNorm);
      if (similarity > 0) {
        score += Math.min(0.35, similarity * 0.45);
        reasonParts.push("embedding");
      }

      const reliability = this.computeReliability(manifest.name);
      const heuristicsScore = clamp01(score);
      const budgetAdjusted = heuristicsScore * (budgetWeight <= 0 ? 0.1 : budgetWeight);
      if (budgetWeight < 1) {
        reasonParts.push("budget");
      }
      const finalScore = clamp01(budgetAdjusted * reliability);
      const rationale = reasonParts.length > 0 ? reasonParts.join("+") : "baseline";

      candidates.push({
        tool: manifest.name,
        score: clamp01(finalScore),
        reliability,
        rationale,
      });
    }

    return candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.tool.localeCompare(b.tool);
    });
  }

  /** Resolves fallback candidates when no heuristic crosses the threshold. */
  private resolveFallbackCandidates(
    context: ToolRoutingContext,
    limit = resolveToolRouterTopKLimit(),
  ): ToolRoutingCandidate[] {
    if (this.fallbacks.length === 0) {
      return [
        {
          tool: "tools_help",
          score: 0.5,
          reliability: 1,
          rationale: "fallback",
        },
      ];
    }
    const tagSet = new Set((context.tags ?? []).map((tag) => tag.toLowerCase()));
    return this.fallbacks
      .map((fallback, index) => {
        const boost = tagSet.has(fallback.tool.toLowerCase()) ? 0.05 : Math.max(0, 0.05 - index * 0.01);
        return {
          tool: fallback.tool,
          score: clamp01(fallback.score + boost),
          reliability: 1,
          rationale: fallback.rationale,
        };
      })
      .slice(0, Math.max(1, limit));
  }

  /** Computes the reliability factor for the given tool using Laplace priors. */
  private computeReliability(tool: string): number {
    const stats = this.stats.get(tool);
    if (!stats || stats.invocations === 0) {
      return 1;
    }
    const alpha = stats.successes + RELIABILITY_PRIOR;
    const beta = stats.failures + RELIABILITY_PRIOR;
    let reliability = alpha / (alpha + beta);
    if (stats.failureStreak > 0 && stats.lastFailureAt !== null) {
      const elapsed = this.now() - stats.lastFailureAt;
      if (elapsed <= FAILURE_BACKOFF_WINDOW_MS) {
        reliability *= Math.pow(0.5, stats.failureStreak);
      } else {
        stats.failureStreak = 0;
        stats.lastFailureAt = null;
        this.stats.set(tool, stats);
      }
    }
    return clamp01(reliability);
  }
}

export default ToolRouter;
