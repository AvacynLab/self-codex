import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/**
 * Error raised when the Contract-Net coordinator cannot award a task because no
 * bids were submitted. The orchestrator surfaces the code so callers can react
 * (e.g. retry with relaxed constraints) rather than handling a generic error.
 */
export class ContractNetNoBidsError extends Error {
    code = "E-CNP-NO-BIDS";
    details;
    constructor(callId) {
        super(`contract-net call ${callId} has no bids`);
        this.name = "ContractNetNoBidsError";
        this.details = { callId };
    }
}
/** Internal event channel identifier used by the coordinator emitter. */
const CONTRACT_NET_EVENT = "event";
/**
 * Deterministic implementation of a Contract-Net coordinator. The class keeps
 * track of registered agents, allows callers to announce new tasks, records
 * bids (manual or heuristic) and deterministically awards the task to the best
 * suited agent according to the lowest effective cost.
 */
export class ContractNetCoordinator {
    agents = new Map();
    activeAssignments = new Map();
    calls = new Map();
    now;
    defaultBusyPenalty;
    /** Event emitter broadcasting lifecycle changes to observers. */
    emitter = new EventEmitter();
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.defaultBusyPenalty = normalizeBusyPenalty(options.defaultBusyPenalty);
    }
    /**
     * Subscribes to coordinator lifecycle events. The disposer detaches the
     * listener which keeps tests deterministic and prevents leaks when
     * orchestrators shut down.
     */
    observe(listener) {
        this.emitter.on(CONTRACT_NET_EVENT, listener);
        return () => {
            this.emitter.off(CONTRACT_NET_EVENT, listener);
        };
    }
    /** Lists the registered agents. */
    listAgents() {
        return Array.from(this.agents.values()).map((agent) => this.snapshotAgent(agent));
    }
    /**
     * Lists every call that is still open for bidding. Snapshots are returned in
     * announcement order so watchdogs can deterministically refresh bounds.
     */
    listOpenCalls() {
        return Array.from(this.calls.values())
            .filter((call) => call.status === "open")
            .sort((a, b) => (a.announcedAt === b.announcedAt ? a.callId.localeCompare(b.callId) : a.announcedAt - b.announcedAt))
            .map((call) => this.snapshotCall(call));
    }
    /** Retrieves a single agent snapshot when present. */
    getAgent(agentId) {
        const agent = this.agents.get(agentId);
        return agent ? this.snapshotAgent(agent) : undefined;
    }
    /** Registers (or updates) an agent profile so it can participate in auctions. */
    registerAgent(agentId, options = {}) {
        const existing = this.agents.get(agentId);
        const profile = {
            agentId,
            baseCost: normalizeBaseCost(options.baseCost ?? existing?.baseCost ?? 100),
            reliability: normalizeReliability(options.reliability ?? existing?.reliability ?? 1),
            tags: normaliseTags(options.tags ?? existing?.tags ?? []),
            metadata: structuredClone(options.metadata ?? existing?.metadata ?? {}),
            registeredAt: existing?.registeredAt ?? this.now(),
        };
        this.agents.set(agentId, profile);
        if (!this.activeAssignments.has(agentId)) {
            this.activeAssignments.set(agentId, existing?.agentId === agentId ? this.activeAssignments.get(agentId) ?? 0 : 0);
        }
        const snapshot = this.snapshotAgent(profile);
        this.emitEvent({
            kind: "agent_registered",
            at: this.now(),
            agent: snapshot,
            updated: existing !== undefined,
        });
        return snapshot;
    }
    /** Removes an agent from the coordinator. Active assignments are preserved. */
    unregisterAgent(agentId) {
        const existed = this.agents.delete(agentId);
        if (!existed) {
            return false;
        }
        this.emitEvent({
            kind: "agent_unregistered",
            at: this.now(),
            agentId,
            remainingAssignments: this.activeAssignments.get(agentId) ?? 0,
        });
        return true;
    }
    /** Announces a new task and optionally emits heuristic bids for registered agents. */
    announce(announcement) {
        if (!announcement.taskId || announcement.taskId.trim().length === 0) {
            throw new Error("taskId must not be empty");
        }
        const callId = `${announcement.taskId}:${randomUUID()}`;
        const heuristics = normaliseHeuristics(announcement.heuristics, this.defaultBusyPenalty);
        const correlation = normaliseCorrelation(announcement.correlation);
        const call = {
            callId,
            taskId: announcement.taskId,
            payload: structuredClone(announcement.payload ?? null),
            tags: normaliseTags(announcement.tags ?? []),
            metadata: structuredClone(announcement.metadata ?? {}),
            deadlineMs: normalizeDeadline(announcement.deadlineMs ?? null),
            heuristics,
            pheromoneBounds: clonePheromoneBounds(announcement.pheromoneBounds ?? null),
            autoBidEnabled: announcement.autoBid !== false,
            status: "open",
            announcedAt: this.now(),
            awardedBid: null,
            awardedAt: null,
            bids: new Map(),
            correlation,
            lastRefresh: {
                requested: false,
                includeNewAgents: true,
                autoBidRefreshed: false,
                refreshedAgents: [],
            },
        };
        this.calls.set(callId, call);
        if (call.autoBidEnabled) {
            const { refreshedAgents } = this.refreshHeuristicBids(call, {
                reason: "auto",
                includeNewAgents: true,
            });
            call.lastRefresh = {
                requested: true,
                includeNewAgents: true,
                autoBidRefreshed: refreshedAgents.length > 0,
                refreshedAgents,
            };
        }
        const snapshot = this.snapshotCall(call);
        this.emitEvent({
            kind: "call_announced",
            at: call.announcedAt,
            call: snapshot,
            correlation,
        });
        return snapshot;
    }
    /** Returns the snapshot of a call when present. */
    getCall(callId) {
        const call = this.calls.get(callId);
        return call ? this.snapshotCall(call) : undefined;
    }
    /** Places or updates a bid for an agent. */
    bid(callId, agentId, cost, options = {}) {
        const call = this.requireCall(callId);
        if (call.status !== "open") {
            throw new Error(`call ${callId} is not open for bidding`);
        }
        if (!this.agents.has(agentId)) {
            throw new Error(`agent ${agentId} is not registered`);
        }
        this.recordBid(call, agentId, normalizeCost(cost), structuredClone(options.metadata ?? {}), "manual");
        return this.snapshotCall(call);
    }
    /**
     * Updates the pheromone bounds captured for a call and, when auto-bids are
     * enabled, reissues heuristic bids so their timestamps and metadata reflect
     * the latest stigmergic pressure.
     */
    updateCallPheromoneBounds(callId, bounds, options = {}) {
        const call = this.requireCall(callId);
        if (call.status !== "open") {
            throw new Error(`call ${callId} is not open for updates`);
        }
        call.pheromoneBounds = clonePheromoneBounds(bounds ?? null);
        const refreshRequested = call.autoBidEnabled && options.refreshAutoBids !== false;
        const includeNewAgents = options.includeNewAgents ?? true;
        let refreshedAgents = [];
        if (refreshRequested) {
            const { refreshedAgents: refreshed } = this.refreshHeuristicBids(call, {
                reason: "auto_refresh",
                includeNewAgents,
            });
            refreshedAgents = [...refreshed];
        }
        const autoBidRefreshed = refreshRequested && refreshedAgents.length > 0;
        call.lastRefresh = {
            requested: refreshRequested,
            includeNewAgents,
            autoBidRefreshed,
            refreshedAgents: [...refreshedAgents],
        };
        const snapshot = this.snapshotCall(call);
        const emittedAt = this.now();
        this.emitEvent({
            kind: "call_bounds_updated",
            at: emittedAt,
            call: snapshot,
            bounds: snapshot.pheromoneBounds,
            refresh: {
                requested: refreshRequested,
                includeNewAgents,
                autoBidRefreshed,
                refreshedAgents: [...refreshedAgents],
            },
            correlation: call.correlation,
        });
        return snapshot;
    }
    /**
     * Awards the provided call to the best candidate. When an agent identifier is
     * supplied the method validates that the agent submitted a bid and marks the
     * award accordingly.
     */
    award(callId, preferredAgentId) {
        const call = this.requireCall(callId);
        if (call.status === "completed") {
            if (!call.awardedBid) {
                throw new Error(`call ${callId} has already been completed without award`);
            }
            return this.buildDecision(call, call.awardedBid);
        }
        if (call.awardedBid) {
            if (preferredAgentId && call.awardedBid.agentId !== preferredAgentId) {
                throw new Error(`call ${callId} already awarded to ${call.awardedBid.agentId}`);
            }
            return this.buildDecision(call, call.awardedBid);
        }
        const bid = preferredAgentId
            ? call.bids.get(preferredAgentId) ?? (() => {
                throw new Error(`agent ${preferredAgentId} has not submitted a bid for ${callId}`);
            })()
            : this.selectBestBid(call);
        call.awardedBid = bid;
        call.status = "awarded";
        call.awardedAt = this.now();
        this.incrementAssignments(bid.agentId);
        const decision = this.buildDecision(call, bid);
        this.emitEvent({
            kind: "call_awarded",
            at: call.awardedAt,
            call: this.snapshotCall(call),
            decision,
            correlation: call.correlation,
        });
        return decision;
    }
    /** Marks a previously awarded call as completed, releasing the assignment. */
    complete(callId) {
        const call = this.requireCall(callId);
        if (!call.awardedBid) {
            throw new Error(`call ${callId} has not been awarded yet`);
        }
        if (call.status === "completed") {
            return this.snapshotCall(call);
        }
        call.status = "completed";
        this.decrementAssignments(call.awardedBid.agentId);
        const snapshot = this.snapshotCall(call);
        this.emitEvent({
            kind: "call_completed",
            at: this.now(),
            call: snapshot,
            correlation: call.correlation,
        });
        return snapshot;
    }
    /** Internal helper that snapshots an agent profile. */
    snapshotAgent(agent) {
        return {
            agentId: agent.agentId,
            baseCost: agent.baseCost,
            reliability: agent.reliability,
            tags: [...agent.tags],
            metadata: structuredClone(agent.metadata),
            activeAssignments: this.activeAssignments.get(agent.agentId) ?? 0,
            registeredAt: agent.registeredAt,
        };
    }
    /** Internal helper that snapshots a call state. */
    snapshotCall(call) {
        return {
            callId: call.callId,
            taskId: call.taskId,
            payload: structuredClone(call.payload),
            tags: [...call.tags],
            metadata: structuredClone(call.metadata),
            deadlineMs: call.deadlineMs,
            heuristics: {
                preferAgents: [...call.heuristics.preferAgents],
                agentBias: Object.fromEntries(call.heuristics.agentBias.entries()),
                busyPenalty: call.heuristics.busyPenalty,
                preferenceBonus: call.heuristics.preferenceBonus,
            },
            pheromoneBounds: clonePheromoneBounds(call.pheromoneBounds),
            autoBidEnabled: call.autoBidEnabled,
            status: call.status,
            announcedAt: call.announcedAt,
            awardedAgentId: call.awardedBid?.agentId ?? null,
            awardedAt: call.awardedAt,
            bids: Array.from(call.bids.values())
                .sort((a, b) => (a.submittedAt === b.submittedAt ? a.agentId.localeCompare(b.agentId) : a.submittedAt - b.submittedAt))
                .map((bid) => ({
                agentId: bid.agentId,
                cost: bid.cost,
                submittedAt: bid.submittedAt,
                metadata: structuredClone(bid.metadata),
                kind: bid.kind,
            })),
            correlation: cloneCorrelation(call.correlation),
            refreshedAgents: [...call.lastRefresh.refreshedAgents],
            autoBidRefreshed: call.lastRefresh.autoBidRefreshed,
        };
    }
    /** Serialises an internal bid representation for observers. */
    snapshotBid(bid) {
        return {
            agentId: bid.agentId,
            cost: bid.cost,
            submittedAt: bid.submittedAt,
            metadata: structuredClone(bid.metadata),
            kind: bid.kind,
        };
    }
    requireCall(callId) {
        const call = this.calls.get(callId);
        if (!call) {
            throw new Error(`call ${callId} does not exist`);
        }
        return call;
    }
    recordBid(call, agentId, cost, metadata, kind) {
        const previous = call.bids.get(agentId) ?? null;
        const bid = {
            agentId,
            cost,
            submittedAt: this.now(),
            metadata,
            kind,
        };
        call.bids.set(agentId, bid);
        this.emitEvent({
            kind: "bid_recorded",
            at: bid.submittedAt,
            callId: call.callId,
            agentId,
            bid: this.snapshotBid(bid),
            previousKind: previous?.kind ?? null,
            correlation: call.correlation,
        });
    }
    selectBestBid(call) {
        if (call.bids.size === 0) {
            throw new ContractNetNoBidsError(call.callId);
        }
        let winner = null;
        let winnerScore = Number.POSITIVE_INFINITY;
        for (const bid of call.bids.values()) {
            const score = this.computeEffectiveCost(call, bid);
            if (winner === null) {
                winner = bid;
                winnerScore = score;
                continue;
            }
            if (score < winnerScore) {
                winner = bid;
                winnerScore = score;
                continue;
            }
            if (score === winnerScore && this.breakTie(call, bid, winner)) {
                winner = bid;
                winnerScore = score;
            }
        }
        return winner ?? (() => {
            throw new ContractNetNoBidsError(call.callId);
        })();
    }
    computeEffectiveCost(call, bid) {
        const busy = this.activeAssignments.get(bid.agentId) ?? 0;
        const pheromonePressure = computePheromonePressure(call.pheromoneBounds);
        const busyPenalty = call.heuristics.busyPenalty * busy * pheromonePressure;
        const preferenceBoost = call.heuristics.preferAgents.includes(bid.agentId)
            ? call.heuristics.preferenceBonus
            : 0;
        const bias = call.heuristics.agentBias.get(bid.agentId) ?? 0;
        return bid.cost + busyPenalty - preferenceBoost - bias;
    }
    breakTie(call, challenger, incumbent) {
        const incumbentBusy = this.activeAssignments.get(incumbent.agentId) ?? 0;
        const challengerBusy = this.activeAssignments.get(challenger.agentId) ?? 0;
        if (challengerBusy < incumbentBusy) {
            return true;
        }
        if (challengerBusy > incumbentBusy) {
            return false;
        }
        if (challenger.submittedAt < incumbent.submittedAt) {
            return true;
        }
        if (challenger.submittedAt > incumbent.submittedAt) {
            return false;
        }
        return challenger.agentId.localeCompare(incumbent.agentId) < 0;
    }
    incrementAssignments(agentId) {
        const current = this.activeAssignments.get(agentId) ?? 0;
        this.activeAssignments.set(agentId, current + 1);
    }
    decrementAssignments(agentId) {
        const current = this.activeAssignments.get(agentId) ?? 0;
        this.activeAssignments.set(agentId, Math.max(0, current - 1));
    }
    buildDecision(call, bid) {
        return {
            callId: call.callId,
            agentId: bid.agentId,
            cost: bid.cost,
            effectiveCost: this.computeEffectiveCost(call, bid),
            awardedAt: call.awardedAt ?? this.now(),
            bids: this.snapshotCall(call).bids,
        };
    }
    /** Emits a lifecycle event to subscribed observers. */
    emitEvent(event) {
        this.emitter.emit(CONTRACT_NET_EVENT, event);
    }
    /**
     * Reissues heuristic bids for the provided call. The helper ensures manual
     * submissions remain untouched while updating heuristic metadata so observers
     * can correlate bids with the current pheromone pressure.
     */
    refreshHeuristicBids(call, options) {
        const pheromonePressure = computePheromonePressure(call.pheromoneBounds);
        const refreshedAgents = [];
        for (const agent of this.agents.values()) {
            const existing = call.bids.get(agent.agentId) ?? null;
            if (existing?.kind === "manual") {
                continue;
            }
            if (!existing && !options.includeNewAgents) {
                continue;
            }
            const metadata = {
                reason: options.reason,
                pheromone_pressure: pheromonePressure,
            };
            const cost = computeHeuristicCost(agent);
            this.recordBid(call, agent.agentId, cost, metadata, "heuristic");
            refreshedAgents.push(agent.agentId);
        }
        refreshedAgents.sort((a, b) => a.localeCompare(b));
        return { refreshedAgents };
    }
}
/**
 * Computes a multiplicative pressure factor derived from the captured
 * pheromone bounds. Busy penalties are scaled by this factor so auctions become
 * increasingly sensitive to saturated stigmergic fields while remaining stable
 * when the load is low or the bounds are missing.
 */
export function computePheromonePressure(bounds) {
    if (!bounds) {
        return 1;
    }
    const observed = Math.max(bounds.normalisation_ceiling - bounds.min_intensity, 0);
    if (observed <= 0) {
        return 1;
    }
    const max = bounds.max_intensity;
    if (max !== null && Number.isFinite(max)) {
        const span = Math.max(max - bounds.min_intensity, 0);
        if (span > 0) {
            const ratio = Math.min(observed / span, 1);
            return 1 + ratio;
        }
    }
    return 1 + Math.log1p(observed);
}
function normalizeBaseCost(cost) {
    if (!Number.isFinite(cost) || cost <= 0) {
        return 100;
    }
    return Number(cost);
}
function normalizeReliability(reliability) {
    if (!Number.isFinite(reliability) || reliability <= 0) {
        return 0.5;
    }
    return Math.max(0.1, Math.min(1, Number(reliability)));
}
function normaliseTags(tags) {
    return Array.from(new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))).sort();
}
function normaliseOptionalId(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function normaliseCorrelation(context) {
    if (!context) {
        return null;
    }
    const resolved = {
        runId: normaliseOptionalId(context.runId ?? null),
        opId: normaliseOptionalId(context.opId ?? null),
        jobId: normaliseOptionalId(context.jobId ?? null),
        graphId: normaliseOptionalId(context.graphId ?? null),
        nodeId: normaliseOptionalId(context.nodeId ?? null),
        childId: normaliseOptionalId(context.childId ?? null),
    };
    if (resolved.runId === null &&
        resolved.opId === null &&
        resolved.jobId === null &&
        resolved.graphId === null &&
        resolved.nodeId === null &&
        resolved.childId === null) {
        return null;
    }
    return resolved;
}
function cloneCorrelation(correlation) {
    if (!correlation) {
        return null;
    }
    return {
        runId: correlation.runId ?? null,
        opId: correlation.opId ?? null,
        jobId: correlation.jobId ?? null,
        graphId: correlation.graphId ?? null,
        nodeId: correlation.nodeId ?? null,
        childId: correlation.childId ?? null,
    };
}
function clonePheromoneBounds(bounds) {
    if (!bounds) {
        return null;
    }
    return {
        min_intensity: bounds.min_intensity,
        max_intensity: bounds.max_intensity,
        normalisation_ceiling: bounds.normalisation_ceiling,
    };
}
function normalizeDeadline(deadline) {
    if (deadline === null) {
        return null;
    }
    if (!Number.isFinite(deadline) || deadline <= 0) {
        return null;
    }
    return Math.floor(deadline);
}
function normaliseHeuristics(heuristics, defaultBusyPenalty) {
    const preferAgents = heuristics?.preferAgents ? [...new Set(heuristics.preferAgents.filter((id) => id.trim().length > 0))] : [];
    const agentBiasEntries = heuristics?.agentBias
        ? Object.entries(heuristics.agentBias).filter(([, value]) => Number.isFinite(value))
        : [];
    return {
        preferAgents,
        agentBias: new Map(agentBiasEntries.map(([id, value]) => [id, Number(value)])),
        busyPenalty: normalizeBusyPenalty(heuristics?.busyPenalty ?? defaultBusyPenalty),
        preferenceBonus: normalizePreferenceBonus(heuristics?.preferenceBonus ?? 1),
    };
}
function normalizeBusyPenalty(value) {
    if (!Number.isFinite(value) || value === undefined) {
        return 1;
    }
    return Math.max(0, Number(value));
}
function normalizePreferenceBonus(value) {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.max(0, Number(value));
}
function computeHeuristicCost(agent) {
    const reliability = agent.reliability <= 0 ? 0.1 : agent.reliability;
    const adjusted = agent.baseCost / reliability;
    return Number.isFinite(adjusted) && adjusted > 0 ? adjusted : agent.baseCost;
}
function normalizeCost(cost) {
    if (!Number.isFinite(cost) || cost < 0) {
        throw new Error("cost must be a non-negative finite number");
    }
    return Number(cost);
}
//# sourceMappingURL=contractNet.js.map