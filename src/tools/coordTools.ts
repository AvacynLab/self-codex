import { z } from "zod";

import {
  BlackboardBatchSetInput,
  BlackboardEntrySnapshot,
  BlackboardEvent,
  BlackboardStore,
} from "../coord/blackboard.js";
import {
  ContractNetAwardDecision,
  ContractNetBidSnapshot,
  ContractNetCallSnapshot,
  ContractNetCoordinator,
} from "../coord/contractNet.js";
import {
  StigmergyField,
  StigmergyFieldSnapshot,
  StigmergyPointSnapshot,
  StigmergyTotalSnapshot,
} from "../coord/stigmergy.js";
import { StructuredLogger } from "../logger.js";
import {
  ConsensusConfigSchema,
  majority,
  publishConsensusEvent,
  quorum,
  weighted,
  type ConsensusDecision,
  type ConsensusVote,
} from "../coord/consensus.js";
import { IdempotencyRegistry } from "../infra/idempotency.js";

/**
 * Error raised when a requested blackboard key cannot be found. The dedicated
 * code ensures MCP clients can distinguish between missing entries and actual
 * transport failures.
 */
export class BlackboardEntryNotFoundError extends Error {
  public readonly code = "E-BB-NOTFOUND";
  public readonly details: { key: string };

  constructor(key: string) {
    super(`No blackboard entry found for key ${key}`);
    this.name = "BlackboardEntryNotFoundError";
    this.details = { key };
  }
}

/**
 * Context shared by coordination-related tools. Injected by the server so the
 * handlers stay testable and do not directly depend on singletons.
 */
export interface CoordinationToolContext {
  /** Blackboard instance storing shared key/value state across agents. */
  blackboard: BlackboardStore;
  /** Stigmergic field aggregating pheromone intensities. */
  stigmergy: StigmergyField;
  /** Contract-Net coordinator orchestrating auctions between agents. */
  contractNet: ContractNetCoordinator;
  /** Structured logger used for auditability. */
  logger: StructuredLogger;
  /** Optional idempotency registry replaying cached coordination results. */
  idempotency?: IdempotencyRegistry;
}

/** Schema validating the payload accepted by the `bb_set` tool. */
export const BbSetInputSchema = z.object({
  key: z.string().min(1, "key must not be empty"),
  value: z.unknown(),
  tags: z.array(z.string().min(1)).max(16).default([]),
  ttl_ms: z.number().int().min(1).max(86_400_000).optional(),
});
export const BbSetInputShape = BbSetInputSchema.shape;

/** Schema validating the payload accepted by the `bb_batch_set` tool. */
export const BbBatchSetInputSchema = z.object({
  entries: z
    .array(
      z
        .object({
          key: z.string().min(1, "key must not be empty"),
          value: z.unknown(),
          tags: z.array(z.string().min(1)).max(16).default([]),
          ttl_ms: z.number().int().min(1).max(86_400_000).optional(),
        })
        .strict(),
    )
    .min(1, "at least one entry must be provided")
    .max(100, "cannot update more than 100 entries at once"),
});
export const BbBatchSetInputShape = BbBatchSetInputSchema.shape;

/** Schema validating the payload accepted by the `bb_get` tool. */
export const BbGetInputSchema = z.object({
  key: z.string().min(1, "key must not be empty"),
});
export const BbGetInputShape = BbGetInputSchema.shape;

/** Schema validating the payload accepted by the `bb_query` tool. */
export const BbQueryInputSchema = z.object({
  keys: z.array(z.string().min(1)).max(64).optional(),
  tags: z.array(z.string().min(1)).max(16).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const BbQueryInputShape = BbQueryInputSchema.shape;

/** Schema validating the payload accepted by the `bb_watch` tool. */
export const BbWatchInputSchema = z.object({
  start_version: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
});
export const BbWatchInputShape = BbWatchInputSchema.shape;

/** Schema validating the payload accepted by the `consensus_vote` tool. */
const ConsensusBallotSchema = z
  .object({
    voter: z.string().min(1, "voter must not be empty"),
    value: z.string().min(1, "value must not be empty"),
  })
  .strict();

const ConsensusVoteBaseSchema = z
  .object({
    votes: z.array(ConsensusBallotSchema).min(1, "at least one vote must be provided"),
    config: ConsensusConfigSchema.optional(),
  })
  .strict();

export const ConsensusVoteInputSchema = ConsensusVoteBaseSchema.superRefine((payload, ctx) => {
    if (payload.config?.mode === "quorum" && typeof payload.config.quorum !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config", "quorum"],
        message: "quorum mode requires the quorum field",
      });
    }
    if (payload.config?.mode === "weighted" && payload.config.quorum !== undefined && payload.config.quorum <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config", "quorum"],
        message: "quorum must be positive when provided",
      });
    }
  });

export type ConsensusVoteInput = z.infer<typeof ConsensusVoteInputSchema>;
export const ConsensusVoteInputShape = ConsensusVoteBaseSchema.shape;

/** Schema validating the payload accepted by the `stig_mark` tool. */
export const StigMarkInputSchema = z.object({
  node_id: z.string().min(1, "node_id must not be empty"),
  type: z.string().min(1, "type must not be empty"),
  intensity: z.number().positive().max(10_000, "intensity must remain bounded"),
});
export const StigMarkInputShape = StigMarkInputSchema.shape;

export const StigBatchInputSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            node_id: z.string().min(1, "node_id must not be empty"),
            type: z.string().min(1, "type must not be empty"),
            intensity: z.number().positive().max(10_000, "intensity must remain bounded"),
          })
          .strict(),
      )
      .min(1, "at least one entry must be provided")
      .max(200, "cannot apply more than 200 entries at once"),
  })
  .strict();
export const StigBatchInputShape = StigBatchInputSchema.shape;

/** Schema validating the payload accepted by the `stig_decay` tool. */
export const StigDecayInputSchema = z.object({
  half_life_ms: z.number().int().positive().max(86_400_000, "half_life_ms too large"),
});
export const StigDecayInputShape = StigDecayInputSchema.shape;

/** Schema validating the payload accepted by the `stig_snapshot` tool. */
export const StigSnapshotInputSchema = z.object({});
export const StigSnapshotInputShape = StigSnapshotInputSchema.shape;

/** Schema validating the payload accepted by the `cnp_announce` tool. */
export const CnpAnnounceInputSchema = z
  .object({
    task_id: z.string().min(1, "task_id must not be empty"),
    payload: z.unknown().optional(),
    tags: z.array(z.string().min(1)).max(32).default([]),
    metadata: z.record(z.unknown()).optional(),
    deadline_ms: z.number().int().positive().max(86_400_000).optional(),
    auto_bid: z.boolean().optional(),
    heuristics: z
      .object({
        prefer_agents: z.array(z.string().min(1)).max(64).optional(),
        agent_bias: z.record(z.number()).optional(),
        busy_penalty: z.number().nonnegative().max(100).optional(),
        preference_bonus: z.number().nonnegative().max(100).optional(),
      })
      .partial()
      .optional(),
    manual_bids: z
      .array(
        z
          .object({
            agent_id: z.string().min(1),
            cost: z.number().nonnegative(),
            metadata: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .strict();
export const CnpAnnounceInputShape = CnpAnnounceInputSchema.shape;

/** Result returned by {@link handleBbSet}. */
export interface BbSetResult extends SerializedBlackboardEntry {}

/** Result returned by {@link handleBbBatchSet}. */
export interface BbBatchSetResult extends Record<string, unknown> {
  entries: SerializedBlackboardEntry[];
}

/** Result returned by {@link handleBbGet}. */
export interface BbGetResult extends Record<string, unknown> {
  entry: SerializedBlackboardEntry;
}

/** Result returned by {@link handleBbQuery}. */
export interface BbQueryResult extends Record<string, unknown> {
  entries: SerializedBlackboardEntry[];
  next_cursor: number | null;
}

/** Result returned by {@link handleBbWatch}. */
export interface BbWatchResult extends Record<string, unknown> {
  events: SerializedBlackboardEvent[];
  next_version: number;
}

interface SerializedBlackboardEntry extends Record<string, unknown> {
  key: string;
  value: unknown;
  tags: string[];
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  version: number;
}

interface SerializedBlackboardEvent extends Record<string, unknown> {
  version: number;
  kind: string;
  key: string;
  timestamp: number;
  reason: string | null;
  entry: SerializedBlackboardEntry | null;
  previous: SerializedBlackboardEntry | null;
}

interface SerializedStigmergyPoint extends Record<string, unknown> {
  node_id: string;
  type: string;
  intensity: number;
  updated_at: number;
}

interface SerializedStigmergyTotal extends Record<string, unknown> {
  node_id: string;
  intensity: number;
  updated_at: number;
}

interface SerializedStigmergyChange extends Record<string, unknown> {
  point: SerializedStigmergyPoint;
  node_total: SerializedStigmergyTotal;
}

/** Result returned by {@link handleStigMark}. */
export interface StigMarkResult extends Record<string, unknown> {
  point: SerializedStigmergyPoint;
  node_total: SerializedStigmergyTotal;
}

/** Result returned by {@link handleStigDecay}. */
export interface StigDecayResult extends Record<string, unknown> {
  changes: SerializedStigmergyChange[];
}

/** Result returned by {@link handleStigBatch}. */
export interface StigBatchResult extends Record<string, unknown> {
  changes: SerializedStigmergyChange[];
}

/** Result returned by {@link handleStigSnapshot}. */
export interface StigSnapshotResult extends Record<string, unknown> {
  generated_at: number;
  points: SerializedStigmergyPoint[];
  totals: SerializedStigmergyTotal[];
}

/** Result returned by {@link handleConsensusVote}. */
export interface ConsensusVoteResult extends Record<string, unknown> {
  mode: ConsensusDecision["mode"];
  outcome: ConsensusDecision["outcome"];
  satisfied: boolean;
  tie: boolean;
  threshold: number | null;
  total_weight: number;
  tally: Record<string, number>;
  votes: number;
}

interface SerializedContractNetBid extends Record<string, unknown> {
  agent_id: string;
  cost: number;
  submitted_at: number;
  kind: string;
  metadata: Record<string, unknown>;
}

interface SerializedContractNetHeuristics extends Record<string, unknown> {
  prefer_agents: string[];
  agent_bias: Record<string, number>;
  busy_penalty: number;
  preference_bonus: number;
}

/** Result returned by {@link handleCnpAnnounce}. */
export interface CnpAnnounceResult extends Record<string, unknown> {
  call_id: string;
  task_id: string;
  payload: unknown;
  metadata: Record<string, unknown>;
  tags: string[];
  status: string;
  announced_at: number;
  deadline_ms: number | null;
  awarded_agent_id: string;
  awarded_cost: number;
  awarded_effective_cost: number;
  bids: SerializedContractNetBid[];
  heuristics: SerializedContractNetHeuristics;
  idempotent: boolean;
  idempotency_key: string | null;
}

/**
 * Stores or updates a key on the blackboard with optional tags and TTL. The
 * returned payload mirrors the current snapshot so clients can cache it.
 */
export function handleBbSet(
  context: CoordinationToolContext,
  input: z.infer<typeof BbSetInputSchema>,
): BbSetResult {
  const snapshot = context.blackboard.set(input.key, input.value, {
    tags: input.tags,
    ttlMs: input.ttl_ms,
  });
  context.logger.info("bb_set", {
    key: snapshot.key,
    version: snapshot.version,
    tags: snapshot.tags,
    ttl_ms: input.ttl_ms ?? null,
  });
  return serialiseEntry(snapshot);
}

/**
 * Atomically applies multiple {@link handleBbSet} style mutations on the
 * blackboard. The helper ensures downstream observers receive a consistent
 * batch even if one of the values cannot be cloned.
 */
export function handleBbBatchSet(
  context: CoordinationToolContext,
  input: z.infer<typeof BbBatchSetInputSchema>,
): BbBatchSetResult {
  const payloads: BlackboardBatchSetInput[] = input.entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    tags: entry.tags,
    ttlMs: entry.ttl_ms,
  }));
  const snapshots = context.blackboard.batchSet(payloads);
  context.logger.info("bb_batch_set", {
    entries: snapshots.length,
    keys: snapshots.map((entry) => entry.key),
  });
  return { entries: snapshots.map(serialiseEntry) };
}

/** Retrieves a single entry when available. */
export function handleBbGet(
  context: CoordinationToolContext,
  input: z.infer<typeof BbGetInputSchema>,
): BbGetResult {
  const snapshot = context.blackboard.get(input.key);
  if (!snapshot) {
    context.logger.warn("bb_get_miss", { key: input.key });
    throw new BlackboardEntryNotFoundError(input.key);
  }
  context.logger.info("bb_get", { key: input.key, hit: 1 });
  return { entry: serialiseEntry(snapshot) };
}

/** Queries the blackboard by keys and/or tags. */
export function handleBbQuery(
  context: CoordinationToolContext,
  input: z.infer<typeof BbQueryInputSchema>,
): BbQueryResult {
  const results = context.blackboard.query({ keys: input.keys, tags: input.tags });
  const limited = results.slice(0, input.limit).map(serialiseEntry);
  context.logger.info("bb_query", {
    keys: input.keys ?? null,
    tags: input.tags ?? null,
    returned: limited.length,
  });
  const cursor = limited.length > 0 ? limited[limited.length - 1].version : null;
  return { entries: limited, next_cursor: cursor };
}

/** Lists history events so clients can resume from the last delivered version. */
export function handleBbWatch(
  context: CoordinationToolContext,
  input: z.infer<typeof BbWatchInputSchema>,
): BbWatchResult {
  const events = context.blackboard.getEventsSince(input.start_version, { limit: input.limit });
  const serialised = events.map(serialiseEvent);
  const nextVersion = serialised.length > 0 ? serialised[serialised.length - 1].version : input.start_version;
  context.logger.info("bb_watch", {
    start_version: input.start_version,
    requested: input.limit,
    delivered: serialised.length,
    next_version: nextVersion,
  });
  return { events: serialised, next_version: nextVersion };
}

function serialiseEntry(snapshot: BlackboardEntrySnapshot): SerializedBlackboardEntry {
  return {
    key: snapshot.key,
    value: snapshot.value,
    tags: snapshot.tags,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
    expires_at: snapshot.expiresAt,
    version: snapshot.version,
  };
}

function serialiseEvent(event: BlackboardEvent): SerializedBlackboardEvent {
  return {
    version: event.version,
    kind: event.kind,
    key: event.key,
    timestamp: event.timestamp,
    reason: event.reason ?? null,
    entry: event.entry ? serialiseEntry(event.entry) : null,
    previous: event.previous ? serialiseEntry(event.previous) : null,
  };
}

/**
 * Deposits pheromones on the stigmergic field and returns the updated point
 * alongside the aggregated node intensity so schedulers can factor the change
 * immediately.
 */
export function handleStigMark(
  context: CoordinationToolContext,
  input: z.infer<typeof StigMarkInputSchema>,
): StigMarkResult {
  const snapshot = context.stigmergy.mark(input.node_id, input.type, input.intensity);
  const total = context.stigmergy.getNodeIntensity(input.node_id) ?? {
    nodeId: input.node_id,
    intensity: snapshot.intensity,
    updatedAt: snapshot.updatedAt,
  };
  context.logger.info("stig_mark", {
    node_id: input.node_id,
    type: snapshot.type,
    intensity: snapshot.intensity,
    node_total: total.intensity,
  });
  return {
    point: serialisePoint(snapshot),
    node_total: serialiseTotal(total),
  };
}

/**
 * Applies exponential decay to the field. The response lists each affected
 * point along with the resulting node totals to help clients update their
 * dashboards.
 */
export function handleStigDecay(
  context: CoordinationToolContext,
  input: z.infer<typeof StigDecayInputSchema>,
): StigDecayResult {
  const changes = context.stigmergy.evaporate(input.half_life_ms);
  context.logger.info("stig_decay", {
    half_life_ms: input.half_life_ms,
    affected: changes.length,
  });
  return {
    changes: changes.map((change) => ({
      point: serialisePoint({
        nodeId: change.nodeId,
        type: change.type ?? "aggregate",
        intensity: change.intensity,
        updatedAt: change.updatedAt,
      }),
      node_total: serialiseTotal({
        nodeId: change.nodeId,
        intensity: change.totalIntensity,
        updatedAt: change.updatedAt,
      }),
    })),
  };
}

/** Applies several pheromone markings atomically. */
export function handleStigBatch(
  context: CoordinationToolContext,
  input: z.infer<typeof StigBatchInputSchema>,
): StigBatchResult {
  const applied = context.stigmergy.batchMark(
    input.entries.map((entry) => ({
      nodeId: entry.node_id,
      type: entry.type,
      intensity: entry.intensity,
    })),
  );
  const serialised = applied.map((change) => ({
    point: serialisePoint(change.point),
    node_total: serialiseTotal(change.nodeTotal),
  }));
  const uniqueNodes = new Set(serialised.map((change) => change.point.node_id));
  context.logger.info("stig_batch", {
    entries: input.entries.length,
    nodes: uniqueNodes.size,
  });
  return { changes: serialised };
}

/** Returns a deterministic snapshot of the stigmergic field. */
export function handleStigSnapshot(
  context: CoordinationToolContext,
  _input: z.infer<typeof StigSnapshotInputSchema>,
): StigSnapshotResult {
  const snapshot = context.stigmergy.fieldSnapshot();
  context.logger.info("stig_snapshot", {
    points: snapshot.points.length,
    totals: snapshot.totals.length,
  });
  return serialiseFieldSnapshot(snapshot);
}

function serialisePoint(snapshot: StigmergyPointSnapshot): SerializedStigmergyPoint {
  return {
    node_id: snapshot.nodeId,
    type: snapshot.type,
    intensity: Number(snapshot.intensity.toFixed(6)),
    updated_at: snapshot.updatedAt,
  };
}

function serialiseTotal(total: StigmergyTotalSnapshot): SerializedStigmergyTotal {
  return {
    node_id: total.nodeId,
    intensity: Number(total.intensity.toFixed(6)),
    updated_at: total.updatedAt,
  };
}

function serialiseFieldSnapshot(snapshot: StigmergyFieldSnapshot): StigSnapshotResult {
  return {
    generated_at: snapshot.generatedAt,
    points: snapshot.points.map(serialisePoint),
    totals: snapshot.totals.map(serialiseTotal),
  };
}

/** Announces a task to the Contract-Net and immediately awards the best bid. */
export function handleCnpAnnounce(
  context: CoordinationToolContext,
  input: z.infer<typeof CnpAnnounceInputSchema>,
): CnpAnnounceResult {
  const execute = (): Omit<CnpAnnounceResult, "idempotent" | "idempotency_key"> => {
    const announcement = context.contractNet.announce({
      taskId: input.task_id,
      payload: input.payload,
      tags: input.tags,
      metadata: input.metadata,
      deadlineMs: input.deadline_ms ?? null,
      autoBid: input.auto_bid,
      heuristics: {
        preferAgents: input.heuristics?.prefer_agents,
        agentBias: input.heuristics?.agent_bias,
        busyPenalty: input.heuristics?.busy_penalty,
        preferenceBonus: input.heuristics?.preference_bonus,
      },
    });

    if (input.manual_bids) {
      for (const bid of input.manual_bids) {
        context.contractNet.bid(announcement.callId, bid.agent_id, bid.cost, {
          metadata: bid.metadata ?? {},
        });
      }
    }

    const decision = context.contractNet.award(announcement.callId);
    const snapshot = context.contractNet.getCall(announcement.callId);
    if (!snapshot) {
      throw new Error(`call ${announcement.callId} disappeared after award`);
    }

    context.logger.info("cnp_announce", {
      call_id: snapshot.callId,
      bids: snapshot.bids.length,
      awarded_agent_id: decision.agentId,
      idempotency_key: input.idempotency_key ?? null,
    });

    return serialiseContractNetResult(snapshot, decision);
  };

  const key = input.idempotency_key ?? null;
  if (context.idempotency && key) {
    const hit = context.idempotency.rememberSync(`cnp_announce:${key}`, execute);
    if (hit.idempotent) {
      const snapshot = hit.value as ReturnType<typeof execute>;
      context.logger.info("cnp_announce_replayed", {
        call_id: snapshot.call_id,
        awarded_agent_id: snapshot.awarded_agent_id,
        idempotency_key: key,
      });
    }
    const snapshot = hit.value as ReturnType<typeof execute>;
    return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key } as CnpAnnounceResult;
  }

  const snapshot = execute();
  return { ...snapshot, idempotent: false, idempotency_key: key } as CnpAnnounceResult;
}

/**
 * Computes a consensus decision from raw ballots. The helper mirrors the
 * consensus logic used in planners so operators can query aggregated votes on
 * demand without triggering a full reduce workflow.
 */
export function handleConsensusVote(
  context: CoordinationToolContext,
  input: ConsensusVoteInput,
): ConsensusVoteResult {
  const votes: ConsensusVote[] = input.votes.map((ballot) => ({
    voter: ballot.voter,
    value: ballot.value,
  }));

  const config = ConsensusConfigSchema.parse(input.config ?? {});
  const baseOptions = {
    weights: config.weights,
    preferValue: config.prefer_value,
    tieBreaker: config.tie_breaker,
  } as const;

  let decision: ConsensusDecision;
  switch (config.mode) {
    case "quorum": {
      const quorumThreshold = config.quorum as number;
      decision = quorum(votes, { ...baseOptions, quorum: quorumThreshold });
      break;
    }
    case "weighted":
      decision = weighted(votes, { ...baseOptions, quorum: config.quorum });
      break;
    default:
      decision = majority(votes, baseOptions);
      break;
  }

  context.logger.info("consensus_vote", {
    mode: decision.mode,
    outcome: decision.outcome,
    satisfied: decision.satisfied,
    votes: votes.length,
    total_weight: decision.totalWeight,
  });

  // Broadcast the computed decision so observers subscribed to the consensus
  // bridge receive a structured update on quorum evaluations triggered via the
  // coordination tool surface.
  publishConsensusEvent({
    kind: "decision",
    source: "consensus_vote",
    mode: decision.mode,
    outcome: decision.outcome,
    satisfied: decision.satisfied,
    tie: decision.tie,
    threshold: decision.threshold ?? null,
    totalWeight: decision.totalWeight,
    tally: decision.tally,
    votes: votes.length,
    metadata: {
      requested_mode: config.mode,
      requested_quorum: config.quorum ?? null,
      weights: config.weights ?? {},
      tie_breaker: config.tie_breaker,
      prefer_value: config.prefer_value ?? null,
    },
  });

  return {
    mode: decision.mode,
    outcome: decision.outcome,
    satisfied: decision.satisfied,
    tie: decision.tie,
    threshold: decision.threshold ?? null,
    total_weight: decision.totalWeight,
    tally: decision.tally,
    votes: votes.length,
  };
}

function serialiseContractNetResult(
  snapshot: ContractNetCallSnapshot,
  decision: ContractNetAwardDecision,
): Omit<CnpAnnounceResult, "idempotent" | "idempotency_key"> {
  return {
    call_id: snapshot.callId,
    task_id: snapshot.taskId,
    payload: snapshot.payload,
    metadata: snapshot.metadata,
    tags: snapshot.tags,
    status: snapshot.status,
    announced_at: snapshot.announcedAt,
    deadline_ms: snapshot.deadlineMs,
    awarded_agent_id: decision.agentId,
    awarded_cost: decision.cost,
    awarded_effective_cost: decision.effectiveCost,
    bids: snapshot.bids.map(serialiseContractNetBid),
    heuristics: serialiseContractNetHeuristics(snapshot),
  };
}

function serialiseContractNetBid(bid: ContractNetBidSnapshot): SerializedContractNetBid {
  return {
    agent_id: bid.agentId,
    cost: bid.cost,
    submitted_at: bid.submittedAt,
    kind: bid.kind,
    metadata: bid.metadata,
  };
}

function serialiseContractNetHeuristics(snapshot: ContractNetCallSnapshot): SerializedContractNetHeuristics {
  return {
    prefer_agents: snapshot.heuristics.preferAgents,
    agent_bias: snapshot.heuristics.agentBias,
    busy_penalty: snapshot.heuristics.busyPenalty,
    preference_bonus: snapshot.heuristics.preferenceBonus,
  };
}
