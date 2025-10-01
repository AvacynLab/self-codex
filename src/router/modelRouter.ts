import { z } from "zod";

/**
 * Descriptor of a task that needs to be routed to a specialist model.
 * The orchestrator extracts these attributes from the caller request
 * (tool invocation, child prompt, graph analysis task, ...).
 */
export interface RoutingTaskDescriptor {
  /** Coarse grained category, e.g. "code", "vision", "math", "text". */
  kind?: string;
  /** Optional MIME type of the primary payload when available. */
  mimeType?: string;
  /**
   * Tags assigned by upstream planners or memory to highlight constraints
   * such as `"diagram"`, `"retrieval"`, `"compute-heavy"`, ...
   */
  tags?: string[];
  /** Language hint extracted from prompts or metadata (ISO code). */
  language?: string;
  /** Estimated number of tokens required for the task. */
  estimatedTokens?: number;
  /** Arbitrary metadata forwarded by higher level components. */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration shared by every registered specialist. Most knobs are optional
 * so integrators can start with a simple `kinds` match and later refine the
 * strategy without changing the public API.
 */
export interface SpecialistConfig {
  /** Unique identifier that doubles as the model name to invoke. */
  id: string;
  /**
   * Higher priority specialists win ties when scores are equal. Defaults to 0
   * and primarily helps promote bespoke fine-tunes over generic fallbacks.
   */
  priority?: number;
  /** Human readable description used in diagnostics and dashboards. */
  description?: string;
  /**
   * Categories supported by the specialist. Matching kinds contribute to the
   * routing score and also act as a soft filter.
   */
  kinds?: string[];
  /** Tags that the specialist excels at (diagram, planning, evaluation, ...). */
  tags?: string[];
  /** Preferred languages. */
  languages?: string[];
  /** Maximum sequence length tolerated by the runtime. */
  maxTokens?: number;
  /** Optional custom scoring hook evaluated in addition to heuristics. */
  scorer?: (task: RoutingTaskDescriptor) => number;
}

/** Telemetry collected for each specialist to inform the routing decision. */
interface SpecialistStats {
  successes: number;
  failures: number;
  totalLatencyMs: number;
  invocations: number;
}

/** Result returned by the {@link ModelRouter.route} method. */
export interface RoutingDecision {
  /** Identifier of the chosen specialist (or fallback). */
  model: string;
  /** Normalised score between 0 and 1 summarising the confidence. */
  score: number;
  /** Concise reason helping operators debug routing decisions. */
  reason: string;
  /** Diagnostic snapshot containing all scored candidates. */
  breakdown: Array<{ id: string; score: number; reliability: number }>;
}

/** Options applied when instantiating a {@link ModelRouter}. */
export interface ModelRouterOptions {
  /** Identifier used when no specialist claims the task. */
  fallbackModel: string;
  /** Minimum score required to avoid falling back. */
  acceptanceThreshold?: number;
}

/** Zod schema used to validate runtime updates to the routing table. */
const specialistConfigSchema = z.object({
  id: z.string().min(1),
  priority: z.number().optional(),
  description: z.string().optional(),
  kinds: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  languages: z.array(z.string().min(1)).optional(),
  maxTokens: z.number().int().positive().optional(),
});

/** Laplace smoothing constant preventing reliability collapse. */
const RELIABILITY_PRIOR = 1;

/**
 * Router used by the orchestrator to distribute tasks across specialised
 * local models. The implementation is intentionally deterministic and pure so
 * it can be reused by tests and offline planners without side effects.
 */
export class ModelRouter {
  private readonly fallbackModel: string;
  private readonly acceptanceThreshold: number;
  private readonly specialists = new Map<string, SpecialistConfig>();
  private readonly stats = new Map<string, SpecialistStats>();

  constructor(options: ModelRouterOptions) {
    this.fallbackModel = options.fallbackModel;
    this.acceptanceThreshold = options.acceptanceThreshold ?? 0.35;
  }

  /**
   * Registers or replaces a specialist configuration. Validation ensures we do
   * not inject malformed capabilities coming from hot-reload scripts.
   */
  registerSpecialist(config: SpecialistConfig): void {
    const parsed = specialistConfigSchema.parse(config);
    const merged: SpecialistConfig = { ...config, ...parsed };
    this.specialists.set(merged.id, merged);
    if (!this.stats.has(merged.id)) {
      this.stats.set(merged.id, {
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        invocations: 0,
      });
    }
  }

  /** Removes a specialist from the routing table. */
  unregisterSpecialist(id: string): void {
    this.specialists.delete(id);
    this.stats.delete(id);
  }

  /** Retrieves a snapshot of the configured specialists. */
  listSpecialists(): SpecialistConfig[] {
    return Array.from(this.specialists.values()).sort((a, b) => {
      const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Computes the best model for a given task. The method always returns a
   * decision: if no specialist scores above the configured threshold we fall
   * back to the default model.
   */
  route(task: RoutingTaskDescriptor): RoutingDecision {
    const candidates = this.listSpecialists();
    let bestScore = -Infinity;
    let best = this.fallbackModel;
    let bestReason = "fallback";
    const breakdown: Array<{ id: string; score: number; reliability: number }> = [];

    for (const specialist of candidates) {
      const reliability = this.computeReliability(specialist.id);
      const heuristicScore = this.computeHeuristicScore(task, specialist);
      const customScore = specialist.scorer ? specialist.scorer(task) : 0;
      const score = clamp01(heuristicScore + customScore) * reliability;
      breakdown.push({ id: specialist.id, score, reliability });
      if (score > bestScore) {
        bestScore = score;
        best = specialist.id;
        bestReason = this.buildReason(task, specialist, score, reliability);
      }
    }

    if (bestScore < this.acceptanceThreshold) {
      return {
        model: this.fallbackModel,
        score: clamp01(bestScore),
        reason: "fallback",
        breakdown,
      };
    }

    return { model: best, score: clamp01(bestScore), reason: bestReason, breakdown };
  }

  /**
   * Records the outcome of a routed task so future decisions can account for
   * reliability. Latency is optional and only used for telemetry.
   */
  recordOutcome(id: string, outcome: { success: boolean; latencyMs?: number }): void {
    const stats = this.stats.get(id);
    if (!stats) {
      return;
    }
    if (outcome.success) {
      stats.successes += 1;
    } else {
      stats.failures += 1;
    }
    if (typeof outcome.latencyMs === "number" && Number.isFinite(outcome.latencyMs)) {
      stats.totalLatencyMs += outcome.latencyMs;
    }
    stats.invocations += 1;
  }

  /** Exposes aggregated stats for dashboards and tests. */
  getStats(id: string): SpecialistStats | undefined {
    const stats = this.stats.get(id);
    if (!stats) {
      return undefined;
    }
    return { ...stats };
  }

  private computeHeuristicScore(task: RoutingTaskDescriptor, specialist: SpecialistConfig): number {
    let score = 0;
    if (task.kind) {
      const kind = task.kind;
      const kindMatch = specialist.kinds?.some((candidate) => equalsIgnoreCase(candidate, kind));
      if (kindMatch) {
        score += 0.45;
      }
    }
    if (task.tags && task.tags.length > 0 && specialist.tags && specialist.tags.length > 0) {
      const tagMatches = intersectionSize(task.tags, specialist.tags);
      if (tagMatches > 0) {
        score += Math.min(0.25, tagMatches * 0.1);
      }
    }
    if (task.language) {
      const language = task.language;
      const languageMatch = specialist.languages?.some((candidate) => equalsIgnoreCase(candidate, language));
      if (languageMatch) {
        score += 0.1;
      }
    }
    if (
      typeof task.estimatedTokens === "number" &&
      specialist.maxTokens &&
      task.estimatedTokens <= specialist.maxTokens
    ) {
      score += 0.1;
    }
    if (task.mimeType) {
      const mime = task.mimeType;
      const mimeMatch = specialist.tags?.some((tag) => equalsIgnoreCase(tag, mime));
      if (mimeMatch) {
        score += 0.05;
      }
    }
    return score;
  }

  private computeReliability(id: string): number {
    const stats = this.stats.get(id);
    if (!stats) {
      return 1;
    }
    const total = stats.successes + stats.failures;
    const successRate = (stats.successes + RELIABILITY_PRIOR) / (total + 2 * RELIABILITY_PRIOR);
    return clamp01(successRate);
  }

  private buildReason(
    task: RoutingTaskDescriptor,
    specialist: SpecialistConfig,
    score: number,
    reliability: number,
  ): string {
    const reasons: string[] = [];
    if (task.kind) {
      const kind = task.kind;
      const kindMatch = specialist.kinds?.some((candidate) => equalsIgnoreCase(candidate, kind));
      if (kindMatch) {
        reasons.push(`kind:${kind}`);
      }
    }
    if (task.tags && specialist.tags) {
      const matches = intersect(task.tags, specialist.tags);
      if (matches.length > 0) {
        reasons.push(`tags:${matches.join("|")}`);
      }
    }
    if (task.language) {
      const language = task.language;
      const languageMatch = specialist.languages?.some((candidate) => equalsIgnoreCase(candidate, language));
      if (languageMatch) {
        reasons.push(`lang:${language}`);
      }
    }
    if (
      typeof task.estimatedTokens === "number" &&
      specialist.maxTokens &&
      task.estimatedTokens <= specialist.maxTokens
    ) {
      reasons.push("fits-tokens");
    }
    reasons.push(`score:${score.toFixed(2)}`);
    reasons.push(`reliability:${reliability.toFixed(2)}`);
    return reasons.join(", ");
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function intersectionSize(left: string[], right: string[]): number {
  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  let count = 0;
  for (const entry of left) {
    if (rightSet.has(entry.toLowerCase())) {
      count += 1;
    }
  }
  return count;
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  const results: string[] = [];
  for (const entry of left) {
    if (rightSet.has(entry.toLowerCase())) {
      results.push(entry);
    }
  }
  return results;
}
