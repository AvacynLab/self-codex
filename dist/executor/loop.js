import { setTimeout as defaultSetTimeout, clearTimeout as defaultClearTimeout } from "node:timers";
/**
 * Cooperative helper used by long-running ticks to voluntarily yield control
 * when a time budget is exceeded. The loop provides an instance per tick when
 * a {@link ExecutionLoopOptions.budgetMs} value is configured.
 */
export class CooperativeBudget {
    budgetMs;
    now;
    scheduleYield;
    cancelYield;
    signal;
    checkpoint;
    constructor(budgetMs, now, scheduleYield, cancelYield, signal) {
        this.budgetMs = budgetMs;
        this.now = now;
        this.scheduleYield = scheduleYield;
        this.cancelYield = cancelYield;
        this.signal = signal;
        this.checkpoint = now();
    }
    /** Timestamp (via {@link now}) when the budget started tracking. */
    get startedAt() {
        return this.checkpoint;
    }
    /** Milliseconds elapsed since the last checkpoint. */
    get elapsed() {
        return this.now() - this.checkpoint;
    }
    /** Remaining milliseconds before the budget is exceeded (floored at 0). */
    get remaining() {
        return Math.max(0, this.budgetMs - this.elapsed);
    }
    /** Whether the budget has been exhausted (optionally with a margin). */
    shouldYield(marginMs = 0) {
        return this.elapsed >= Math.max(0, this.budgetMs - marginMs);
    }
    /**
     * Requests an asynchronous yield and resets the checkpoint once resumed.
     * If the loop stops while waiting, the promise resolves silently.
     */
    async yield() {
        if (this.signal.aborted) {
            return;
        }
        await new Promise((resolve) => {
            let finished = false;
            let handle;
            const finalize = () => {
                if (finished) {
                    return;
                }
                finished = true;
                if (handle != null) {
                    this.cancelYield(handle);
                    handle = undefined;
                }
                this.signal.removeEventListener("abort", onAbort);
                resolve();
            };
            const onAbort = () => {
                finalize();
            };
            this.signal.addEventListener("abort", onAbort, { once: true });
            handle = this.scheduleYield(() => {
                handle = undefined;
                finalize();
            });
        });
        this.checkpoint = this.now();
    }
    /**
     * Convenience helper combining {@link shouldYield} and {@link yield}.
     * Returns `true` when a yield actually occurred.
     */
    async yieldIfExceeded(marginMs = 0) {
        if (!this.shouldYield(marginMs)) {
            return false;
        }
        await this.yield();
        return true;
    }
}
/**
 * Periodic execution loop based on {@link setInterval}. The loop provides
 * pause/resume semantics, exposes cooperative budgets for long ticks and keeps
 * track of the executed tick count for diagnostics.
 */
export class ExecutionLoop {
    intervalMs;
    tick;
    now;
    setIntervalFn;
    clearIntervalFn;
    scheduleYield;
    cancelYield;
    budgetMs;
    onError;
    reconcilers;
    afterTick;
    state = "idle";
    timer = null;
    abortController = new AbortController();
    processing = false;
    idlePromise = null;
    idleResolver = null;
    tickCountInternal = 0;
    constructor(options) {
        this.intervalMs = Math.max(0, options.intervalMs);
        this.tick = options.tick;
        this.now = options.now ?? Date.now;
        this.budgetMs = options.budgetMs;
        this.onError = options.onError;
        this.setIntervalFn = options.setIntervalFn ?? ((handler, interval) => setInterval(handler, interval));
        this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
        this.scheduleYield = options.scheduleYield ?? ((resume) => defaultSetTimeout(resume, 0));
        this.cancelYield = options.cancelYield ?? ((handle) => defaultClearTimeout(handle));
        this.reconcilers = options.reconcilers ? [...options.reconcilers] : [];
        this.afterTick = options.afterTick;
    }
    /** Total number of ticks successfully executed so far. */
    get tickCount() {
        return this.tickCountInternal;
    }
    /** Whether the loop is currently active (not paused nor idle). */
    get isRunning() {
        return this.state === "running";
    }
    /** Whether the loop is started but temporarily paused. */
    get isPaused() {
        return this.state === "paused";
    }
    /** Starts the loop. Throws if already running or paused. */
    start() {
        if (this.state !== "idle") {
            throw new Error("ExecutionLoop already started");
        }
        this.state = "running";
        this.abortController = new AbortController();
        this.timer = this.setIntervalFn(() => {
            void this.runTick();
        }, this.intervalMs);
    }
    /** Pauses the loop. Returns `true` when a state change occurred. */
    pause() {
        if (this.state !== "running") {
            return false;
        }
        if (this.timer) {
            this.clearIntervalFn(this.timer);
            this.timer = null;
        }
        this.state = "paused";
        return true;
    }
    /** Resumes the loop after a pause. Returns `true` if the loop was resumed. */
    resume() {
        if (this.state !== "paused") {
            return false;
        }
        this.state = "running";
        this.timer = this.setIntervalFn(() => {
            void this.runTick();
        }, this.intervalMs);
        return true;
    }
    /** Stops the loop and waits for the current tick to complete. */
    async stop() {
        if (this.timer) {
            this.clearIntervalFn(this.timer);
            this.timer = null;
        }
        if (this.state === "idle" && !this.processing) {
            return;
        }
        this.state = "idle";
        this.abortController.abort();
        await this.waitForIdle();
        this.abortController = new AbortController();
    }
    /** Resolves once the loop finished processing the current tick. */
    whenIdle() {
        return this.waitForIdle();
    }
    waitForIdle() {
        if (!this.processing) {
            return Promise.resolve();
        }
        if (!this.idlePromise) {
            this.idlePromise = new Promise((resolve) => {
                this.idleResolver = resolve;
            });
        }
        return this.idlePromise;
    }
    resolveIdle() {
        if (this.idleResolver) {
            const resolve = this.idleResolver;
            this.idleResolver = null;
            this.idlePromise = null;
            resolve();
        }
    }
    async runTick() {
        if (this.processing || this.state !== "running") {
            return;
        }
        this.processing = true;
        const tickIndex = this.tickCountInternal;
        const startedAt = this.now();
        const budget = this.budgetMs !== undefined
            ? new CooperativeBudget(this.budgetMs, this.now, this.scheduleYield, this.cancelYield, this.abortController.signal)
            : undefined;
        const context = {
            startedAt,
            now: this.now,
            tickIndex,
            signal: this.abortController.signal,
            budget,
        };
        try {
            await this.tick(context);
            this.tickCountInternal += 1;
        }
        catch (error) {
            if (this.onError) {
                this.onError(error);
            }
            else {
                queueMicrotask(() => {
                    throw error instanceof Error ? error : new Error(String(error));
                });
            }
        }
        finally {
            const reconcilersRun = [];
            if (this.reconcilers.length > 0) {
                for (const reconciler of this.reconcilers) {
                    const before = this.now();
                    try {
                        await reconciler.reconcile(context);
                        reconcilersRun.push({
                            id: this.describeReconciler(reconciler),
                            status: "ok",
                            durationMs: Math.max(0, this.now() - before),
                        });
                    }
                    catch (error) {
                        reconcilersRun.push({
                            id: this.describeReconciler(reconciler),
                            status: "error",
                            durationMs: Math.max(0, this.now() - before),
                            errorMessage: error instanceof Error
                                ? error.message
                                : typeof error === "string"
                                    ? error
                                    : undefined,
                        });
                        if (this.onError) {
                            this.onError(error);
                        }
                        else {
                            queueMicrotask(() => {
                                throw error instanceof Error ? error : new Error(String(error));
                            });
                        }
                    }
                }
            }
            if (this.afterTick) {
                this.afterTick({ context, reconcilers: reconcilersRun });
            }
            this.processing = false;
            this.resolveIdle();
        }
    }
    describeReconciler(reconciler) {
        if (typeof reconciler.id === "string" && reconciler.id.trim().length > 0) {
            return reconciler.id.trim();
        }
        const name = reconciler.constructor?.name;
        return typeof name === "string" && name.length > 0 ? name : "reconciler";
    }
}
//# sourceMappingURL=loop.js.map