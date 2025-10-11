import { runtimeTimers } from "../../runtime/timers.js";
import { OperationCancelledError } from "../cancel.js";
/**
 * Error thrown when cooperative cancellation is triggered at runtime.
 * Exported so callers embedding the Behaviour Tree runtime can detect the
 * cancellation path without depending on implementation details.
 */
export class BehaviorTreeCancellationError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "BehaviorTreeCancellationError";
    }
}
/** Convenience guard ensuring errors raised by cancellation can be identified. */
function isCancellationError(error) {
    return error instanceof BehaviorTreeCancellationError || error instanceof OperationCancelledError;
}
/**
 * Determine whether the provided value represents an abort signal coming from
 * an `AbortController`/`AbortSignal` pair. MCP tools may surface these errors
 * when the orchestrator cancels an in-flight tool invocation.
 */
function isAbortLikeError(error) {
    if (error instanceof Error && error.name === "AbortError") {
        return true;
    }
    if (error && typeof error === "object") {
        const candidate = error;
        if (typeof candidate.name === "string" && candidate.name.toLowerCase() === "aborterror") {
            return true;
        }
        if (typeof candidate.code === "string" && candidate.code.toUpperCase() === "ABORT_ERR") {
            return true;
        }
        if (typeof candidate.code === "number") {
            const abortCode = typeof DOMException !== "undefined" ? DOMException.ABORT_ERR : 20;
            if (candidate.code === abortCode) {
                return true;
            }
        }
    }
    return false;
}
/** Standard message surfaced when cancellation preempts a Behaviour Tree run. */
const DEFAULT_CANCELLATION_MESSAGE = "Behaviour Tree execution cancelled";
/**
 * Convert arbitrary cancellation reasons into the orchestrator-level error used by
 * the Behaviour Tree runtime. Preserves the root cause when available.
 */
function throwCancellation(cause) {
    if (cause instanceof BehaviorTreeCancellationError) {
        throw cause;
    }
    if (cause instanceof OperationCancelledError) {
        throw cause;
    }
    if (cause instanceof Error) {
        const message = cause.message && cause.message.trim().length > 0 ? cause.message : DEFAULT_CANCELLATION_MESSAGE;
        throw new BehaviorTreeCancellationError(message, { cause });
    }
    if (typeof cause === "string") {
        throw new BehaviorTreeCancellationError(cause);
    }
    if (cause !== undefined) {
        throw new BehaviorTreeCancellationError(DEFAULT_CANCELLATION_MESSAGE, { cause });
    }
    throw new BehaviorTreeCancellationError(DEFAULT_CANCELLATION_MESSAGE);
}
/** Utility constant representing a successful tick result. */
const SUCCESS_RESULT = { status: "success" };
/** Utility constant representing a failed tick result. */
const FAILURE_RESULT = { status: "failure" };
/** Delay helper used by {@link RetryNode} when no runtime wait function is provided. */
async function defaultDelay(ms) {
    if (ms <= 0) {
        return;
    }
    await new Promise((resolve) => {
        runtimeTimers.setTimeout(resolve, ms);
    });
}
/** Determine whether the provided status represents a terminal outcome. */
function isTerminal(status) {
    return status === "success" || status === "failure";
}
/** Guard helper executing the runtime cancellation callback when available. */
function ensureNotCancelled(runtime) {
    if (typeof runtime.throwIfCancelled === "function") {
        try {
            runtime.throwIfCancelled();
        }
        catch (error) {
            throwCancellation(error);
        }
    }
    if (typeof runtime.isCancelled === "function" && runtime.isCancelled()) {
        throwCancellation();
    }
    const signal = runtime.cancellationSignal;
    if (signal?.aborted) {
        throwCancellation(signal.reason);
    }
}
/** Behaviour Tree sequence composite node. */
export class SequenceNode {
    id;
    children;
    currentIndex = 0;
    constructor(id, children) {
        this.id = id;
        this.children = children;
    }
    /**
     * Execute the sequence: each child must succeed for the composite to succeed.
     * When a child returns {@link BTStatus."running"} the current index is
     * preserved so the next tick resumes from the same child.
     */
    async tick(runtime) {
        while (this.currentIndex < this.children.length) {
            const child = this.children[this.currentIndex];
            try {
                ensureNotCancelled(runtime);
            }
            catch (error) {
                if (isCancellationError(error)) {
                    // Cooperative cancellation must rewind the sequence so future ticks start
                    // from the first child instead of resuming mid-way through the cursor.
                    this.reset();
                }
                throw error;
            }
            let result;
            try {
                result = await child.tick(runtime);
            }
            catch (error) {
                if (isCancellationError(error)) {
                    // Child initiated cancellation should leave the composite in a clean state
                    // so orchestrators can safely retry the sequence from scratch.
                    this.reset();
                }
                throw error;
            }
            if (result.status === "running") {
                return result;
            }
            if (result.status === "failure") {
                this.reset();
                return FAILURE_RESULT;
            }
            this.currentIndex += 1;
        }
        this.reset();
        return SUCCESS_RESULT;
    }
    /** Reset the cursor and child nodes. */
    reset() {
        this.currentIndex = 0;
        for (const child of this.children) {
            child.reset();
        }
    }
}
/** Behaviour Tree selector composite node. */
export class SelectorNode {
    id;
    children;
    currentIndex = 0;
    constructor(id, children) {
        this.id = id;
        this.children = children;
    }
    /**
     * Execute the selector: the first child to succeed wins. The cursor is stored
     * while waiting on running children so the selector resumes deterministically.
     */
    async tick(runtime) {
        while (this.currentIndex < this.children.length) {
            const child = this.children[this.currentIndex];
            try {
                ensureNotCancelled(runtime);
            }
            catch (error) {
                if (isCancellationError(error)) {
                    // Reset the selector so cancelled runs do not keep their previous cursor.
                    this.reset();
                }
                throw error;
            }
            let result;
            try {
                result = await child.tick(runtime);
            }
            catch (error) {
                if (isCancellationError(error)) {
                    // Cancellation bubbling from the child must clear the selector state.
                    this.reset();
                }
                throw error;
            }
            if (result.status === "running") {
                return result;
            }
            if (result.status === "success") {
                this.reset();
                return SUCCESS_RESULT;
            }
            this.currentIndex += 1;
        }
        this.reset();
        return FAILURE_RESULT;
    }
    /** Reset the cursor and child nodes. */
    reset() {
        this.currentIndex = 0;
        for (const child of this.children) {
            child.reset();
        }
    }
}
/** Convert user provided policy configuration into the internal representation. */
function normaliseParallelPolicy(policy, childCount) {
    if (policy === "all" || policy === "any") {
        return { kind: policy };
    }
    const threshold = Number(policy.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
        throw new Error("Parallel quota threshold must be a positive integer");
    }
    const clamped = Math.max(1, Math.min(childCount, Math.floor(threshold)));
    return { kind: "quota", successThreshold: clamped };
}
/** Behaviour Tree parallel composite node. */
export class ParallelNode {
    id;
    children;
    childStates = new Map();
    policy;
    constructor(id, policy, children) {
        this.id = id;
        this.children = children;
        this.policy = normaliseParallelPolicy(policy, children.length);
    }
    /**
     * Execute all children concurrently. The policy controls the aggregation of
     * child statuses:
     * - `all`: success when every child succeeds, failure as soon as one fails
     * - `any`: success once one child succeeds, failure when all fail
     */
    async tick(runtime) {
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                // Cooperative cancellations should rewind cached child states so the next
                // tick restarts every branch from a clean slate.
                this.reset();
            }
            throw error;
        }
        const childPromises = this.children.map(async (child) => {
            const previous = this.childStates.get(child.id);
            if (previous && isTerminal(previous)) {
                return { status: previous };
            }
            ensureNotCancelled(runtime);
            try {
                const result = await child.tick(runtime);
                if (isTerminal(result.status)) {
                    this.childStates.set(child.id, result.status);
                }
                return result;
            }
            catch (error) {
                if (isCancellationError(error)) {
                    // The composite-level catch will perform the reset once every child
                    // settled to avoid double rewinds while other branches complete.
                }
                throw error;
            }
        });
        let results;
        try {
            results = await Promise.all(childPromises);
        }
        catch (error) {
            await Promise.allSettled(childPromises);
            if (isCancellationError(error)) {
                // Cancellation should evict cached terminal states to prevent partially
                // completed runs from being treated as finished once the orchestrator
                // retries the parallel composite.
                this.reset();
            }
            throw error;
        }
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                this.reset();
            }
            throw error;
        }
        const statuses = results.map((result) => result.status);
        const successes = statuses.filter((status) => status === "success").length;
        const failures = statuses.filter((status) => status === "failure").length;
        const running = statuses.filter((status) => status === "running").length;
        switch (this.policy.kind) {
            case "all": {
                if (failures > 0) {
                    this.reset();
                    return FAILURE_RESULT;
                }
                if (running === 0 && successes === this.children.length) {
                    this.reset();
                    return SUCCESS_RESULT;
                }
                return { status: "running" };
            }
            case "any": {
                if (successes > 0) {
                    this.reset();
                    return SUCCESS_RESULT;
                }
                if (running === 0 && failures === this.children.length) {
                    this.reset();
                    return FAILURE_RESULT;
                }
                return { status: "running" };
            }
            case "quota": {
                if (successes >= this.policy.successThreshold) {
                    this.reset();
                    return SUCCESS_RESULT;
                }
                const remainingPotential = this.children.length - failures;
                if (remainingPotential < this.policy.successThreshold) {
                    this.reset();
                    return FAILURE_RESULT;
                }
                return { status: "running" };
            }
            default: {
                const exhaustive = this.policy;
                throw new Error(`unsupported parallel policy ${exhaustive.kind}`);
            }
        }
    }
    /** Reset cached statuses and child nodes. */
    reset() {
        this.childStates.clear();
        for (const child of this.children) {
            child.reset();
        }
    }
}
/** Behaviour Tree retry decorator node. */
export class RetryNode {
    id;
    maxAttempts;
    child;
    backoffMs;
    backoffJitterMs;
    attempts = 0;
    constructor(id, maxAttempts, child, backoffMs = 0, backoffJitterMs = 0) {
        this.id = id;
        this.maxAttempts = maxAttempts;
        this.child = child;
        this.backoffMs = backoffMs;
        this.backoffJitterMs = backoffJitterMs;
    }
    /**
     * Retry the child node when it fails, waiting for the configured backoff
     * between attempts.
     */
    async tick(runtime) {
        let childStarted = false;
        let childReset = false;
        const handleCancellation = (error) => {
            if (isCancellationError(error)) {
                this.resetAfterCancellation(childStarted, childReset);
            }
            throw error;
        };
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            handleCancellation(error);
            throw error;
        }
        let result;
        try {
            childStarted = true;
            result = await this.child.tick(runtime);
        }
        catch (error) {
            handleCancellation(error);
            throw error;
        }
        if (result.status === "success") {
            this.reset();
            return result;
        }
        if (result.status === "running") {
            return result;
        }
        this.attempts += 1;
        if (this.attempts >= this.maxAttempts) {
            this.reset();
            return FAILURE_RESULT;
        }
        this.child.reset();
        childReset = true;
        const delayFn = runtime.wait ?? defaultDelay;
        const delay = this.computeBackoffDelay(runtime);
        if (delay > 0) {
            try {
                ensureNotCancelled(runtime);
            }
            catch (error) {
                handleCancellation(error);
                throw error;
            }
            try {
                await delayFn(delay);
            }
            catch (error) {
                handleCancellation(error);
                throw error;
            }
            try {
                ensureNotCancelled(runtime);
            }
            catch (error) {
                handleCancellation(error);
                throw error;
            }
        }
        return { status: "running" };
    }
    /** Reset the attempts counter and the child node. */
    reset() {
        this.attempts = 0;
        this.child.reset();
    }
    /**
     * Restore the retry state after a cooperative cancellation so the next tick starts
     * from a clean slate without double-resetting children that were already rewound.
     */
    resetAfterCancellation(childStarted, childAlreadyReset) {
        this.attempts = 0;
        if (childStarted && !childAlreadyReset) {
            this.child.reset();
        }
    }
    /**
     * Compute the backoff delay enriched with jitter when configured. Jitter
     * relies on a runtime-provided pseudo-random source when available to keep
     * tests deterministic.
     */
    computeBackoffDelay(runtime) {
        const base = Math.max(0, this.backoffMs);
        const jitter = Math.max(0, this.backoffJitterMs);
        if (jitter === 0) {
            return base;
        }
        const sampler = typeof runtime.random === "function" ? runtime.random : Math.random;
        let sample;
        try {
            sample = sampler();
        }
        catch {
            sample = Math.random();
        }
        if (!Number.isFinite(sample)) {
            sample = Math.random();
        }
        const boundedSample = Math.min(Math.max(sample, 0), 1);
        const jitterComponent = Math.round(boundedSample * jitter);
        return base + jitterComponent;
    }
}
/** Behaviour Tree timeout decorator node. */
const TIMEOUT_SENTINEL = Symbol("timeout");
export class TimeoutNode {
    id;
    fallbackTimeoutMs;
    child;
    options;
    constructor(id, fallbackTimeoutMs, child, options = {}) {
        this.id = id;
        this.fallbackTimeoutMs = fallbackTimeoutMs;
        this.child = child;
        this.options = options;
    }
    /**
     * Wrap the child execution inside a timeout. When the timer elapses first the
     * decorator fails and resets the child. Successful completions report the
     * duration to the runtime so loop detectors can adjust future budgets.
     */
    async tick(runtime) {
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                // Align timeout cancellation semantics with other decorators by rewinding
                // the child when interrupted before execution begins.
                this.child.reset();
            }
            throw error;
        }
        const wait = runtime.wait ?? defaultDelay;
        const start = runtime.now ? runtime.now() : Date.now();
        const budget = this.resolveBudget(runtime);
        const timeoutPromise = wait(budget).then(() => TIMEOUT_SENTINEL);
        const childPromise = this.child.tick(runtime);
        let winner;
        try {
            winner = (await Promise.race([timeoutPromise, childPromise]));
        }
        catch (error) {
            if (isCancellationError(error)) {
                this.child.reset();
            }
            throw error;
        }
        if (winner === TIMEOUT_SENTINEL) {
            const end = runtime.now ? runtime.now() : Date.now();
            this.recordOutcome(runtime, end - start, false, budget);
            this.child.reset();
            this.reset();
            return FAILURE_RESULT;
        }
        const result = winner;
        if (result.status !== "running") {
            const end = runtime.now ? runtime.now() : Date.now();
            this.recordOutcome(runtime, end - start, result.status === "success", budget);
            this.reset();
        }
        return result;
    }
    /** Reset simply proxies to the child to clear its state. */
    reset() {
        this.child.reset();
    }
    resolveBudget(runtime) {
        const { category, complexityScore } = this.options;
        if (category && runtime.recommendTimeout) {
            const recommended = runtime.recommendTimeout(category, complexityScore ?? undefined, this.fallbackTimeoutMs ?? undefined);
            if (recommended !== undefined && Number.isFinite(recommended) && recommended > 0) {
                return Math.round(recommended);
            }
        }
        if (this.fallbackTimeoutMs !== null && this.fallbackTimeoutMs !== undefined) {
            return this.fallbackTimeoutMs;
        }
        throw new Error(`TimeoutNode ${this.id} is missing a valid timeout budget`);
    }
    recordOutcome(runtime, durationMs, success, budgetMs) {
        const { category } = this.options;
        if (!category || !runtime.recordTimeoutOutcome) {
            return;
        }
        const safeDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
        try {
            runtime.recordTimeoutOutcome(category, {
                durationMs: Math.max(1, Math.round(safeDuration)),
                success,
                budgetMs,
            });
        }
        catch {
            // Recording telemetry must never break behaviour tree execution.
        }
    }
}
/** Behaviour Tree guard decorator node. */
export class GuardNode {
    id;
    conditionKey;
    expected;
    child;
    constructor(id, conditionKey, expected, child) {
        this.id = id;
        this.conditionKey = conditionKey;
        this.expected = expected;
        this.child = child;
    }
    /**
     * Evaluate the guard condition using the runtime variables. When the condition
     * does not hold the guard short-circuits with a failure and resets the child.
     */
    async tick(runtime) {
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                // Guard decorators do not maintain internal state, yet resetting the child
                // ensures partially evaluated work is abandoned when cooperative
                // cancellation interrupts before the condition is read.
                this.child.reset();
            }
            throw error;
        }
        const actual = runtime.variables[this.conditionKey];
        const matches = this.expected === undefined ? Boolean(actual) : actual === this.expected;
        if (!matches) {
            this.child.reset();
            return FAILURE_RESULT;
        }
        let result;
        try {
            result = await this.child.tick(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                // The child may surface cancellation while evaluating; reset before
                // bubbling the error so the next tick starts from a clean slate.
                this.child.reset();
            }
            throw error;
        }
        if (result.status !== "running") {
            this.reset();
            return result;
        }
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                // Running children are rewound when cancellation triggers between ticks.
                this.child.reset();
            }
            throw error;
        }
        return result;
    }
    /** Reset proxies to the child node. */
    reset() {
        this.child.reset();
    }
}
/** Behaviour Tree task leaf calling an orchestrator tool. */
export class TaskLeaf {
    id;
    toolName;
    inputKey;
    schema;
    constructor(id, toolName, options = {}) {
        this.id = id;
        this.toolName = toolName;
        this.inputKey = options.inputKey;
        this.schema = options.schema;
    }
    /**
     * Resolve the task input, validate it and invoke the corresponding tool via
     * the runtime.
     */
    async tick(runtime) {
        ensureNotCancelled(runtime);
        const rawInput = this.inputKey ? runtime.variables[this.inputKey] : undefined;
        const parsedInput = this.schema ? this.schema.parse(rawInput ?? {}) : rawInput ?? {};
        ensureNotCancelled(runtime);
        let output;
        try {
            output = await runtime.invokeTool(this.toolName, parsedInput);
        }
        catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            if (isAbortLikeError(error)) {
                throwCancellation(error);
            }
            throw error;
        }
        ensureNotCancelled(runtime);
        return { status: "success", output };
    }
    /** Task leaves are stateless, nothing to reset. */
    reset() {
        // no-op
    }
}
/** Behaviour Tree decorator that enforces cooperative cancellation. */
export class CancellableNode {
    id;
    child;
    constructor(id, child) {
        this.id = id;
        this.child = child;
    }
    async tick(runtime) {
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                this.child.reset();
            }
            throw error;
        }
        let result;
        try {
            result = await this.child.tick(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                this.child.reset();
            }
            this.reset();
            throw error;
        }
        if (result.status !== "running") {
            this.reset();
            return result;
        }
        try {
            ensureNotCancelled(runtime);
        }
        catch (error) {
            if (isCancellationError(error)) {
                this.child.reset();
            }
            throw error;
        }
        return result;
    }
    reset() {
        this.child.reset();
    }
}
//# sourceMappingURL=nodes.js.map