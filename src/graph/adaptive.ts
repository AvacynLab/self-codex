import { NormalisedGraph } from "./types.js";

/**
 * Record summarising reinforcement statistics collected for a specific edge in
 * an adaptive graph. The orchestrator feeds those counters with outcomes
 * reported by child executions so we can rank paths by effectiveness.
 */
export interface AdaptiveEdgeMetrics {
  /** Total number of successful traversals for the edge. */
  successes: number;
  /** Total number of failed traversals. */
  failures: number;
  /** Sum of per-run durations attributed to the edge (milliseconds). */
  totalDurationMs: number;
  /** Sum of optional rewards or quality scores reported for the edge. */
  totalReward: number;
  /** Unix epoch (ms) describing when the metrics were last updated. */
  lastUpdatedAt: number;
}

/**
 * Container storing reinforcement statistics for every edge in a graph. The map
 * key is serialised as `"<from>→<to>"` to remain stable across evaluations.
 */
export interface AdaptiveGraphState {
  edges: Map<string, AdaptiveEdgeMetrics>;
}

/** Outcome collected after executing a path through the graph. */
export interface PathOutcome {
  /** Ordered list of node identifiers describing the traversed path. */
  path: string[];
  /** Whether the execution was deemed successful. */
  success: boolean;
  /** Total execution time in milliseconds for the whole path. */
  durationMs: number;
  /** Optional reward/score reported by downstream evaluators. */
  reward?: number;
  /** Optional timestamp override (defaults to `Date.now()`). */
  timestamp?: number;
}

/** Options tweaking the reinforcement computation. */
export interface AdaptiveEvaluationOptions {
  /** Target duration (ms) that yields a neutral score. */
  targetDurationMs?: number;
  /**
   * Weight applied to the success ratio when computing the reinforcement
   * score. Defaults to `0.6`.
   */
  successWeight?: number;
  /** Weight applied to the normalised duration term. Defaults to `0.3`. */
  durationWeight?: number;
  /** Weight applied to the reward term. Defaults to `0.1`. */
  rewardWeight?: number;
  /** Minimum number of samples required to reach full confidence. */
  minSamplesForConfidence?: number;
  /** Half-life applied when decaying stale statistics (milliseconds). */
  decayMs?: number;
  /** Reinforcement threshold above which an edge should be boosted. */
  boostThreshold?: number;
  /** Reinforcement threshold below which an edge should be pruned. */
  pruneThreshold?: number;
  /** Reference timestamp used when computing the decay factor. */
  now?: number;
}

/** Insight derived for each edge during an adaptive evaluation. */
export interface EdgeReinforcementInsight {
  /** Identifier of the edge as `<from>→<to>`. */
  edgeKey: string;
  /** Normalised reinforcement score in the `[0, 1]` range. */
  reinforcement: number;
  /** Confidence coefficient based on the number of samples. */
  confidence: number;
  /** Recommendation derived from the reinforcement score. */
  recommendation: "boost" | "keep" | "prune";
  /** Aggregated statistics used to build dashboards. */
  metrics: AdaptiveEdgeMetrics & { attempts: number; successRate: number; averageDurationMs: number };
}

/**
 * Result returned after evaluating a graph with reinforcement data. The insights
 * provide both per-edge recommendations and lists of edges considered weak.
 */
export interface AdaptiveEvaluationResult {
  insights: EdgeReinforcementInsight[];
  edgesToPrune: string[];
  edgesToBoost: string[];
}

const DEFAULT_OPTIONS: Required<Pick<
  AdaptiveEvaluationOptions,
  | "targetDurationMs"
  | "successWeight"
  | "durationWeight"
  | "rewardWeight"
  | "minSamplesForConfidence"
  | "decayMs"
  | "boostThreshold"
  | "pruneThreshold"
>> = {
  targetDurationMs: 2_000,
  successWeight: 0.6,
  durationWeight: 0.3,
  rewardWeight: 0.1,
  minSamplesForConfidence: 3,
  decayMs: 10 * 60_000,
  boostThreshold: 0.65,
  pruneThreshold: 0.25,
};

/** Creates an empty adaptive state. */
export function createAdaptiveGraphState(): AdaptiveGraphState {
  return { edges: new Map() };
}

/**
 * Records the outcome of a path execution inside the adaptive state. The
 * duration and reward are evenly distributed across the traversed edges to keep
 * the scoring logic simple and deterministic.
 */
export function recordPathOutcome(
  state: AdaptiveGraphState,
  outcome: PathOutcome,
): void {
  if (outcome.path.length < 2) {
    return;
  }
  const timestamp = outcome.timestamp ?? Date.now();
  const edgeCount = outcome.path.length - 1;
  const durationPerEdge = outcome.durationMs / edgeCount;
  const rewardPerEdge = (outcome.reward ?? (outcome.success ? 1 : 0)) / edgeCount;

  for (let index = 0; index < outcome.path.length - 1; index += 1) {
    const from = outcome.path[index];
    const to = outcome.path[index + 1];
    const key = edgeKey(from, to);
    const existing = state.edges.get(key);
    const attempts = (existing?.successes ?? 0) + (existing?.failures ?? 0);

    const nextMetrics: AdaptiveEdgeMetrics = existing
      ? {
          successes: existing.successes + (outcome.success ? 1 : 0),
          failures: existing.failures + (outcome.success ? 0 : 1),
          totalDurationMs: existing.totalDurationMs + durationPerEdge,
          totalReward: existing.totalReward + rewardPerEdge,
          lastUpdatedAt: timestamp,
        }
      : {
          successes: outcome.success ? 1 : 0,
          failures: outcome.success ? 0 : 1,
          totalDurationMs: durationPerEdge,
          totalReward: rewardPerEdge,
          lastUpdatedAt: timestamp,
        };

    // Guard against pathological NaN/Infinity propagations when we receive
    // inconsistent telemetry by defaulting to the previous totals.
    if (!Number.isFinite(nextMetrics.totalDurationMs)) {
      nextMetrics.totalDurationMs = existing?.totalDurationMs ?? 0;
    }
    if (!Number.isFinite(nextMetrics.totalReward)) {
      nextMetrics.totalReward = existing?.totalReward ?? 0;
    }
    if (attempts === 0 && !Number.isFinite(nextMetrics.totalDurationMs)) {
      nextMetrics.totalDurationMs = 0;
    }

    state.edges.set(key, nextMetrics);
  }
}

/**
 * Computes reinforcement insights for every edge of the provided graph using
 * the stored adaptive metrics.
 */
export function evaluateAdaptiveGraph(
  graph: NormalisedGraph,
  state: AdaptiveGraphState,
  options: AdaptiveEvaluationOptions = {},
): AdaptiveEvaluationResult {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const now = options.now ?? Date.now();
  const insights: EdgeReinforcementInsight[] = [];
  const edgesToPrune: string[] = [];
  const edgesToBoost: string[] = [];

  for (const edge of graph.edges) {
    const key = edgeKey(edge.from, edge.to);
    const metrics = state.edges.get(key);
    if (!metrics) {
      // Without telemetry we keep the edge neutral to avoid destructive
      // pruning. The caller can decide how to handle missing signals.
      insights.push({
        edgeKey: key,
        reinforcement: 0,
        confidence: 0,
        recommendation: "keep",
        metrics: {
          successes: 0,
          failures: 0,
          totalDurationMs: 0,
          totalReward: 0,
          lastUpdatedAt: 0,
          attempts: 0,
          successRate: 0,
          averageDurationMs: Number.POSITIVE_INFINITY,
        },
      });
      continue;
    }

    const attempts = metrics.successes + metrics.failures;
    const successRate = attempts === 0 ? 0 : metrics.successes / attempts;
    const averageDurationMs = attempts === 0 ? Number.POSITIVE_INFINITY : metrics.totalDurationMs / attempts;
    const rewardAverage = attempts === 0 ? 0 : metrics.totalReward / attempts;
    const confidence = Math.min(1, attempts / mergedOptions.minSamplesForConfidence);

    const decayFactor = computeDecayFactor(metrics.lastUpdatedAt, now, mergedOptions.decayMs);
    const durationTerm = 1 - Math.min(1, averageDurationMs / mergedOptions.targetDurationMs);
    const rewardTerm = Math.min(1, Math.max(0, rewardAverage));

    const reinforcementRaw =
      mergedOptions.successWeight * successRate +
      mergedOptions.durationWeight * durationTerm +
      mergedOptions.rewardWeight * rewardTerm;

    const reinforcement = clamp01(reinforcementRaw * confidence * decayFactor);
    const recommendation =
      reinforcement >= mergedOptions.boostThreshold
        ? "boost"
        : reinforcement <= mergedOptions.pruneThreshold
        ? "prune"
        : "keep";

    if (recommendation === "prune") {
      edgesToPrune.push(key);
    } else if (recommendation === "boost") {
      edgesToBoost.push(key);
    }

    insights.push({
      edgeKey: key,
      reinforcement,
      confidence,
      recommendation,
      metrics: {
        ...metrics,
        attempts,
        successRate,
        averageDurationMs,
      },
    });
  }

  // Keep the output stable for deterministic tests and audit logs.
  insights.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
  edgesToPrune.sort();
  edgesToBoost.sort();

  return { insights, edgesToPrune, edgesToBoost };
}

/**
 * Applies pruning recommendations by returning a new graph descriptor with the
 * weak edges removed. The original graph is not mutated so callers can inspect
 * the delta before committing to the change.
 */
export function pruneWeakBranches(
  graph: NormalisedGraph,
  evaluation: AdaptiveEvaluationResult,
): NormalisedGraph {
  const edges = graph.edges.filter((edge) => !evaluation.edgesToPrune.includes(edgeKey(edge.from, edge.to)));
  return {
    ...graph,
    edges,
    graphVersion: graph.graphVersion + (evaluation.edgesToPrune.length > 0 ? 1 : 0),
  };
}

/**
 * Builds a map of weight multipliers that can be applied to the graph when the
 * orchestrator wants to bias path-finding algorithms towards reinforced edges.
 */
export function deriveWeightMultipliers(
  evaluation: AdaptiveEvaluationResult,
  options: { boostMultiplier?: number; baseMultiplier?: number; pruneMultiplier?: number } = {},
): Map<string, number> {
  const boostMultiplier = options.boostMultiplier ?? 1.2;
  const baseMultiplier = options.baseMultiplier ?? 1;
  const pruneMultiplier = options.pruneMultiplier ?? 0.5;
  const multipliers = new Map<string, number>();

  for (const insight of evaluation.insights) {
    const multiplier =
      insight.recommendation === "boost"
        ? boostMultiplier
        : insight.recommendation === "prune"
        ? pruneMultiplier
        : baseMultiplier;
    multipliers.set(insight.edgeKey, multiplier);
  }

  return multipliers;
}

function edgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function computeDecayFactor(lastUpdatedAt: number, now: number, decayMs: number): number {
  if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt <= 0) {
    return 0.5;
  }
  if (!Number.isFinite(decayMs) || decayMs <= 0) {
    return 1;
  }
  const elapsed = Math.max(0, now - lastUpdatedAt);
  if (elapsed === 0) {
    return 1;
  }
  const halfLives = elapsed / decayMs;
  return Math.pow(0.5, halfLives);
}
