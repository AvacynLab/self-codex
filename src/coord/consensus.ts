import { EventEmitter } from "node:events";
import { z } from "zod";

/**
 * Single vote cast by an agent. `value` identifies the chosen option while the
 * voter identifier allows deterministic weighting by caller-provided maps.
 */
export interface ConsensusVote {
  voter: string;
  value: string;
}

/**
 * Result returned by the consensus helpers. `outcome` is `null` whenever no
 * option satisfied the criteria (for instance when a quorum is not met or a tie
 * remains unresolved). The tally is exposed to aid auditing in tests.
 */
export interface ConsensusDecision {
  mode: "majority" | "quorum" | "weighted";
  outcome: string | null;
  satisfied: boolean;
  tie: boolean;
  threshold: number | null;
  totalWeight: number;
  tally: Record<string, number>;
}

/**
 * Structured event emitted whenever a consensus computation completes. These
 * events are bridged onto the unified MCP bus so downstream observers can
 * correlate quorum checks with plan lifecycle operations.
 */
export interface ConsensusEvent {
  kind: "decision";
  /** Millisecond timestamp recorded when the decision was published. */
  at: number;
  /**
   * High level source describing which subsystem produced the event. Typical
   * values include "plan_join" or "consensus_vote" so tooling can group
   * related activity.
   */
  source: string;
  /** Consensus mode that produced the decision. */
  mode: ConsensusDecision["mode"];
  /** Winning outcome (if any). */
  outcome: string | null;
  /** Indicates whether the decision satisfied the configured threshold. */
  satisfied: boolean;
  /** Signals a tie preventing a deterministic outcome. */
  tie: boolean;
  /** Threshold applied during the decision (quorum, weighted, ...). */
  threshold: number | null;
  /** Total weight of all ballots considered. */
  totalWeight: number;
  /** Per-option tally used while computing the outcome. */
  tally: Record<string, number>;
  /** Total number of ballots processed. */
  votes: number;
  /** Optional job identifier propagated when available. */
  jobId?: string | null;
  /** Optional run identifier propagated when available. */
  runId?: string | null;
  /** Optional operation identifier propagated when available. */
  opId?: string | null;
  /** Additional metadata providing contextual hints (policy, winner, ...). */
  metadata?: Record<string, unknown>;
}

/** Payload accepted when publishing consensus events. */
export type ConsensusEventInput = Omit<ConsensusEvent, "at"> & { at?: number };

/** Listener invoked whenever a consensus event is emitted. */
export type ConsensusEventListener = (event: ConsensusEvent) => void;

/** Internal channel storing subscribers interested in consensus decisions. */
const consensusEmitter = new EventEmitter();

/** Clock function injected for deterministic tests. */
let consensusNow: () => number = () => Date.now();

/**
 * Override the clock used when stamping consensus events. Tests rely on this
 * hook to produce deterministic timestamps without resorting to global fake
 * timers.
 */
export function setConsensusEventClock(now: () => number): void {
  consensusNow = now;
}

/** Reset the consensus event clock back to {@link Date.now}. */
export function resetConsensusEventClock(): void {
  consensusNow = () => Date.now();
}

/**
 * Publish a consensus decision on the shared emitter. The helper normalises
 * nullable correlation identifiers and ensures timestamps are always
 * populated.
 */
export function publishConsensusEvent(input: ConsensusEventInput): ConsensusEvent {
  const event: ConsensusEvent = {
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
export function subscribeConsensusEvents(listener: ConsensusEventListener): () => void {
  consensusEmitter.on("event", listener);
  return () => {
    consensusEmitter.off("event", listener);
  };
}

/**
 * Configuration shared by the consensus strategies. Callers can provide static
 * weights, a preferred outcome when breaking ties and determine how unresolved
 * ties should be reported.
 */
export interface ConsensusOptions {
  weights?: Record<string, number>;
  preferValue?: string;
  tieBreaker?: "null" | "first" | "prefer";
}

/** Additional parameters accepted by quorum-based strategies. */
export interface QuorumOptions extends ConsensusOptions {
  quorum: number;
}

/** Parameters accepted by the weighted strategy. */
export interface WeightedOptions extends ConsensusOptions {
  quorum?: number;
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

export type ConsensusConfig = z.infer<typeof ConsensusConfigSchema>;

/**
 * Internal helper tallying the weighted votes. Weight defaults to `1` when
 * neither the vote nor the options provide an override.
 */
function tallyVotes(
  votes: ConsensusVote[],
  options: ConsensusOptions | QuorumOptions | WeightedOptions,
): { tally: Map<string, number>; totalWeight: number } {
  const tally = new Map<string, number>();
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
function resolveWinner(
  votes: ConsensusVote[],
  tally: Map<string, number>,
  options: ConsensusOptions,
): { winner: string | null; tie: boolean } {
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
export function majority(
  votes: ConsensusVote[],
  options: ConsensusOptions = {},
): ConsensusDecision {
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
export function quorum(
  votes: ConsensusVote[],
  options: QuorumOptions,
): ConsensusDecision {
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
export function weighted(
  votes: ConsensusVote[],
  options: WeightedOptions,
): ConsensusDecision {
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
export function normaliseConsensusOptions(
  config: ConsensusConfig | undefined,
): ConsensusOptions & { quorum?: number } {
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
