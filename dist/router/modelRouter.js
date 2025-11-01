import { z } from "zod";
import { omitUndefinedEntries } from "../utils/object.js";
/** Zod schema used to validate runtime updates to the routing table. */
const specialistConfigSchema = z.object({
    id: z.string().min(1),
    priority: z.number().optional(),
    description: z.string().optional(),
    kinds: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    languages: z.array(z.string().min(1)).optional(),
    maxTokens: z.number().int().positive().optional(),
    available: z.boolean().optional(),
});
/** Laplace smoothing constant preventing reliability collapse. */
const RELIABILITY_PRIOR = 1;
/**
 * Router used by the orchestrator to distribute tasks across specialised
 * local models. The implementation is intentionally deterministic and pure so
 * it can be reused by tests and offline planners without side effects.
 */
export class ModelRouter {
    fallbackModel;
    acceptanceThreshold;
    specialists = new Map();
    stats = new Map();
    fallbackAvailable = true;
    constructor(options) {
        this.fallbackModel = options.fallbackModel;
        this.acceptanceThreshold = options.acceptanceThreshold ?? 0.35;
    }
    /**
     * Registers or replaces a specialist configuration. Validation ensures we do
     * not inject malformed capabilities coming from hot-reload scripts.
     */
    registerSpecialist(config) {
        const parsed = specialistConfigSchema.parse(config);
        // Operators can override the implicit availability; we preserve explicit
        // disablement while omitting the default `true` flag from snapshots.
        const requestedAvailability = config.available ?? parsed.available;
        // NOTE: Optional specialist knobs (priority, languages, tags…) surface as
        // `undefined` when omitted by callers. We strip those keys to keep the
        // stored configuration compliant with `exactOptionalPropertyTypes` while
        // preserving the intent of the original payload.
        const merged = applyAvailability({
            id: parsed.id,
            ...omitUndefinedEntries({ ...config, id: undefined, available: undefined }),
            ...omitUndefinedEntries({ ...parsed, id: undefined, available: undefined }),
        }, requestedAvailability);
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
    unregisterSpecialist(id) {
        this.specialists.delete(id);
        this.stats.delete(id);
    }
    /** Retrieves a snapshot of the configured specialists. */
    listSpecialists() {
        return Array.from(this.specialists.values())
            .map((config) => ({ ...config }))
            .sort((a, b) => {
            const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
            if (priorityDiff !== 0) {
                return priorityDiff;
            }
            return a.id.localeCompare(b.id);
        });
    }
    /**
     * Updates the live availability of a model. Operators typically wire this to
     * health checks so degraded specialists are skipped. When the fallback model
     * itself is unavailable the router refuses to route and surfaces a concise
     * error to upstream callers so they can escalate.
     */
    setAvailability(id, available) {
        if (id === this.fallbackModel) {
            this.fallbackAvailable = available;
            return;
        }
        const specialist = this.specialists.get(id);
        if (!specialist) {
            throw new Error(`Unknown model '${id}'`);
        }
        this.specialists.set(id, applyAvailability(specialist, available));
    }
    /**
     * Computes the best model for a given task. The method always returns a
     * decision: if no specialist scores above the configured threshold we fall
     * back to the default model.
     */
    route(task) {
        const candidates = this.listSpecialists();
        let bestScore = -Infinity;
        let best = this.fallbackModel;
        let bestReason = "fallback";
        const breakdown = [];
        for (const specialist of candidates) {
            if (specialist.available === false) {
                const reliability = this.computeReliability(specialist.id);
                breakdown.push({ id: specialist.id, score: 0, reliability });
                continue;
            }
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
            if (!this.fallbackAvailable) {
                throw new Error(`No available model could satisfy the request and fallback '${this.fallbackModel}' is unavailable.`);
            }
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
    recordOutcome(id, outcome) {
        const stats = this.stats.get(id);
        if (!stats) {
            return;
        }
        if (outcome.success) {
            stats.successes += 1;
        }
        else {
            stats.failures += 1;
        }
        if (typeof outcome.latencyMs === "number" && Number.isFinite(outcome.latencyMs)) {
            stats.totalLatencyMs += outcome.latencyMs;
        }
        stats.invocations += 1;
    }
    /** Exposes aggregated stats for dashboards and tests. */
    getStats(id) {
        const stats = this.stats.get(id);
        if (!stats) {
            return undefined;
        }
        return { ...stats };
    }
    computeHeuristicScore(task, specialist) {
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
        if (typeof task.estimatedTokens === "number" &&
            specialist.maxTokens &&
            task.estimatedTokens <= specialist.maxTokens) {
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
    computeReliability(id) {
        const stats = this.stats.get(id);
        if (!stats) {
            return 1;
        }
        const total = stats.successes + stats.failures;
        const successRate = (stats.successes + RELIABILITY_PRIOR) / (total + 2 * RELIABILITY_PRIOR);
        return clamp01(successRate);
    }
    buildReason(task, specialist, score, reliability) {
        const reasons = [];
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
        if (typeof task.estimatedTokens === "number" &&
            specialist.maxTokens &&
            task.estimatedTokens <= specialist.maxTokens) {
            reasons.push("fits-tokens");
        }
        reasons.push(`score:${score.toFixed(2)}`);
        reasons.push(`reliability:${reliability.toFixed(2)}`);
        return reasons.join(", ");
    }
}
/**
 * Normalises the optional availability flag so the stored configuration only
 * materialises the property when the specialist is explicitly disabled. The
 * helper keeps the router compatible with `exactOptionalPropertyTypes` by
 * omitting implicit `true` defaults while preserving other attributes.
 */
function applyAvailability(config, availability) {
    const sanitised = { ...config };
    if (availability === false) {
        sanitised.available = false;
        return sanitised;
    }
    delete sanitised.available;
    return sanitised;
}
function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}
function equalsIgnoreCase(left, right) {
    return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
function intersectionSize(left, right) {
    const rightSet = new Set(right.map((value) => value.toLowerCase()));
    let count = 0;
    for (const entry of left) {
        if (rightSet.has(entry.toLowerCase())) {
            count += 1;
        }
    }
    return count;
}
function intersect(left, right) {
    const rightSet = new Set(right.map((value) => value.toLowerCase()));
    const results = [];
    for (const entry of left) {
        if (rightSet.has(entry.toLowerCase())) {
            results.push(entry);
        }
    }
    return results;
}
//# sourceMappingURL=modelRouter.js.map