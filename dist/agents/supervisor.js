import { extractCorrelationHints } from "../events/correlation.js";
/**
 * Supervisor observing scheduler progress, loop alerts and child inactivity to
 * initiate mitigating actions. The component implements {@link LoopReconciler}
 * so it can be registered alongside the autoscaler inside the execution loop.
 */
export class OrchestratorSupervisor {
    /** Identifier surfaced in execution loop diagnostics and lifecycle events. */
    id = "supervisor";
    childManager;
    logger;
    actions;
    now;
    stagnationTickThreshold;
    stagnationBacklogThreshold;
    starvationIdleMs;
    starvationRepeatMs;
    lastSchedulerSnapshot = null;
    lastSchedulerSnapshotAt = null;
    lastBacklog = 0;
    lastProgressTick = 0;
    lastProgressAt = 0;
    lastStagnationAlertTick = null;
    lastStarvationAlertAt = null;
    handledLoopSignatures = new Set();
    constructor(options) {
        this.childManager = options.childManager;
        this.logger = options.logger;
        this.now = options.now ?? Date.now;
        this.stagnationTickThreshold = Math.max(1, options.stagnationTickThreshold ?? 6);
        this.stagnationBacklogThreshold = Math.max(1, options.stagnationBacklogThreshold ?? 3);
        this.starvationIdleMs = Math.max(1_000, options.starvationIdleMs ?? 45_000);
        this.starvationRepeatMs = Math.max(5_000, options.starvationRepeatMs ?? 60_000);
        const defaultActions = {
            requestRewrite: async (incident) => {
                this.logger?.warn("supervisor_request_rewrite", incident.context);
            },
            requestRedispatch: async (incident) => {
                this.logger?.warn("supervisor_request_redispatch", incident.context);
            },
            emitAlert: async (incident) => {
                const level = incident.severity === "critical" ? "error" : "warn";
                this.logger?.[level === "error" ? "error" : "warn"]("supervisor_incident", incident);
            },
        };
        this.actions = {
            ...defaultActions,
            ...(options.actions ?? {}),
        };
    }
    /**
     * Records the latest scheduler snapshot so the supervisor can detect lack of
     * progress across multiple loop ticks.
     */
    recordSchedulerSnapshot(snapshot) {
        const backlog = Math.max(0, Math.floor(snapshot.backlog));
        const completed = Math.max(0, Math.floor(snapshot.completed));
        const failed = Math.max(0, Math.floor(snapshot.failed));
        const progress = completed > 0 || failed > 0 || backlog < this.lastBacklog;
        if (progress) {
            this.lastProgressTick = snapshot.schedulerTick;
            this.lastProgressAt = this.now();
            this.lastStagnationAlertTick = null;
        }
        this.lastBacklog = backlog;
        this.lastSchedulerSnapshot = {
            schedulerTick: snapshot.schedulerTick,
            backlog,
            completed,
            failed,
        };
        this.lastSchedulerSnapshotAt = this.now();
    }
    /** Returns the latest scheduler snapshot recorded by the supervisor. */
    getLastSchedulerSnapshot() {
        if (!this.lastSchedulerSnapshot || this.lastSchedulerSnapshotAt === null) {
            return null;
        }
        return {
            schedulerTick: this.lastSchedulerSnapshot.schedulerTick,
            backlog: this.lastSchedulerSnapshot.backlog,
            completed: this.lastSchedulerSnapshot.completed,
            failed: this.lastSchedulerSnapshot.failed,
            updatedAt: this.lastSchedulerSnapshotAt,
        };
    }
    /**
     * Processes a loop alert reported by the {@link LoopDetector}. The supervisor
     * escalates critical loops by cancelling affected children and emits rewrite
     * requests for persistent warnings.
     */
    async recordLoopAlert(alert) {
        if (!alert) {
            return;
        }
        const signatureKey = `${alert.signature}|${alert.childIds.sort().join(",")}`;
        if (this.handledLoopSignatures.has(signatureKey)) {
            return;
        }
        this.handledLoopSignatures.add(signatureKey);
        const incident = {
            type: "loop",
            severity: alert.recommendation === "kill" ? "critical" : "warning",
            reason: alert.reason,
            context: {
                signature: alert.signature,
                recommendation: alert.recommendation,
                child_ids: alert.childIds,
                participants: alert.participants,
                occurrences: alert.occurrences,
                first_timestamp: alert.firstTimestamp,
                last_timestamp: alert.lastTimestamp,
            },
        };
        await this.actions.emitAlert(incident);
        if (alert.recommendation === "kill" && alert.childIds.length > 0) {
            for (const childId of alert.childIds) {
                await this.terminateChild(childId);
            }
        }
        else {
            await this.actions.requestRewrite(incident);
        }
    }
    /** Implements the {@link LoopReconciler} interface. */
    async reconcile(context) {
        const snapshot = this.lastSchedulerSnapshot;
        if (!snapshot) {
            return;
        }
        const ticksWithoutProgress = context.tickIndex - this.lastProgressTick;
        const stagnationActive = snapshot.backlog >= this.stagnationBacklogThreshold &&
            ticksWithoutProgress >= this.stagnationTickThreshold;
        if (stagnationActive) {
            if (this.lastStagnationAlertTick === null || context.tickIndex - this.lastStagnationAlertTick >= this.stagnationTickThreshold) {
                const incident = {
                    type: "stagnation",
                    severity: "warning",
                    reason: "scheduler_backlog_stalled",
                    context: {
                        backlog: snapshot.backlog,
                        ticks_without_progress: ticksWithoutProgress,
                        last_progress_tick: this.lastProgressTick,
                        last_progress_at: this.lastProgressAt,
                    },
                };
                this.lastStagnationAlertTick = context.tickIndex;
                await this.actions.emitAlert(incident);
                await this.actions.requestRewrite(incident);
                await this.actions.requestRedispatch(incident);
            }
        }
        await this.detectStarvation(context.now());
    }
    /** Resets previously seen loop signatures (mainly for tests). */
    resetLoopCache() {
        this.handledLoopSignatures.clear();
    }
    async detectStarvation(now) {
        const snapshot = this.lastSchedulerSnapshot;
        if (!snapshot || snapshot.backlog <= 0) {
            this.lastStarvationAlertAt = null;
            return;
        }
        const idleCandidates = this.childManager
            .childrenIndex
            .list()
            .filter((child) => this.isIdleCandidate(child, now));
        if (idleCandidates.length === 0) {
            this.lastStarvationAlertAt = null;
            return;
        }
        if (this.lastStarvationAlertAt && now - this.lastStarvationAlertAt < this.starvationRepeatMs) {
            return;
        }
        const worst = idleCandidates.reduce((current, next) => (next.lastHeartbeatAt ?? next.startedAt) < (current.lastHeartbeatAt ?? current.startedAt) ? next : current);
        const incident = {
            type: "starvation",
            severity: "warning",
            reason: "idle_children_with_backlog",
            context: {
                backlog: snapshot.backlog,
                idle_children: idleCandidates.map((child) => child.childId),
                idle_duration_ms: now - (worst.lastHeartbeatAt ?? worst.startedAt),
                threshold_ms: this.starvationIdleMs,
            },
        };
        this.lastStarvationAlertAt = now;
        await this.actions.emitAlert(incident);
        await this.actions.requestRedispatch(incident);
    }
    isIdleCandidate(child, now) {
        const state = child.state;
        if (!["ready", "idle", "running"].includes(state)) {
            return false;
        }
        const lastActivity = child.lastHeartbeatAt ?? child.startedAt;
        return now - lastActivity >= this.starvationIdleMs;
    }
    async terminateChild(childId) {
        try {
            await this.childManager.cancel(childId, { timeoutMs: 250 });
            this.logger?.warn("supervisor_cancelled_child", { child_id: childId });
        }
        catch (error) {
            this.logger?.warn("supervisor_cancel_failed", {
                child_id: childId,
                message: error instanceof Error ? error.message : String(error),
            });
            if (this.childManager.kill) {
                try {
                    await this.childManager.kill(childId, { timeoutMs: 200 });
                    this.logger?.error("supervisor_killed_child", { child_id: childId });
                }
                catch (killError) {
                    this.logger?.error("supervisor_kill_failed", {
                        child_id: childId,
                        message: killError instanceof Error ? killError.message : String(killError),
                    });
                }
            }
        }
    }
}
/**
 * Extracts correlation hints from a supervisor incident so downstream
 * orchestrator events can expose run/op identifiers when they are included in
 * the incident context. The helper accepts both camelCase and snake_case
 * fields and tolerates arrays when a single identifier is available.
 */
export function inferSupervisorIncidentCorrelation(incident) {
    return extractCorrelationHints(incident.context);
}
//# sourceMappingURL=supervisor.js.map