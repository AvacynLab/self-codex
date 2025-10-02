/** Utility constant representing a successful tick result. */
const SUCCESS_RESULT = { status: "success" };
/** Utility constant representing a failed tick result. */
const FAILURE_RESULT = { status: "failure" };
/** Delay helper used by {@link RetryNode} when no runtime wait function is provided. */
async function defaultDelay(ms) {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** Determine whether the provided status represents a terminal outcome. */
function isTerminal(status) {
    return status === "success" || status === "failure";
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
            const result = await child.tick(runtime);
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
            const result = await child.tick(runtime);
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
/** Behaviour Tree parallel composite node. */
export class ParallelNode {
    id;
    policy;
    children;
    childStates = new Map();
    constructor(id, policy, children) {
        this.id = id;
        this.policy = policy;
        this.children = children;
    }
    /**
     * Execute all children concurrently. The policy controls the aggregation of
     * child statuses:
     * - `all`: success when every child succeeds, failure as soon as one fails
     * - `any`: success once one child succeeds, failure when all fail
     */
    async tick(runtime) {
        const results = await Promise.all(this.children.map(async (child) => {
            const previous = this.childStates.get(child.id);
            if (previous && isTerminal(previous)) {
                return { status: previous };
            }
            const result = await child.tick(runtime);
            if (isTerminal(result.status)) {
                this.childStates.set(child.id, result.status);
            }
            return result;
        }));
        const statuses = results.map((result) => result.status);
        const successes = statuses.filter((status) => status === "success").length;
        const failures = statuses.filter((status) => status === "failure").length;
        const running = statuses.filter((status) => status === "running").length;
        if (this.policy === "all") {
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
    attempts = 0;
    constructor(id, maxAttempts, child, backoffMs = 0) {
        this.id = id;
        this.maxAttempts = maxAttempts;
        this.child = child;
        this.backoffMs = backoffMs;
    }
    /**
     * Retry the child node when it fails, waiting for the configured backoff
     * between attempts.
     */
    async tick(runtime) {
        const result = await this.child.tick(runtime);
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
        const delayFn = runtime.wait ?? defaultDelay;
        if (this.backoffMs > 0) {
            await delayFn(this.backoffMs);
        }
        return { status: "running" };
    }
    /** Reset the attempts counter and the child node. */
    reset() {
        this.attempts = 0;
        this.child.reset();
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
        const wait = runtime.wait ?? defaultDelay;
        const start = runtime.now ? runtime.now() : Date.now();
        const budget = this.resolveBudget(runtime);
        const timeoutPromise = wait(budget).then(() => TIMEOUT_SENTINEL);
        const childPromise = this.child.tick(runtime);
        const winner = await Promise.race([timeoutPromise, childPromise]);
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
        const actual = runtime.variables[this.conditionKey];
        const matches = this.expected === undefined ? Boolean(actual) : actual === this.expected;
        if (!matches) {
            this.child.reset();
            return FAILURE_RESULT;
        }
        const result = await this.child.tick(runtime);
        if (result.status !== "running") {
            this.reset();
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
        const rawInput = this.inputKey ? runtime.variables[this.inputKey] : undefined;
        const parsedInput = this.schema ? this.schema.parse(rawInput ?? {}) : rawInput ?? {};
        const output = await runtime.invokeTool(this.toolName, parsedInput);
        return { status: "success", output };
    }
    /** Task leaves are stateless, nothing to reset. */
    reset() {
        // no-op
    }
}
