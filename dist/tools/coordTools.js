import { z } from "zod";
import { BlackboardBatchSetEntryError, } from "../coord/blackboard.js";
import { StigmergyBatchMarkError, buildStigmergySummary, formatPheromoneBoundsTooltip, normalisePheromoneBoundsForTelemetry, } from "../coord/stigmergy.js";
import { ConsensusConfigSchema, majority, publishConsensusEvent, quorum, weighted, } from "../coord/consensus.js";
import { buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { BulkOperationError, buildBulkFailureDetail } from "./bulkError.js";
import { resolveOperationId } from "./operationIds.js";
/**
 * Error raised when a requested blackboard key cannot be found. The dedicated
 * code ensures MCP clients can distinguish between missing entries and actual
 * transport failures.
 */
export class BlackboardEntryNotFoundError extends Error {
    code = "E-BB-NOTFOUND";
    details;
    constructor(key) {
        super(`No blackboard entry found for key ${key}`);
        this.name = "BlackboardEntryNotFoundError";
        this.details = { key };
    }
}
/** Schema validating the payload accepted by the `bb_set` tool. */
export const BbSetInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
    key: z.string().min(1, "key must not be empty"),
    value: z.unknown(),
    tags: z.array(z.string().min(1)).max(16).default([]),
    ttl_ms: z.number().int().min(1).max(86_400_000).optional(),
});
export const BbSetInputShape = BbSetInputSchema.shape;
/** Schema validating the payload accepted by the `bb_batch_set` tool. */
export const BbBatchSetInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
    entries: z
        .array(z
        .object({
        key: z.string().min(1, "key must not be empty"),
        value: z.unknown(),
        tags: z.array(z.string().min(1)).max(16).default([]),
        ttl_ms: z.number().int().min(1).max(86_400_000).optional(),
    })
        .strict())
        .min(1, "at least one entry must be provided")
        .max(100, "cannot update more than 100 entries at once"),
});
export const BbBatchSetInputShape = BbBatchSetInputSchema.shape;
/** Schema validating the payload accepted by the `bb_get` tool. */
export const BbGetInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
    key: z.string().min(1, "key must not be empty"),
});
export const BbGetInputShape = BbGetInputSchema.shape;
/** Schema validating the payload accepted by the `bb_query` tool. */
export const BbQueryInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
    keys: z.array(z.string().min(1)).max(64).optional(),
    tags: z.array(z.string().min(1)).max(16).optional(),
    limit: z.number().int().min(1).max(100).default(25),
});
export const BbQueryInputShape = BbQueryInputSchema.shape;
/** Schema validating the payload accepted by the `bb_watch` tool. */
export const BbWatchInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
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
    op_id: z.string().trim().min(1).optional(),
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
export const ConsensusVoteInputShape = ConsensusVoteBaseSchema.shape;
/** Schema validating the payload accepted by the `stig_mark` tool. */
export const StigMarkInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
    node_id: z.string().min(1, "node_id must not be empty"),
    type: z.string().min(1, "type must not be empty"),
    intensity: z.number().positive().max(10_000, "intensity must remain bounded"),
});
export const StigMarkInputShape = StigMarkInputSchema.shape;
export const StigBatchInputSchema = z
    .object({
    op_id: z.string().trim().min(1).optional(),
    entries: z
        .array(z
        .object({
        node_id: z.string().min(1, "node_id must not be empty"),
        type: z.string().min(1, "type must not be empty"),
        intensity: z.number().positive().max(10_000, "intensity must remain bounded"),
    })
        .strict())
        .min(1, "at least one entry must be provided")
        .max(200, "cannot apply more than 200 entries at once"),
})
    .strict();
export const StigBatchInputShape = StigBatchInputSchema.shape;
/** Schema validating the payload accepted by the `stig_decay` tool. */
export const StigDecayInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
    half_life_ms: z.number().int().positive().max(86_400_000, "half_life_ms too large"),
});
export const StigDecayInputShape = StigDecayInputSchema.shape;
/** Schema validating the payload accepted by the `stig_snapshot` tool. */
export const StigSnapshotInputSchema = z.object({
    op_id: z.string().trim().min(1).optional(),
});
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
        .array(z
        .object({
        agent_id: z.string().min(1),
        cost: z.number().nonnegative(),
        metadata: z.record(z.unknown()).optional(),
    })
        .strict())
        .max(128)
        .optional(),
    idempotency_key: z.string().min(1).optional(),
    run_id: z.string().trim().min(1).optional(),
    op_id: z.string().trim().min(1).optional(),
    job_id: z.string().trim().min(1).optional(),
    graph_id: z.string().trim().min(1).optional(),
    node_id: z.string().trim().min(1).optional(),
    child_id: z.string().trim().min(1).optional(),
})
    .strict();
export const CnpAnnounceInputShape = CnpAnnounceInputSchema.shape;
/** Schema validating the payload accepted by the `cnp_refresh_bounds` tool. */
const CnpPheromoneBoundsSchema = z
    .object({
    min_intensity: z.number(),
    max_intensity: z.number().nullable(),
    normalisation_ceiling: z.number(),
})
    .strict();
export const CnpRefreshBoundsInputSchema = z
    .object({
    op_id: z.string().trim().min(1).optional(),
    call_id: z.string().min(1, "call_id must not be empty"),
    bounds: CnpPheromoneBoundsSchema.optional(),
    refresh_auto_bids: z.boolean().optional(),
    include_new_agents: z.boolean().optional(),
})
    .strict();
export const CnpRefreshBoundsInputShape = CnpRefreshBoundsInputSchema.shape;
/** Schema validating the payload accepted by the `cnp_watcher_telemetry` tool. */
export const CnpWatcherTelemetryInputSchema = z
    .object({
    op_id: z.string().trim().min(1).optional(),
})
    .strict();
export const CnpWatcherTelemetryInputShape = CnpWatcherTelemetryInputSchema.shape;
/**
 * Stores or updates a key on the blackboard with optional tags and TTL. The
 * returned payload mirrors the current snapshot so clients can cache it.
 */
export function handleBbSet(context, input) {
    const opId = resolveOperationId(input.op_id, "bb_set_op");
    const snapshot = context.blackboard.set(input.key, input.value, {
        tags: input.tags,
        ttlMs: input.ttl_ms,
    });
    context.logger.info("bb_set", {
        op_id: opId,
        key: snapshot.key,
        version: snapshot.version,
        tags: snapshot.tags,
        ttl_ms: input.ttl_ms ?? null,
    });
    return { op_id: opId, ...serialiseEntry(snapshot) };
}
/**
 * Atomically applies multiple {@link handleBbSet} style mutations on the
 * blackboard. The helper ensures downstream observers receive a consistent
 * batch even if one of the values cannot be cloned.
 */
export function handleBbBatchSet(context, input) {
    const opId = resolveOperationId(input.op_id, "bb_batch_set_op");
    const payloads = input.entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        tags: entry.tags,
        ttlMs: entry.ttl_ms,
    }));
    try {
        const snapshots = context.blackboard.batchSet(payloads);
        context.logger.info("bb_batch_set", {
            op_id: opId,
            entries: snapshots.length,
            keys: snapshots.map((entry) => entry.key),
        });
        return { op_id: opId, entries: snapshots.map(serialiseEntry) };
    }
    catch (error) {
        if (error instanceof BlackboardBatchSetEntryError) {
            throw new BulkOperationError("blackboard batch aborted", {
                failures: [
                    buildBulkFailureDetail({
                        index: error.index,
                        entry: {
                            key: error.entry.key,
                            tags: Array.isArray(error.entry.tags) && error.entry.tags.length > 0
                                ? [...error.entry.tags]
                                : null,
                        },
                        error: error.cause ?? error,
                        stage: "set",
                    }),
                ],
                rolled_back: true,
            });
        }
        throw error;
    }
}
/** Retrieves a single entry when available. */
export function handleBbGet(context, input) {
    const opId = resolveOperationId(input.op_id, "bb_get_op");
    const snapshot = context.blackboard.get(input.key);
    if (!snapshot) {
        context.logger.warn("bb_get_miss", { key: input.key, op_id: opId });
        throw new BlackboardEntryNotFoundError(input.key);
    }
    context.logger.info("bb_get", { key: input.key, hit: 1, op_id: opId });
    return { op_id: opId, entry: serialiseEntry(snapshot) };
}
/** Queries the blackboard by keys and/or tags. */
export function handleBbQuery(context, input) {
    const opId = resolveOperationId(input.op_id, "bb_query_op");
    const results = context.blackboard.query({ keys: input.keys, tags: input.tags });
    const limited = results.slice(0, input.limit).map(serialiseEntry);
    context.logger.info("bb_query", {
        op_id: opId,
        keys: input.keys ?? null,
        tags: input.tags ?? null,
        returned: limited.length,
    });
    const cursor = limited.length > 0 ? limited[limited.length - 1].version : null;
    return { op_id: opId, entries: limited, next_cursor: cursor };
}
/** Lists history events so clients can resume from the last delivered version. */
export function handleBbWatch(context, input) {
    const opId = resolveOperationId(input.op_id, "bb_watch_op");
    const events = context.blackboard.getEventsSince(input.start_version, { limit: input.limit });
    const serialised = events.map(serialiseEvent);
    const nextVersion = serialised.length > 0 ? serialised[serialised.length - 1].version : input.start_version;
    context.logger.info("bb_watch", {
        op_id: opId,
        start_version: input.start_version,
        requested: input.limit,
        delivered: serialised.length,
        next_version: nextVersion,
    });
    return { op_id: opId, events: serialised, next_version: nextVersion };
}
function serialiseEntry(snapshot) {
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
function serialiseEvent(event) {
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
export function handleStigMark(context, input) {
    const opId = resolveOperationId(input.op_id, "stig_mark_op");
    const snapshot = context.stigmergy.mark(input.node_id, input.type, input.intensity);
    const total = context.stigmergy.getNodeIntensity(input.node_id) ?? {
        nodeId: input.node_id,
        intensity: snapshot.intensity,
        updatedAt: snapshot.updatedAt,
    };
    context.logger.info("stig_mark", {
        op_id: opId,
        node_id: input.node_id,
        type: snapshot.type,
        intensity: snapshot.intensity,
        node_total: total.intensity,
    });
    return {
        op_id: opId,
        point: serialisePoint(snapshot),
        node_total: serialiseTotal(total),
    };
}
/**
 * Applies exponential decay to the field. The response lists each affected
 * point along with the resulting node totals to help clients update their
 * dashboards.
 */
export function handleStigDecay(context, input) {
    const opId = resolveOperationId(input.op_id, "stig_decay_op");
    const changes = context.stigmergy.evaporate(input.half_life_ms);
    context.logger.info("stig_decay", {
        op_id: opId,
        half_life_ms: input.half_life_ms,
        affected: changes.length,
    });
    return {
        op_id: opId,
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
export function handleStigBatch(context, input) {
    const opId = resolveOperationId(input.op_id, "stig_batch_op");
    try {
        const applied = context.stigmergy.batchMark(input.entries.map((entry) => ({
            nodeId: entry.node_id,
            type: entry.type,
            intensity: entry.intensity,
        })));
        const serialised = applied.map((change) => ({
            point: serialisePoint(change.point),
            node_total: serialiseTotal(change.nodeTotal),
        }));
        const uniqueNodes = new Set(serialised.map((change) => change.point.node_id));
        context.logger.info("stig_batch", {
            op_id: opId,
            entries: input.entries.length,
            nodes: uniqueNodes.size,
        });
        return { op_id: opId, changes: serialised };
    }
    catch (error) {
        if (error instanceof StigmergyBatchMarkError) {
            throw new BulkOperationError("stigmergy batch aborted", {
                failures: [
                    buildBulkFailureDetail({
                        index: error.index,
                        entry: {
                            node_id: error.entry.nodeId,
                            type: error.entry.type,
                            intensity: error.entry.intensity,
                        },
                        error: error.cause ?? error,
                        stage: "mark",
                    }),
                ],
                rolled_back: true,
            });
        }
        throw error;
    }
}
/** Returns a deterministic snapshot of the stigmergic field. */
export function handleStigSnapshot(context, input) {
    const opId = resolveOperationId(input.op_id, "stig_snapshot_op");
    const snapshot = context.stigmergy.fieldSnapshot();
    const heatmap = context.stigmergy.heatmapSnapshot();
    const bounds = normalisePheromoneBoundsForTelemetry(context.stigmergy.getIntensityBounds());
    const summary = buildStigmergySummary(bounds);
    const boundsTooltip = formatPheromoneBoundsTooltip(bounds);
    context.logger.info("stig_snapshot", {
        op_id: opId,
        points: snapshot.points.length,
        totals: snapshot.totals.length,
        heatmap_cells: heatmap.cells.length,
    });
    return serialiseFieldSnapshot(snapshot, heatmap, summary, boundsTooltip, opId);
}
function serialisePoint(snapshot) {
    return {
        node_id: snapshot.nodeId,
        type: snapshot.type,
        intensity: Number(snapshot.intensity.toFixed(6)),
        updated_at: snapshot.updatedAt,
    };
}
function serialiseTotal(total) {
    return {
        node_id: total.nodeId,
        intensity: Number(total.intensity.toFixed(6)),
        updated_at: total.updatedAt,
    };
}
function serialiseFieldSnapshot(snapshot, heatmap, summary, boundsTooltip, opId) {
    return {
        op_id: opId,
        generated_at: snapshot.generatedAt,
        points: snapshot.points.map(serialisePoint),
        totals: snapshot.totals.map(serialiseTotal),
        heatmap: serialiseHeatmap(heatmap, summary.bounds, boundsTooltip),
        pheromone_bounds: summary.bounds,
        summary: serialiseSummary(summary, boundsTooltip),
    };
}
function serialiseHeatmap(heatmap, bounds, tooltip) {
    return {
        min_intensity: Number(heatmap.minIntensity.toFixed(6)),
        max_intensity: Number(heatmap.maxIntensity.toFixed(6)),
        cells: heatmap.cells.map(serialiseHeatmapCell),
        bounds,
        bounds_tooltip: tooltip,
    };
}
function serialiseSummary(summary, tooltip) {
    return {
        bounds: summary.bounds,
        rows: summary.rows.map((row) => ({
            label: row.label,
            value: row.value,
            tooltip: row.tooltip ?? null,
        })),
        tooltip,
    };
}
function serialiseHeatmapCell(cell) {
    return {
        node_id: cell.nodeId,
        total_intensity: Number(cell.totalIntensity.toFixed(6)),
        normalised: Number(cell.normalised.toFixed(6)),
        updated_at: cell.updatedAt,
        points: cell.points.map(serialiseHeatmapPoint),
    };
}
function serialiseHeatmapPoint(point) {
    return {
        type: point.type,
        intensity: Number(point.intensity.toFixed(6)),
        normalised: Number(point.normalised.toFixed(6)),
        updated_at: point.updatedAt,
    };
}
/** Announces a task to the Contract-Net and immediately awards the best bid. */
export function handleCnpAnnounce(context, input) {
    const opId = resolveOperationId(input.op_id, "cnp_announce_op");
    const execute = () => {
        // Capture the current pheromone bounds before announcing the task so the
        // resulting snapshot and events mirror the scheduler telemetry. Consumers
        // (autoscaler UI, Contract-Net heuristics) rely on the ceiling to scale
        // their decisions consistently even when the stigmergic field evolves
        // between retries.
        const pheromoneBounds = normalisePheromoneBoundsForTelemetry(context.stigmergy.getIntensityBounds());
        // Propagate orchestration identifiers so downstream event streams carry
        // run/op hints without relying on out-of-band resolvers.
        const correlation = {
            runId: input.run_id ?? null,
            opId,
            jobId: input.job_id ?? null,
            graphId: input.graph_id ?? null,
            nodeId: input.node_id ?? null,
            childId: input.child_id ?? null,
        };
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
            correlation,
            pheromoneBounds,
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
            op_id: opId,
            call_id: snapshot.callId,
            bids: snapshot.bids.length,
            awarded_agent_id: decision.agentId,
            idempotency_key: input.idempotency_key ?? null,
        });
        return serialiseContractNetResult(snapshot, decision, opId);
    };
    const key = input.idempotency_key ?? null;
    if (context.idempotency && key) {
        const { op_id: _omitOpId, idempotency_key: _omitKey, ...fingerprint } = input;
        const cacheKey = buildIdempotencyCacheKey("cnp_announce", key, fingerprint);
        const hit = context.idempotency.rememberSync(cacheKey, execute);
        if (hit.idempotent) {
            const snapshot = hit.value;
            context.logger.info("cnp_announce_replayed", {
                op_id: snapshot.op_id,
                call_id: snapshot.call_id,
                awarded_agent_id: snapshot.awarded_agent_id,
                idempotency_key: key,
            });
        }
        const snapshot = hit.value;
        return { ...snapshot, idempotent: hit.idempotent, idempotency_key: key };
    }
    const snapshot = execute();
    return { ...snapshot, idempotent: false, idempotency_key: key };
}
/**
 * Refreshes the pheromone bounds captured for an existing Contract-Net call.
 * When callers omit explicit bounds, the helper samples the current
 * stigmergic field so the coordinator stays aligned with the latest ceiling
 * before reissuing heuristic bids.
 */
export function handleCnpRefreshBounds(context, input) {
    const parsed = CnpRefreshBoundsInputSchema.parse(input);
    const opId = resolveOperationId(parsed.op_id, "cnp_refresh_bounds_op");
    const requestedBounds = parsed.bounds
        ? {
            min_intensity: parsed.bounds.min_intensity,
            max_intensity: parsed.bounds.max_intensity ?? null,
            normalisation_ceiling: parsed.bounds.normalisation_ceiling,
        }
        : normalisePheromoneBoundsForTelemetry(context.stigmergy.getIntensityBounds());
    const options = {
        refreshAutoBids: parsed.refresh_auto_bids,
        includeNewAgents: parsed.include_new_agents,
    };
    const snapshot = context.contractNet.updateCallPheromoneBounds(parsed.call_id, requestedBounds ?? null, options);
    const refreshRequested = parsed.refresh_auto_bids !== false;
    const includeNewAgents = parsed.include_new_agents ?? true;
    const result = {
        op_id: opId,
        call_id: snapshot.callId,
        auto_bid_refreshed: snapshot.autoBidRefreshed,
        refreshed_agents: [...snapshot.refreshedAgents],
        pheromone_bounds: snapshot.pheromoneBounds,
        refresh: {
            requested: refreshRequested,
            include_new_agents: includeNewAgents,
        },
    };
    context.logger.info("cnp_refresh_bounds", {
        op_id: opId,
        call_id: result.call_id,
        auto_bid_refreshed: result.auto_bid_refreshed,
        refreshed_agents: result.refreshed_agents.length,
        refresh_requested: result.refresh.requested,
        include_new_agents: result.refresh.include_new_agents,
    });
    return result;
}
/**
 * Exposes the latest telemetry collected by the Contract-Net bounds watcher so
 * MCP clients can observe coalescing efficiency and refresh cadence.
 */
export function handleCnpWatcherTelemetry(context, input) {
    const parsed = CnpWatcherTelemetryInputSchema.parse(input);
    const opId = resolveOperationId(parsed.op_id, "cnp_watcher_telemetry_op");
    const recorder = context.contractNetWatcherTelemetry;
    if (!recorder) {
        return {
            op_id: opId,
            telemetry_enabled: false,
            emissions: 0,
            last_emitted_at_ms: null,
            last_emitted_at_iso: null,
            last_snapshot: null,
        };
    }
    const state = recorder.snapshot();
    const lastSnapshot = state.lastSnapshot
        ? {
            reason: state.lastSnapshot.reason,
            received_updates: state.lastSnapshot.receivedUpdates,
            coalesced_updates: state.lastSnapshot.coalescedUpdates,
            skipped_refreshes: state.lastSnapshot.skippedRefreshes,
            applied_refreshes: state.lastSnapshot.appliedRefreshes,
            flushes: state.lastSnapshot.flushes,
            last_bounds: state.lastSnapshot.lastBounds
                ? { ...state.lastSnapshot.lastBounds }
                : null,
        }
        : null;
    const lastEmittedAtIso = state.lastEmittedAtMs === null ? null : new Date(state.lastEmittedAtMs).toISOString();
    return {
        op_id: opId,
        telemetry_enabled: true,
        emissions: state.emissions,
        last_emitted_at_ms: state.lastEmittedAtMs,
        last_emitted_at_iso: lastEmittedAtIso,
        last_snapshot: lastSnapshot,
    };
}
/**
 * Computes a consensus decision from raw ballots. The helper mirrors the
 * consensus logic used in planners so operators can query aggregated votes on
 * demand without triggering a full reduce workflow.
 */
export function handleConsensusVote(context, input) {
    const opId = resolveOperationId(input.op_id, "consensus_vote_op");
    const votes = input.votes.map((ballot) => ({
        voter: ballot.voter,
        value: ballot.value,
    }));
    const config = ConsensusConfigSchema.parse(input.config ?? {});
    const baseOptions = {
        weights: config.weights,
        preferValue: config.prefer_value,
        tieBreaker: config.tie_breaker,
    };
    let decision;
    switch (config.mode) {
        case "quorum": {
            const quorumThreshold = config.quorum;
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
        op_id: opId,
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
        opId,
        metadata: {
            requested_mode: config.mode,
            requested_quorum: config.quorum ?? null,
            weights: config.weights ?? {},
            tie_breaker: config.tie_breaker,
            prefer_value: config.prefer_value ?? null,
        },
    });
    return {
        op_id: opId,
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
function serialiseContractNetResult(snapshot, decision, opId) {
    return {
        op_id: opId,
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
        pheromone_bounds: snapshot.pheromoneBounds,
        auto_bid_enabled: snapshot.autoBidEnabled,
        correlation: snapshot.correlation,
    };
}
function serialiseContractNetBid(bid) {
    return {
        agent_id: bid.agentId,
        cost: bid.cost,
        submitted_at: bid.submittedAt,
        kind: bid.kind,
        metadata: bid.metadata,
    };
}
function serialiseContractNetHeuristics(snapshot) {
    return {
        prefer_agents: snapshot.heuristics.preferAgents,
        agent_bias: snapshot.heuristics.agentBias,
        busy_penalty: snapshot.heuristics.busyPenalty,
        preference_bonus: snapshot.heuristics.preferenceBonus,
    };
}
//# sourceMappingURL=coordTools.js.map