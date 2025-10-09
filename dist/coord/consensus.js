import { EventEmitter } from "node:events";
import { z } from "zod";
/** Internal channel storing subscribers interested in consensus decisions. */
const consensusEmitter = new EventEmitter();
/** Clock function injected for deterministic tests. */
let consensusNow = () => Date.now();
/**
 * Override the clock used when stamping consensus events. Tests rely on this
 * hook to produce deterministic timestamps without resorting to global fake
 * timers.
 */
export function setConsensusEventClock(now) {
    consensusNow = now;
}
/** Reset the consensus event clock back to {@link Date.now}. */
export function resetConsensusEventClock() {
    consensusNow = () => Date.now();
}
/**
 * Publish a consensus decision on the shared emitter. The helper normalises
 * nullable correlation identifiers and ensures timestamps are always
 * populated.
 */
export function publishConsensusEvent(input) {
    const event = {
        ...input,
        at: input.at ?? consensusNow(),
        jobId: input.jobId ?? null,
        runId: input.runId ?? null,
        opId: input.opId ?? null,
        metadata: input.metadata ?? undefined,
    };
    consensusEmitter.emit("event", event);
    return event;
}
/**
 * Subscribe to consensus events. Callers receive a disposer that must be used
 * to detach listeners when shutting the orchestrator down.
 */
export function subscribeConsensusEvents(listener) {
    consensusEmitter.on("event", listener);
    return () => {
        consensusEmitter.off("event", listener);
    };
}
/**
 * Zod schema shared with the plan tools to validate consensus configuration
 * payloads exposed through MCP.
 */
export const ConsensusConfigSchema = z.object({
    mode: z.enum(["majority", "quorum", "weighted"]).default("majority"),
    quorum: z.number().int().positive().optional(),
    weights: z
        .record(z.number().nonnegative())
        .optional()
        .transform((weights) => weights ?? {}),
    prefer_value: z.string().optional(),
    tie_breaker: z.enum(["null", "first", "prefer"]).default("null"),
});
/**
 * Internal helper tallying the weighted votes. Weight defaults to `1` when
 * neither the vote nor the options provide an override.
 */
function tallyVotes(votes, options) {
    const tally = new Map();
    let totalWeight = 0;
    for (const vote of votes) {
        const candidateWeight = options.weights?.[vote.voter];
        const weight = typeof candidateWeight === "number" && candidateWeight >= 0
            ? candidateWeight
            : 1;
        const current = tally.get(vote.value) ?? 0;
        tally.set(vote.value, current + weight);
        totalWeight += weight;
    }
    return { tally, totalWeight };
}
/**
 * Determines the winning value for a tally and resolves ties according to the
 * provided strategy. Returning `null` signals that the tie is unresolved.
 */
function resolveWinner(votes, tally, options) {
    if (tally.size === 0) {
        return { winner: null, tie: false };
    }
    let maxWeight = -Infinity;
    for (const weight of tally.values()) {
        if (weight > maxWeight) {
            maxWeight = weight;
        }
    }
    const topValues = Array.from(tally.entries())
        .filter(([, weight]) => weight === maxWeight)
        .map(([value]) => value);
    if (topValues.length === 1) {
        return { winner: topValues[0], tie: false };
    }
    switch (options.tieBreaker) {
        case "prefer":
            if (options.preferValue && topValues.includes(options.preferValue)) {
                return { winner: options.preferValue, tie: false };
            }
            break;
        case "first":
            for (const vote of votes) {
                if (topValues.includes(vote.value)) {
                    return { winner: vote.value, tie: false };
                }
            }
            break;
        default:
            break;
    }
    return { winner: null, tie: true };
}
/**
 * Computes a simple majority. The decision is satisfied when the winning option
 * strictly exceeds half of the total weight.
 */
export function majority(votes, options = {}) {
    const { tally, totalWeight } = tallyVotes(votes, options);
    const { winner, tie } = resolveWinner(votes, tally, options);
    const threshold = totalWeight > 0 ? Math.floor(totalWeight / 2) + 1 : 1;
    const winningWeight = winner ? tally.get(winner) ?? 0 : 0;
    const satisfied = winner !== null && winningWeight >= threshold;
    return {
        mode: "majority",
        outcome: winner,
        satisfied,
        tie,
        threshold,
        totalWeight,
        tally: Object.fromEntries(tally.entries()),
    };
}
/**
 * Computes a quorum decision. The highest weighted option must reach the
 * provided quorum threshold to be considered satisfied.
 */
export function quorum(votes, options) {
    const { tally, totalWeight } = tallyVotes(votes, options);
    const { winner, tie } = resolveWinner(votes, tally, options);
    const winningWeight = winner ? tally.get(winner) ?? 0 : 0;
    const satisfied = winner !== null && winningWeight >= options.quorum;
    return {
        mode: "quorum",
        outcome: winner,
        satisfied,
        tie,
        threshold: options.quorum,
        totalWeight,
        tally: Object.fromEntries(tally.entries()),
    };
}
/**
 * Computes a weighted majority. Callers may optionally enforce a quorum on top
 * of the weighted vote results.
 */
export function weighted(votes, options) {
    const base = majority(votes, options);
    if (typeof options.quorum === "number") {
        const winningWeight = base.outcome ? base.tally[base.outcome] ?? 0 : 0;
        return {
            ...base,
            mode: "weighted",
            threshold: options.quorum,
            satisfied: base.outcome !== null && winningWeight >= options.quorum,
        };
    }
    return { ...base, mode: "weighted" };
}
/**
 * Shared helper used by consumers to normalise consensus configuration payloads
 * prior to calling the deterministic vote calculators.
 */
export function normaliseConsensusOptions(config) {
    if (!config) {
        return {};
    }
    return {
        weights: config.weights,
        preferValue: config.prefer_value,
        tieBreaker: config.tie_breaker,
        quorum: config.quorum,
    };
}
//# sourceMappingURL=consensus.js.map