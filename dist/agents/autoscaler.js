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
    supervisor;
    logger;
    now;
    metricsWindow;
    thresholds;
    spawnTemplate;
    retireGracefulTimeoutMs;
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
        try {
            await this.supervisor.createChild(this.spawnTemplate);
            this.lastScaleAt = this.now();
            this.logger?.info("autoscaler_scale_up", {
                reason,
                backlog: this.backlog,
                samples: this.samples.length,
            });
        }
        catch (error) {
            this.logger?.error("autoscaler_scale_up_failed", {
                reason,
                message: error instanceof Error ? error.message : String(error),
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
        this.scalingInFlight = true;
        try {
            await this.supervisor.cancel(candidate.childId, { timeoutMs: this.retireGracefulTimeoutMs });
            this.lastScaleAt = this.now();
            this.logger?.info("autoscaler_scale_down", { child_id: candidate.childId });
        }
        catch (error) {
            this.logger?.warn?.("autoscaler_scale_down_cancel_failed", {
                child_id: candidate.childId,
                message: error instanceof Error ? error.message : String(error),
            });
            if (this.supervisor.kill) {
                try {
                    await this.supervisor.kill(candidate.childId, { timeoutMs: 200 });
                    this.lastScaleAt = this.now();
                    this.logger?.info("autoscaler_scale_down_forced", { child_id: candidate.childId });
                }
                catch (killError) {
                    this.logger?.error("autoscaler_scale_down_failed", {
                        child_id: candidate.childId,
                        message: killError instanceof Error ? killError.message : String(killError),
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
