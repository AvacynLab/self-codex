/**
 * Base error raised when lifecycle operations fail. Errors carry a stable code
 * so MCP tool wrappers can surface consistent diagnostics to clients.
 */
export class PlanLifecycleError extends Error {
    code;
    hint;
    details;
    constructor(message, code, hint, details) {
        super(message);
        this.name = "PlanLifecycleError";
        this.code = code;
        this.hint = hint;
        this.details = details;
    }
}
/** Error thrown when callers reference an unknown plan run. */
export class PlanRunNotFoundError extends PlanLifecycleError {
    constructor(runId) {
        super(`unknown plan run ${runId}`, "E-PLAN-NOT-FOUND", "plan_run", { runId });
        this.name = "PlanRunNotFoundError";
    }
}
/** Error thrown when pause/resume is requested on a run that does not support it. */
export class PlanLifecycleUnsupportedError extends PlanLifecycleError {
    constructor(runId, operation) {
        super(`plan run ${runId} does not support ${operation}`, operation === "pause" ? "E-PLAN-PAUSE-UNSUPPORTED" : "E-PLAN-RESUME-UNSUPPORTED", "plan_run_reactive", { runId, operation });
        this.name = "PlanLifecycleUnsupportedError";
    }
}
/** Error thrown when lifecycle operations conflict with the current state. */
export class PlanLifecycleInvalidStateError extends PlanLifecycleError {
    constructor(runId, expected, actual) {
        super(`plan run ${runId} is ${actual} but expected ${expected}`, "E-PLAN-STATE", "plan_status", { runId, expected, actual });
        this.name = "PlanLifecycleInvalidStateError";
    }
}
/** Error raised when callers interact with a run that already completed. */
export class PlanLifecycleCompletedError extends PlanLifecycleError {
    constructor(runId) {
        super(`plan run ${runId} already completed`, "E-PLAN-COMPLETED", "plan_status", { runId });
        this.name = "PlanLifecycleCompletedError";
    }
}
/** Error raised when lifecycle tooling is disabled in the runtime features. */
export class PlanLifecycleFeatureDisabledError extends PlanLifecycleError {
    constructor() {
        super("plan lifecycle tooling disabled", "E-PLAN-LIFECYCLE-DISABLED", "enable_plan_lifecycle");
        this.name = "PlanLifecycleFeatureDisabledError";
    }
}
function cloneSnapshot(snapshot) {
    return structuredClone(snapshot);
}
function clonePayload(payload) {
    return structuredClone(payload);
}
function sanitiseCorrelation(hints) {
    return {
        run_id: hints?.runId ?? null,
        op_id: hints?.opId ?? null,
        job_id: hints?.jobId ?? null,
        graph_id: hints?.graphId ?? null,
        node_id: hints?.nodeId ?? null,
        child_id: hints?.childId ?? null,
    };
}
function clampProgress(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 100) {
        return 100;
    }
    return value;
}
function roundProgress(value) {
    return Math.round(value * 100) / 100;
}
/**
 * In-memory registry mirroring the lifecycle of Behaviour Tree executions. The
 * registry keeps lightweight snapshots so MCP tools can expose plan status,
 * pause, and resume semantics without duplicating bookkeeping logic in tests or
 * server handlers.
 */
export class PlanLifecycleRegistry {
    clock;
    entries = new Map();
    constructor(options = {}) {
        this.clock = options.clock ?? (() => Date.now());
    }
    /** Remove every tracked run. Mainly used by tests to reset state between scenarios. */
    clear() {
        this.entries.clear();
    }
    /** Register a new run so subsequent events can update its snapshot. */
    registerRun(options) {
        const existing = this.entries.get(options.runId);
        if (existing) {
            throw new PlanLifecycleError(`plan run ${options.runId} already tracked`, "E-PLAN-ALREADY-TRACKED", "plan_status", { runId: options.runId, state: existing.snapshot.state });
        }
        const now = this.clock();
        const snapshot = {
            run_id: options.runId,
            op_id: options.opId,
            mode: options.mode,
            state: "running",
            progress: 0,
            last_event_seq: 0,
            started_at: now,
            updated_at: now,
            finished_at: null,
            paused_at: null,
            dry_run: options.dryRun ?? false,
            correlation: sanitiseCorrelation(options.correlation ?? null),
            supports_pause: false,
            supports_resume: false,
            last_event: null,
            failure: null,
        };
        const entry = {
            snapshot,
            controls: {},
            metrics: {
                estimatedWork: options.estimatedWork ?? null,
                visitedNodes: new Set(),
                lastTickCount: 0,
                lastSchedulerTicks: 0,
                lastLoopTicks: 0,
                lastPendingAfter: 0,
            },
        };
        this.entries.set(options.runId, entry);
        return cloneSnapshot(snapshot);
    }
    /** Attach pause/resume controls to a registered run. */
    attachControls(runId, controls) {
        const entry = this.entries.get(runId);
        if (!entry) {
            throw new PlanRunNotFoundError(runId);
        }
        entry.controls = { ...controls };
        entry.snapshot.supports_pause = typeof controls.pause === "function";
        entry.snapshot.supports_resume = typeof controls.resume === "function";
        entry.snapshot.updated_at = this.clock();
        return cloneSnapshot(entry.snapshot);
    }
    /** Release pause/resume controls once a run completed. */
    releaseControls(runId) {
        const entry = this.entries.get(runId);
        if (!entry) {
            return;
        }
        entry.controls = {};
        entry.snapshot.supports_pause = false;
        entry.snapshot.supports_resume = false;
    }
    /** Record a lifecycle event and update the associated snapshot. */
    recordEvent(runId, event) {
        const entry = this.entries.get(runId);
        if (!entry) {
            throw new PlanRunNotFoundError(runId);
        }
        const now = event.timestamp ?? this.clock();
        entry.snapshot.last_event_seq += 1;
        entry.snapshot.last_event = {
            phase: event.phase,
            payload: clonePayload(event.payload),
            at: now,
            seq: entry.snapshot.last_event_seq,
        };
        entry.snapshot.updated_at = now;
        switch (event.phase) {
            case "start":
            case "tick":
            case "loop":
            case "node": {
                if (entry.snapshot.state !== "done" && entry.snapshot.state !== "failed") {
                    if (entry.snapshot.state !== "running") {
                        entry.snapshot.state = "running";
                    }
                    entry.snapshot.paused_at = null;
                }
                break;
            }
            case "complete": {
                entry.snapshot.state = "done";
                entry.snapshot.finished_at = now;
                entry.snapshot.failure = null;
                entry.snapshot.progress = 100;
                this.releaseControls(runId);
                break;
            }
            case "error":
            case "cancel": {
                entry.snapshot.state = "failed";
                entry.snapshot.finished_at = now;
                entry.snapshot.failure = {
                    status: typeof event.payload.status === "string" ? event.payload.status : null,
                    reason: typeof event.payload.reason === "string" ? event.payload.reason : null,
                };
                entry.snapshot.progress = 100;
                this.releaseControls(runId);
                break;
            }
            default:
                break;
        }
        this.updateProgress(entry, event);
        return cloneSnapshot(entry.snapshot);
    }
    /** Pause a running plan run and surface the updated snapshot. */
    async pause(runId) {
        const entry = this.entries.get(runId);
        if (!entry) {
            throw new PlanRunNotFoundError(runId);
        }
        if (entry.snapshot.state === "done" || entry.snapshot.state === "failed") {
            throw new PlanLifecycleCompletedError(runId);
        }
        if (entry.snapshot.state === "paused") {
            return cloneSnapshot(entry.snapshot);
        }
        if (typeof entry.controls.pause !== "function") {
            throw new PlanLifecycleUnsupportedError(runId, "pause");
        }
        await entry.controls.pause();
        const now = this.clock();
        entry.snapshot.state = "paused";
        entry.snapshot.paused_at = now;
        entry.snapshot.updated_at = now;
        entry.snapshot.last_event_seq += 1;
        entry.snapshot.last_event = {
            phase: "pause",
            payload: { manual: true },
            at: now,
            seq: entry.snapshot.last_event_seq,
        };
        return cloneSnapshot(entry.snapshot);
    }
    /** Resume a paused run and surface the latest snapshot. */
    async resume(runId) {
        const entry = this.entries.get(runId);
        if (!entry) {
            throw new PlanRunNotFoundError(runId);
        }
        if (entry.snapshot.state === "done" || entry.snapshot.state === "failed") {
            throw new PlanLifecycleCompletedError(runId);
        }
        if (entry.snapshot.state !== "paused") {
            throw new PlanLifecycleInvalidStateError(runId, "paused", entry.snapshot.state);
        }
        if (typeof entry.controls.resume !== "function") {
            throw new PlanLifecycleUnsupportedError(runId, "resume");
        }
        await entry.controls.resume();
        const now = this.clock();
        entry.snapshot.state = "running";
        entry.snapshot.paused_at = null;
        entry.snapshot.updated_at = now;
        entry.snapshot.last_event_seq += 1;
        entry.snapshot.last_event = {
            phase: "resume",
            payload: { manual: true },
            at: now,
            seq: entry.snapshot.last_event_seq,
        };
        return cloneSnapshot(entry.snapshot);
    }
    /** Return a snapshot describing the current lifecycle of the requested run. */
    getSnapshot(runId) {
        const entry = this.entries.get(runId);
        if (!entry) {
            throw new PlanRunNotFoundError(runId);
        }
        return cloneSnapshot(entry.snapshot);
    }
    updateProgress(entry, event) {
        switch (event.phase) {
            case "tick": {
                const ticks = this.extractNumber(event.payload.ticks ?? event.payload.scheduler_ticks);
                if (ticks !== null) {
                    entry.metrics.lastTickCount = Math.max(entry.metrics.lastTickCount, ticks);
                    entry.metrics.lastSchedulerTicks = Math.max(entry.metrics.lastSchedulerTicks, ticks);
                }
                const pending = this.extractNumber(event.payload.pending_after);
                if (pending !== null) {
                    entry.metrics.lastPendingAfter = Math.max(0, pending);
                }
                break;
            }
            case "loop": {
                const executed = this.extractNumber(event.payload.executed_ticks);
                if (executed !== null) {
                    entry.metrics.lastLoopTicks = Math.max(entry.metrics.lastLoopTicks, executed);
                }
                break;
            }
            case "node": {
                const nodeId = typeof event.payload.node_id === "string" ? event.payload.node_id : null;
                const status = typeof event.payload.status === "string" ? event.payload.status : null;
                if (nodeId && status && status !== "running") {
                    entry.metrics.visitedNodes.add(nodeId);
                }
                break;
            }
            default:
                break;
        }
        if (entry.snapshot.state === "done" || entry.snapshot.state === "failed") {
            entry.snapshot.progress = 100;
            return;
        }
        const ratios = [];
        if (entry.metrics.estimatedWork && entry.metrics.estimatedWork > 0) {
            ratios.push(entry.metrics.visitedNodes.size / entry.metrics.estimatedWork);
        }
        if (entry.metrics.lastTickCount > 0 || entry.metrics.lastSchedulerTicks > 0) {
            const ticks = Math.max(entry.metrics.lastTickCount, entry.metrics.lastSchedulerTicks);
            const denominator = ticks + entry.metrics.lastPendingAfter + 1;
            ratios.push(ticks / denominator);
        }
        if (entry.metrics.lastLoopTicks > 0) {
            const denominator = entry.metrics.lastLoopTicks + entry.metrics.lastPendingAfter + 1;
            ratios.push(entry.metrics.lastLoopTicks / denominator);
        }
        if (ratios.length === 0) {
            return;
        }
        const ratio = Math.max(...ratios);
        const bounded = Math.min(0.99, Math.max(0, ratio));
        const progress = clampProgress(roundProgress(bounded * 100));
        entry.snapshot.progress = Math.max(entry.snapshot.progress, progress);
    }
    extractNumber(value) {
        if (typeof value !== "number") {
            return null;
        }
        if (!Number.isFinite(value)) {
            return null;
        }
        return value;
    }
}
