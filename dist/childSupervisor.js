import { randomUUID } from "crypto";
import { startChildRuntime, } from "./childRuntime.js";
import { ChildrenIndex } from "./state/childrenIndex.js";
/** Error raised when the caller attempts to exceed the configured child cap. */
export class ChildLimitExceededError extends Error {
    maxChildren;
    activeChildren;
    code = "E-CHILD-LIMIT";
    hint = "max_children_reached";
    constructor(maxChildren, activeChildren) {
        super(`Cannot spawn more than ${maxChildren} child(ren); ${activeChildren} already running`);
        this.maxChildren = maxChildren;
        this.activeChildren = activeChildren;
        this.name = "ChildLimitExceededError";
    }
}
/**
 * Error raised when a caller requests limits above the configured ceilings. We
 * expose a dedicated code so the server can map the violation to a structured
 * MCP error payload.
 */
export class ChildLimitOverrideError extends Error {
    limit;
    maximum;
    requested;
    code = "E-CHILD-LIMIT";
    hint = "limit_override_rejected";
    constructor(limit, maximum, requested) {
        super(`Limit ${limit}=${requested} exceeds configured maximum ${maximum}`);
        this.limit = limit;
        this.maximum = maximum;
        this.requested = requested;
        this.name = "ChildLimitOverrideError";
    }
}
/**
 * Supervises child runtimes by orchestrating their lifecycle, heartbeats and
 * persistence metadata. The class is intentionally stateful so tools exposed by
 * the MCP server can share a single instance and tests can exercise the
 * high-level behaviour without going through JSON-RPC plumbing yet.
 */
export class ChildSupervisor {
    childrenRoot;
    defaultCommand;
    defaultArgs;
    defaultEnv;
    index;
    runtimes = new Map();
    messageCounters = new Map();
    exitEvents = new Map();
    watchdogs = new Map();
    idleTimeoutMs;
    idleCheckIntervalMs;
    maxChildren = null;
    memoryLimitMb = null;
    cpuPercent = null;
    baseLimitsTemplate = null;
    constructor(options) {
        this.childrenRoot = options.childrenRoot;
        this.defaultCommand = options.defaultCommand;
        this.defaultArgs = options.defaultArgs ? [...options.defaultArgs] : [];
        this.defaultEnv = { ...(options.defaultEnv ?? {}) };
        this.index = options.index ?? new ChildrenIndex();
        const configuredIdle = options.idleTimeoutMs ?? 120_000;
        this.idleTimeoutMs = configuredIdle > 0 ? configuredIdle : 0;
        const defaultInterval = Math.max(250, Math.min(5_000, this.idleTimeoutMs || 5_000));
        const configuredInterval = options.idleCheckIntervalMs;
        const interval = configuredInterval ?? defaultInterval;
        this.idleCheckIntervalMs = interval > 0 ? Math.min(interval, Math.max(250, this.idleTimeoutMs || interval)) : defaultInterval;
        this.configureSafety(options.safety ?? {});
    }
    /** Returns the safety guardrails currently enforced by the supervisor. */
    getSafetySnapshot() {
        return {
            maxChildren: this.maxChildren,
            memoryLimitMb: this.memoryLimitMb,
            cpuPercent: this.cpuPercent,
        };
    }
    /**
     * Updates the safety guardrails. Thresholds are clamped to safe bounds so a
     * misconfiguration never disables protections entirely.
     */
    configureSafety(options) {
        const { maxChildren, memoryLimitMb, cpuPercent } = options;
        if (typeof maxChildren === "number" && Number.isFinite(maxChildren) && maxChildren > 0) {
            this.maxChildren = Math.max(1, Math.trunc(maxChildren));
        }
        else {
            this.maxChildren = null;
        }
        if (typeof memoryLimitMb === "number" && Number.isFinite(memoryLimitMb) && memoryLimitMb > 0) {
            this.memoryLimitMb = Math.max(1, Math.trunc(memoryLimitMb));
        }
        else {
            this.memoryLimitMb = null;
        }
        if (typeof cpuPercent === "number" && Number.isFinite(cpuPercent) && cpuPercent > 0) {
            this.cpuPercent = Math.max(1, Math.min(100, Math.trunc(cpuPercent)));
        }
        else {
            this.cpuPercent = null;
        }
        const template = {};
        if (this.memoryLimitMb !== null) {
            template.memory_mb = this.memoryLimitMb;
        }
        if (this.cpuPercent !== null) {
            template.cpu_percent = this.cpuPercent;
        }
        this.baseLimitsTemplate = Object.keys(template).length > 0 ? template : null;
    }
    /**
     * Generates a stable child identifier following the `child-<timestamp>-<id>`
     * convention required by the brief. A compact suffix is produced from a
     * UUID in order to minimise directory name length while retaining sufficient
     * entropy.
     */
    static generateChildId() {
        const timestamp = Date.now();
        const randomSuffix = randomUUID().replace(/-/g, "").slice(0, 6).toLowerCase();
        return `child-${timestamp}-${randomSuffix}`;
    }
    /**
     * Access to the shared {@link ChildrenIndex}. Mainly used by tests to assert
     * lifecycle transitions.
     */
    get childrenIndex() {
        return this.index;
    }
    /**
     * Registers listeners so heartbeat updates and exit information are
     * persisted automatically when the runtime emits messages or terminates.
     */
    attachRuntime(childId, runtime) {
        runtime.on("message", (message) => {
            this.index.updateHeartbeat(childId, message.receivedAt);
            const parsed = message.parsed;
            const type = parsed?.type;
            if (type === "ready") {
                this.index.updateState(childId, "ready");
            }
            else if (type === "response" || type === "pong") {
                this.index.updateState(childId, "idle");
            }
            else if (type === "error") {
                this.index.updateState(childId, "error");
            }
        });
        this.scheduleIdleWatchdog(childId);
        runtime
            .waitForExit()
            .then((event) => {
            this.clearIdleWatchdog(childId);
            const result = {
                code: event.code,
                signal: event.signal,
                forced: event.forced,
                durationMs: Math.max(0, event.at - runtime.getStatus().startedAt),
            };
            this.exitEvents.set(childId, result);
            this.index.recordExit(childId, {
                code: event.code,
                signal: event.signal,
                at: event.at,
                forced: event.forced,
                reason: event.error ? event.error.message : undefined,
            });
        })
            .catch((error) => {
            // The exit promise should never reject, but we keep a defensive path
            // to ensure the index is not left in an inconsistent state.
            this.clearIdleWatchdog(childId);
            const fallback = {
                code: null,
                signal: null,
                forced: true,
                durationMs: 0,
            };
            this.exitEvents.set(childId, fallback);
            this.index.recordExit(childId, {
                code: null,
                signal: null,
                at: Date.now(),
                forced: true,
                reason: `exit-promise-error:${error.message}`,
            });
        });
    }
    /**
     * Spawns a new child runtime and registers it inside the supervisor index.
     */
    async createChild(options = {}) {
        const childId = options.childId ?? ChildSupervisor.generateChildId();
        if (this.runtimes.has(childId)) {
            throw new Error(`A runtime is already registered for ${childId}`);
        }
        if (this.maxChildren !== null) {
            const activeChildren = this.countActiveChildren();
            if (activeChildren >= this.maxChildren) {
                throw new ChildLimitExceededError(this.maxChildren, activeChildren);
            }
        }
        const command = options.command ?? this.defaultCommand;
        const args = options.args ? [...options.args] : [...this.defaultArgs];
        const env = { ...this.defaultEnv, ...(options.env ?? {}) };
        const resolvedLimits = this.resolveChildLimits(options.limits ?? null);
        const runtime = await startChildRuntime({
            childId,
            childrenRoot: this.childrenRoot,
            command,
            args,
            env,
            metadata: options.metadata,
            manifestExtras: options.manifestExtras,
            limits: resolvedLimits,
            toolsAllow: options.toolsAllow ?? null,
            spawnRetry: options.spawnRetry,
        });
        const snapshot = this.index.registerChild({
            childId,
            pid: runtime.pid,
            workdir: runtime.workdir,
            metadata: options.metadata,
            state: "starting",
        });
        this.runtimes.set(childId, runtime);
        this.attachRuntime(childId, runtime);
        let readyMessage = null;
        const waitForReady = options.waitForReady ?? true;
        if (waitForReady) {
            const readyType = options.readyType ?? "ready";
            readyMessage = await runtime.waitForMessage((message) => {
                const parsed = message.parsed;
                return parsed?.type === readyType;
            }, options.readyTimeoutMs ?? 2000);
            this.index.updateHeartbeat(childId, readyMessage.receivedAt);
            this.index.updateState(childId, "ready");
        }
        return { childId, index: snapshot, runtime, readyMessage };
    }
    /**
     * Sends a payload to a child and updates the lifecycle state to `running`.
     */
    async send(childId, payload) {
        const runtime = this.requireRuntime(childId);
        await runtime.send(payload);
        this.index.updateState(childId, "running");
        const messageId = `${childId}:${this.nextMessageIndex(childId)}`;
        return { messageId, sentAt: Date.now() };
    }
    /**
     * Waits for a message emitted by the child. This is a thin wrapper around the
     * runtime helper but keeps the supervisor API cohesive for the tests.
     */
    async waitForMessage(childId, predicate, timeoutMs) {
        const runtime = this.requireRuntime(childId);
        return runtime.waitForMessage(predicate, timeoutMs);
    }
    /**
     * Collects the latest outputs generated by the child.
     */
    async collect(childId) {
        const runtime = this.requireRuntime(childId);
        return runtime.collectOutputs();
    }
    /**
     * Provides paginated access to the buffered messages emitted by the child.
     */
    stream(childId, options) {
        const runtime = this.requireRuntime(childId);
        return runtime.streamMessages(options);
    }
    /**
     * Retrieves a combined status snapshot from the runtime and the index.
     */
    status(childId) {
        const runtime = this.requireRuntime(childId);
        const index = this.requireIndex(childId);
        return { runtime: runtime.getStatus(), index };
    }
    /**
     * Returns the set of tools explicitly allowed for the targeted child. An
     * empty array means the child is unrestricted.
     */
    getAllowedTools(childId) {
        const runtime = this.requireRuntime(childId);
        return runtime.toolsAllow;
    }
    /**
     * Requests a graceful shutdown of the child.
     */
    async cancel(childId, options) {
        const runtime = this.requireRuntime(childId);
        this.index.updateState(childId, "stopping");
        return runtime.shutdown(options);
    }
    /**
     * Forcefully terminates the child.
     */
    async kill(childId, options) {
        const runtime = this.requireRuntime(childId);
        this.index.updateState(childId, "stopping");
        return runtime.shutdown({ signal: "SIGTERM", timeoutMs: options?.timeoutMs ?? 100, force: true });
    }
    /**
     * Waits for the child to exit and returns the shutdown information.
     */
    async waitForExit(childId, timeoutMs) {
        const runtime = this.runtimes.get(childId);
        if (runtime) {
            const exit = await runtime.waitForExit(timeoutMs);
            const result = {
                code: exit.code,
                signal: exit.signal,
                forced: exit.forced,
                durationMs: Math.max(0, exit.at - runtime.getStatus().startedAt),
            };
            this.exitEvents.set(childId, result);
            return result;
        }
        const recorded = this.exitEvents.get(childId);
        if (!recorded) {
            throw new Error(`Unknown child runtime: ${childId}`);
        }
        return recorded;
    }
    /**
     * Removes the child from the supervisor index once it has terminated.
     */
    gc(childId) {
        this.index.removeChild(childId);
        this.runtimes.delete(childId);
        this.messageCounters.delete(childId);
        this.exitEvents.delete(childId);
        this.clearIdleWatchdog(childId);
    }
    /**
     * Stops all running children. Used as a best-effort cleanup helper in tests.
     */
    async disposeAll() {
        const shutdowns = [];
        for (const [childId, runtime] of this.runtimes.entries()) {
            this.index.updateState(childId, "stopping");
            shutdowns.push(runtime
                .shutdown({ signal: "SIGTERM", timeoutMs: 500 })
                .catch(() => runtime.shutdown({ signal: "SIGKILL", timeoutMs: 500 })));
        }
        await Promise.allSettled(shutdowns);
        this.runtimes.clear();
        this.messageCounters.clear();
        this.exitEvents.clear();
        for (const timer of this.watchdogs.values()) {
            clearInterval(timer);
        }
        this.watchdogs.clear();
    }
    requireRuntime(childId) {
        const runtime = this.runtimes.get(childId);
        if (!runtime) {
            throw new Error(`Unknown child runtime: ${childId}`);
        }
        return runtime;
    }
    requireIndex(childId) {
        const snapshot = this.index.getChild(childId);
        if (!snapshot) {
            throw new Error(`Unknown child record: ${childId}`);
        }
        return snapshot;
    }
    /** Counts the number of children that are still running or spawning. */
    countActiveChildren() {
        let active = 0;
        for (const runtime of this.runtimes.values()) {
            const lifecycle = runtime.getStatus().lifecycle;
            if (lifecycle === "spawning" || lifecycle === "running") {
                active += 1;
            }
        }
        return active;
    }
    /**
     * Merges configured safety limits with caller-provided overrides while
     * guarding against attempts to exceed the configured ceilings.
     */
    resolveChildLimits(overrides) {
        const resolved = this.baseLimitsTemplate ? { ...this.baseLimitsTemplate } : {};
        if (overrides) {
            for (const [key, rawValue] of Object.entries(overrides)) {
                if (rawValue === undefined || rawValue === null) {
                    continue;
                }
                if (key === "memory_mb" && this.memoryLimitMb !== null && typeof rawValue === "number") {
                    if (rawValue > this.memoryLimitMb) {
                        throw new ChildLimitOverrideError("memory_mb", this.memoryLimitMb, rawValue);
                    }
                }
                if (key === "cpu_percent" && this.cpuPercent !== null && typeof rawValue === "number") {
                    if (rawValue > this.cpuPercent) {
                        throw new ChildLimitOverrideError("cpu_percent", this.cpuPercent, rawValue);
                    }
                }
                resolved[key] = rawValue;
            }
        }
        return Object.keys(resolved).length > 0 ? resolved : null;
    }
    nextMessageIndex(childId) {
        const current = this.messageCounters.get(childId) ?? 0;
        const next = current + 1;
        this.messageCounters.set(childId, next);
        return next;
    }
    /**
     * Periodically inspects the last heartbeat of the child to infer idleness.
     * When the inactivity window exceeds {@link idleTimeoutMs} the lifecycle
     * state transitions to `idle` so higher level tools can recycle the clone.
     */
    scheduleIdleWatchdog(childId) {
        if (this.idleTimeoutMs <= 0) {
            return;
        }
        const existing = this.watchdogs.get(childId);
        if (existing) {
            clearInterval(existing);
        }
        const interval = Math.min(this.idleCheckIntervalMs, this.idleTimeoutMs || this.idleCheckIntervalMs);
        const timer = setInterval(() => {
            const snapshot = this.index.getChild(childId);
            if (!snapshot) {
                this.clearIdleWatchdog(childId);
                return;
            }
            if (["terminated", "killed", "error"].includes(snapshot.state)) {
                this.clearIdleWatchdog(childId);
                return;
            }
            if (snapshot.state === "stopping" || snapshot.state === "running") {
                return;
            }
            if (snapshot.lastHeartbeatAt === null) {
                return;
            }
            const inactiveFor = Date.now() - snapshot.lastHeartbeatAt;
            if (inactiveFor >= this.idleTimeoutMs && snapshot.state !== "idle") {
                this.index.updateState(childId, "idle");
            }
        }, interval);
        if (typeof timer.unref === "function") {
            timer.unref();
        }
        this.watchdogs.set(childId, timer);
    }
    /** Clears the watchdog timer associated with the provided child identifier. */
    clearIdleWatchdog(childId) {
        const timer = this.watchdogs.get(childId);
        if (timer) {
            clearInterval(timer);
            this.watchdogs.delete(childId);
        }
    }
}
