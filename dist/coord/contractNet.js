import { randomUUID } from "node:crypto";
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
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.defaultBusyPenalty = normalizeBusyPenalty(options.defaultBusyPenalty);
    }
    /** Lists the registered agents. */
    listAgents() {
        return Array.from(this.agents.values()).map((agent) => this.snapshotAgent(agent));
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
        return this.snapshotAgent(profile);
    }
    /** Removes an agent from the coordinator. Active assignments are preserved. */
    unregisterAgent(agentId) {
        return this.agents.delete(agentId);
    }
    /** Announces a new task and optionally emits heuristic bids for registered agents. */
    announce(announcement) {
        if (!announcement.taskId || announcement.taskId.trim().length === 0) {
            throw new Error("taskId must not be empty");
        }
        const callId = `${announcement.taskId}:${randomUUID()}`;
        const heuristics = normaliseHeuristics(announcement.heuristics, this.defaultBusyPenalty);
        const call = {
            callId,
            taskId: announcement.taskId,
            payload: structuredClone(announcement.payload ?? null),
            tags: normaliseTags(announcement.tags ?? []),
            metadata: structuredClone(announcement.metadata ?? {}),
            deadlineMs: normalizeDeadline(announcement.deadlineMs ?? null),
            heuristics,
            status: "open",
            announcedAt: this.now(),
            awardedBid: null,
            awardedAt: null,
            bids: new Map(),
        };
        this.calls.set(callId, call);
        if (announcement.autoBid !== false) {
            for (const agent of this.agents.values()) {
                const cost = computeHeuristicCost(agent);
                const metadata = { reason: "auto" };
                this.recordBid(call, agent.agentId, cost, metadata, "heuristic");
            }
        }
        return this.snapshotCall(call);
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
        return this.buildDecision(call, bid);
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
        return this.snapshotCall(call);
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
        const bid = {
            agentId,
            cost,
            submittedAt: this.now(),
            metadata,
            kind,
        };
        call.bids.set(agentId, bid);
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
        const busyPenalty = call.heuristics.busyPenalty * busy;
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
