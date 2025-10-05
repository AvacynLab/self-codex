import { extractCorrelationHints, mergeCorrelationHints, } from "../events/correlation.js";
/**
 * Builds correlation hints from a child snapshot already registered in the index.
 * The helper keeps explicit `null` overrides while defaulting to the known
 * `childId` when metadata does not surface one.
 */
function inferChildRecordCorrelation(child) {
    if (!child) {
        return {};
    }
    const hints = extractCorrelationHints(child.metadata);
    if (hints.childId == null) {
        hints.childId = child.childId;
    }
    return hints;
}
/** Derives correlation hints from a spawn template used before the child exists. */
function inferCreateChildCorrelation(template) {
    if (!template) {
        return {};
    }
    const hints = extractCorrelationHints(template);
    mergeCorrelationHints(hints, extractCorrelationHints(template.metadata));
    mergeCorrelationHints(hints, extractCorrelationHints(template.manifestExtras));
    if (hints.childId === undefined &&
        typeof template.childId === "string" &&
        template.childId.trim().length > 0) {
        hints.childId = template.childId.trim();
    }
    return hints;
}
const DEFAULT_CONFIG = {
    minChildren: 0,
    maxChildren: 4,
    cooldownMs: 5_000,
};
const DEFAULT_THRESHOLDS = {
    backlogHigh: 4,
    backlogLow: 1,
    latencyHighMs: 1_500,
    latencyLowMs: 500,
    failureRateHigh: 0.35,
    failureRateLow: 0.1,
};
/**
 * Autoscaler supervising the population of child runtimes. The component keeps
 * track of scheduler pressure (backlog), observed task latency and failure
 * rate. Decisions obey hard bounds (`minChildren`/`maxChildren`) and a cooldown
 * period to avoid oscillations.
 */
export class Autoscaler {
    /** Identifier surfaced in execution loop diagnostics and lifecycle events. */
    id = "autoscaler";
    supervisor;
    logger;
    now;
    metricsWindow;
    thresholds;
    spawnTemplate;
    retireGracefulTimeoutMs;
    emitEvent;
    config;
    backlog = 0;
    samples = [];
    lastScaleAt = Number.NEGATIVE_INFINITY;
    scalingInFlight = false;
    constructor(options) {
        this.supervisor = options.supervisor;
        this.logger = options.logger;
        this.now = options.now ?? Date.now;
        this.metricsWindow = Math.max(1, options.metricsWindow ?? 20);
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
        this.spawnTemplate = options.spawnTemplate;
        this.retireGracefulTimeoutMs = Math.max(100, options.retireGracefulTimeoutMs ?? 500);
        this.emitEvent = options.emitEvent;
        this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
        this.config = this.normaliseConfig(this.config);
    }
    /** Returns the currently applied configuration. */
    getConfiguration() {
        return { ...this.config };
    }
    /** Updates the autoscaler configuration while enforcing invariants. */
    configure(next) {
        const merged = {
            ...this.config,
            ...next,
        };
        this.config = this.normaliseConfig(merged);
        this.logger?.info("autoscaler_config_updated", {
            min: this.config.minChildren,
            max: this.config.maxChildren,
            cooldown_ms: this.config.cooldownMs,
        });
        return this.getConfiguration();
    }
    /**
     * Records the number of scheduler ticks currently waiting for execution.
     * The backlog is evaluated at reconciliation time to detect pressure.
     */
    updateBacklog(backlog) {
        if (!Number.isFinite(backlog)) {
            return;
        }
        this.backlog = Math.max(0, Math.floor(backlog));
    }
    /**
     * Adds an execution sample so latency and failure rate can be smoothed
     * across multiple tasks. Samples follow a sliding window policy.
     */
    recordTaskResult(sample) {
        if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) {
            return;
        }
        this.samples.push({ durationMs: sample.durationMs, success: sample.success });
        if (this.samples.length > this.metricsWindow) {
            this.samples.shift();
        }
    }
    /** Aggregated metrics derived from the current backlog and task samples. */
    computeMetrics() {
        if (this.samples.length === 0) {
            return {
                backlog: this.backlog,
                averageLatencyMs: null,
                failureRate: 0,
            };
        }
        const totalDuration = this.samples.reduce((acc, sample) => acc + sample.durationMs, 0);
        const failures = this.samples.filter((sample) => !sample.success).length;
        const failureRate = failures / this.samples.length;
        const averageLatencyMs = totalDuration / this.samples.length;
        return {
            backlog: this.backlog,
            averageLatencyMs,
            failureRate,
        };
    }
    /** Publishes a structured autoscaler event when an action occurs. */
    publishEvent(event) {
        if (!this.emitEvent) {
            return;
        }
        const correlation = {};
        if (event.childId) {
            correlation.childId = event.childId;
        }
        mergeCorrelationHints(correlation, event.correlation);
        if (event.childId && correlation.childId == null) {
            correlation.childId = event.childId;
        }
        const payload = { ...event.payload };
        if (event.childId && payload.child_id === undefined) {
            payload.child_id = event.childId;
        }
        this.emitEvent({
            level: event.level,
            childId: event.childId,
            payload,
            correlation,
        });
    }
    /** Implements the {@link LoopReconciler} contract. */
    async reconcile(context) {
        void context; // The autoscaler currently only needs wall-clock time.
        if (this.scalingInFlight) {
            return;
        }
        const now = this.now();
        const activeChildren = this.countActiveChildren();
        if (activeChildren < this.config.minChildren) {
            await this.scaleUp("min-bound");
            return;
        }
        if (!this.canAct(now)) {
            return;
        }
        const metrics = this.computeMetrics();
        if (this.shouldScaleUp(metrics, activeChildren)) {
            await this.scaleUp("pressure");
            return;
        }
        if (this.shouldScaleDown(metrics, activeChildren)) {
            await this.scaleDown();
        }
    }
    /** Reports the number of children considered active for autoscaling. */
    countActiveChildren() {
        return this.supervisor.childrenIndex
            .list()
            .filter((child) => this.isActive(child))
            .length;
    }
    /** Determines whether a child counts toward the active capacity. */
    isActive(child) {
        switch (child.state) {
            case "starting":
            case "ready":
            case "running":
            case "idle":
            case "stopping":
                return true;
            default:
                return false;
        }
    }
    canAct(now) {
        if (this.config.cooldownMs <= 0) {
            return true;
        }
        return now - this.lastScaleAt >= this.config.cooldownMs;
    }
    shouldScaleUp(metrics, activeChildren) {
        if (activeChildren >= this.config.maxChildren) {
            return false;
        }
        const backlogPressure = metrics.backlog >= this.thresholds.backlogHigh;
        const latencyPressure = metrics.averageLatencyMs !== null && metrics.averageLatencyMs >= this.thresholds.latencyHighMs;
        const failurePressure = metrics.failureRate >= this.thresholds.failureRateHigh;
        return backlogPressure || latencyPressure || failurePressure;
    }
    shouldScaleDown(metrics, activeChildren) {
        if (activeChildren <= this.config.minChildren) {
            return false;
        }
        const backlogRelaxed = metrics.backlog <= this.thresholds.backlogLow;
        const latencyRelaxed = metrics.averageLatencyMs === null || metrics.averageLatencyMs <= this.thresholds.latencyLowMs;
        const failureAcceptable = metrics.failureRate <= this.thresholds.failureRateLow;
        if (!(backlogRelaxed && latencyRelaxed && failureAcceptable)) {
            return false;
        }
        return this.pickRetirableChild() !== null;
    }
    async scaleUp(reason) {
        this.scalingInFlight = true;
        const templateCorrelation = inferCreateChildCorrelation(this.spawnTemplate ?? null);
        const templateChildId = typeof templateCorrelation.childId === "string" && templateCorrelation.childId.length > 0
            ? templateCorrelation.childId
            : undefined;
        const knownChildren = new Set(this.supervisor.childrenIndex.list().map((child) => child.childId));
        try {
            await this.supervisor.createChild(this.spawnTemplate);
            this.lastScaleAt = this.now();
            this.logger?.info("autoscaler_scale_up", {
                reason,
                backlog: this.backlog,
                samples: this.samples.length,
            });
            const newChild = this.supervisor.childrenIndex
                .list()
                .find((snapshot) => !knownChildren.has(snapshot.childId));
            const correlation = newChild
                ? inferChildRecordCorrelation(newChild)
                : {};
            mergeCorrelationHints(correlation, templateCorrelation);
            const childId = newChild?.childId ?? templateChildId;
            this.publishEvent({
                level: "info",
                childId,
                payload: {
                    msg: "scale_up",
                    reason,
                    backlog: this.backlog,
                    samples: this.samples.length,
                },
                correlation,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.error("autoscaler_scale_up_failed", {
                reason,
                message,
            });
            this.publishEvent({
                level: "error",
                childId: templateChildId,
                payload: {
                    msg: "scale_up_failed",
                    reason,
                    backlog: this.backlog,
                    samples: this.samples.length,
                    message,
                },
                correlation: templateCorrelation,
            });
        }
        finally {
            this.scalingInFlight = false;
        }
    }
    async scaleDown() {
        const candidate = this.pickRetirableChild();
        if (!candidate) {
            return;
        }
        const correlation = inferChildRecordCorrelation(candidate);
        const basePayload = {
            reason: "relaxation",
            backlog: this.backlog,
            samples: this.samples.length,
        };
        this.scalingInFlight = true;
        try {
            await this.supervisor.cancel(candidate.childId, { timeoutMs: this.retireGracefulTimeoutMs });
            this.lastScaleAt = this.now();
            this.logger?.info("autoscaler_scale_down", { child_id: candidate.childId });
            this.publishEvent({
                level: "info",
                childId: candidate.childId,
                payload: {
                    ...basePayload,
                    msg: "scale_down",
                },
                correlation,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.warn?.("autoscaler_scale_down_cancel_failed", {
                child_id: candidate.childId,
                message,
            });
            this.publishEvent({
                level: "warn",
                childId: candidate.childId,
                payload: {
                    ...basePayload,
                    msg: "scale_down_cancel_failed",
                    message,
                },
                correlation,
            });
            if (this.supervisor.kill) {
                try {
                    await this.supervisor.kill(candidate.childId, { timeoutMs: 200 });
                    this.lastScaleAt = this.now();
                    this.logger?.info("autoscaler_scale_down_forced", { child_id: candidate.childId });
                    this.publishEvent({
                        level: "warn",
                        childId: candidate.childId,
                        payload: {
                            ...basePayload,
                            msg: "scale_down_forced",
                        },
                        correlation,
                    });
                }
                catch (killError) {
                    const killMessage = killError instanceof Error ? killError.message : String(killError);
                    this.logger?.error("autoscaler_scale_down_failed", {
                        child_id: candidate.childId,
                        message: killMessage,
                    });
                    this.publishEvent({
                        level: "error",
                        childId: candidate.childId,
                        payload: {
                            ...basePayload,
                            msg: "scale_down_failed",
                            message: killMessage,
                        },
                        correlation,
                    });
                }
            }
        }
        finally {
            this.scalingInFlight = false;
        }
    }
    pickRetirableChild() {
        const candidates = this.supervisor.childrenIndex
            .list()
            .filter((child) => child.state === "idle" || child.state === "ready");
        if (candidates.length === 0) {
            return null;
        }
        candidates.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
        return candidates[0] ?? null;
    }
    normaliseConfig(config) {
        const minChildren = Math.max(0, Math.floor(config.minChildren));
        const maxChildren = Math.max(minChildren, Math.floor(config.maxChildren));
        const cooldownMs = Math.max(0, Math.floor(config.cooldownMs));
        return { minChildren, maxChildren, cooldownMs };
    }
}
