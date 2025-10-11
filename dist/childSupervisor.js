import { randomUUID } from "node:crypto";
import { runtimeTimers } from "./runtime/timers.js";
import { defaultFileSystemGateway } from "./gateways/fs.js";
import { startChildRuntime, } from "./childRuntime.js";
import { bridgeChildRuntimeEvents } from "./events/bridges.js";
import { extractCorrelationHints, mergeCorrelationHints } from "./events/correlation.js";
import { ChildrenIndex } from "./state/childrenIndex.js";
import { childWorkspacePath, ensureDirectory } from "./paths.js";
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
    logicalChildren = new Map();
    messageCounters = new Map();
    exitEvents = new Map();
    watchdogs = new Map();
    eventBus;
    resolveChildCorrelation;
    recordChildLogEntry;
    fileSystem;
    childEventBridges = new Map();
    childLogRecorders = new Map();
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
        this.eventBus = options.eventBus;
        this.resolveChildCorrelation = options.resolveChildCorrelation;
        this.recordChildLogEntry = options.recordChildLogEntry;
        this.fileSystem = options.fileSystem ?? defaultFileSystemGateway;
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
     * Allocates a fresh child identifier compatible with the on-disk layout. The helper
     * guarantees uniqueness across both process-backed and logical children.
     */
    createChildId() {
        while (true) {
            const candidate = ChildSupervisor.generateChildId();
            if (this.runtimes.has(candidate) || this.logicalChildren.has(candidate) || this.index.getChild(candidate)) {
                continue;
            }
            return candidate;
        }
    }
    /**
     * Registers a logical HTTP child that routes work back to the orchestrator instead of spawning a
     * dedicated process. A manifest is still persisted to keep observability tooling consistent.
     */
    async registerHttpChild(options) {
        const childId = options.childId ?? this.createChildId();
        if (this.runtimes.has(childId) || this.logicalChildren.has(childId)) {
            throw new Error(`A child is already registered under identifier ${childId}`);
        }
        if (this.maxChildren !== null) {
            const activeChildren = this.countActiveChildren();
            if (activeChildren >= this.maxChildren) {
                throw new ChildLimitExceededError(this.maxChildren, activeChildren);
            }
        }
        const startedAt = options.startedAt ?? Date.now();
        const limits = options.limits ? { ...options.limits } : null;
        const role = options.role ?? null;
        const allowedTools = options.allowedTools ? [...new Set(options.allowedTools)] : [];
        await ensureDirectory(this.childrenRoot, childId);
        await ensureDirectory(this.childrenRoot, childId, "logs");
        await ensureDirectory(this.childrenRoot, childId, "outbox");
        await ensureDirectory(this.childrenRoot, childId, "inbox");
        const workdir = childWorkspacePath(this.childrenRoot, childId);
        const manifestPath = childWorkspacePath(this.childrenRoot, childId, "manifest.json");
        const logPath = childWorkspacePath(this.childrenRoot, childId, "logs", "child.log");
        const metadata = { ...(options.metadata ?? {}) };
        metadata.transport = "http";
        metadata.endpoint = { ...options.endpoint };
        const manifestExtras = { ...(options.manifestExtras ?? {}) };
        delete manifestExtras.role;
        delete manifestExtras.limits;
        const indexSnapshot = this.index.registerChild({
            childId,
            pid: -1,
            workdir,
            state: "ready",
            startedAt,
            metadata,
            role,
            limits,
            attachedAt: startedAt,
        });
        this.index.updateHeartbeat(childId, startedAt);
        const session = {
            childId,
            startedAt,
            lastHeartbeatAt: startedAt,
            endpoint: { url: options.endpoint.url, headers: { ...options.endpoint.headers } },
            manifestPath,
            logPath,
            workdir,
            metadata,
            limits,
            role,
            manifestExtras,
            allowedTools,
        };
        await this.writeLogicalManifest(session);
        this.logicalChildren.set(childId, session);
        return { childId, index: indexSnapshot, manifestPath, logPath, workdir, startedAt };
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
        const inferCorrelation = (context) => {
            const hints = { childId };
            mergeCorrelationHints(hints, extractCorrelationHints(runtime.metadata));
            const indexSnapshot = this.index.getChild(childId);
            if (indexSnapshot) {
                mergeCorrelationHints(hints, extractCorrelationHints(indexSnapshot.metadata));
            }
            if (context.kind === "message") {
                // When the child surfaces structured payloads we opportunistically
                // reuse the embedded identifiers to correlate stdout/stderr events
                // with their originating run/operation.
                const payload = context.message.parsed;
                if (payload && typeof payload === "object") {
                    const runId = payload.runId;
                    const opId = payload.opId;
                    const jobId = payload.jobId;
                    const graphId = payload.graphId;
                    const nodeId = payload.nodeId;
                    if (typeof runId === "string" && runId.length > 0) {
                        hints.runId = runId;
                    }
                    if (typeof opId === "string" && opId.length > 0) {
                        hints.opId = opId;
                    }
                    if (typeof jobId === "string" && jobId.length > 0) {
                        hints.jobId = jobId;
                    }
                    if (typeof graphId === "string" && graphId.length > 0) {
                        hints.graphId = graphId;
                    }
                    if (typeof nodeId === "string" && nodeId.length > 0) {
                        hints.nodeId = nodeId;
                    }
                }
            }
            const extra = this.resolveChildCorrelation?.(context);
            // Merge external correlation hints without letting sparse resolvers wipe
            // the identifiers inferred from the child payload (undefined should
            // never override concrete hints such as the childId).
            if (extra) {
                mergeCorrelationHints(hints, extra);
            }
            return hints;
        };
        if (this.eventBus) {
            const disposeBridge = bridgeChildRuntimeEvents({
                runtime,
                bus: this.eventBus,
                resolveCorrelation: inferCorrelation,
            });
            this.childEventBridges.set(childId, disposeBridge);
        }
        if (this.recordChildLogEntry) {
            const recorder = (message) => {
                const correlation = inferCorrelation({ kind: "message", runtime, message });
                const snapshot = {
                    ts: message.receivedAt,
                    stream: message.stream,
                    message: message.raw,
                    childId,
                    jobId: correlation.jobId ?? null,
                    runId: correlation.runId ?? null,
                    opId: correlation.opId ?? null,
                    graphId: correlation.graphId ?? null,
                    nodeId: correlation.nodeId ?? null,
                    raw: message.raw,
                    parsed: message.parsed,
                };
                this.recordChildLogEntry?.(childId, snapshot);
            };
            runtime.on("message", recorder);
            this.childLogRecorders.set(childId, recorder);
        }
        runtime
            .waitForExit()
            .then((event) => {
            this.clearIdleWatchdog(childId);
            this.detachEventBridge(childId);
            this.detachChildLogRecorder(childId);
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
            this.detachEventBridge(childId);
            this.detachChildLogRecorder(childId);
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
        const resolvedRole = options.role ?? (typeof options.metadata?.role === "string" ? String(options.metadata.role) : null);
        const metadata = { ...(options.metadata ?? {}) };
        if (resolvedRole !== null) {
            metadata.role = resolvedRole;
        }
        if (resolvedLimits) {
            metadata.limits = structuredClone(resolvedLimits);
        }
        const runtime = await startChildRuntime({
            childId,
            childrenRoot: this.childrenRoot,
            command,
            args,
            env,
            metadata,
            manifestExtras: options.manifestExtras,
            limits: resolvedLimits,
            role: resolvedRole,
            toolsAllow: options.toolsAllow ?? null,
            spawnRetry: options.spawnRetry,
        });
        const snapshot = this.index.registerChild({
            childId,
            pid: runtime.pid,
            workdir: runtime.workdir,
            metadata,
            state: "starting",
            limits: resolvedLimits,
            role: resolvedRole,
            attachedAt: Date.now(),
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
        const logical = this.getLogicalChild(childId);
        if (logical) {
            throw new Error(`Logical child ${childId} does not support direct send operations`);
        }
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
        const logical = this.getLogicalChild(childId);
        if (logical) {
            throw new Error(`Logical child ${childId} cannot emit process messages`);
        }
        const runtime = this.requireRuntime(childId);
        return runtime.waitForMessage(predicate, timeoutMs);
    }
    /**
     * Collects the latest outputs generated by the child.
     */
    async collect(childId) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            return {
                childId,
                manifestPath: logical.manifestPath,
                logPath: logical.logPath,
                messages: [],
                artifacts: [],
            };
        }
        const runtime = this.requireRuntime(childId);
        return runtime.collectOutputs();
    }
    /**
     * Updates the advertised role for a running child and rewrites its manifest so
     * observers can react to the change without restarting the process.
     */
    async setChildRole(childId, role, options = {}) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            logical.role = role;
            const metadata = { ...logical.metadata };
            if (role === null) {
                delete metadata.role;
            }
            else {
                metadata.role = role;
            }
            logical.metadata = metadata;
            this.mergeLogicalManifestExtras(logical, options.manifestExtras);
            await this.writeLogicalManifest(logical);
            const index = this.index.setRole(childId, role);
            return { runtime: this.buildLogicalRuntimeStatus(logical), index };
        }
        const runtime = this.requireRuntime(childId);
        await runtime.setRole(role, options.manifestExtras ?? {});
        const index = this.index.setRole(childId, role);
        return { runtime: runtime.getStatus(), index };
    }
    /**
     * Applies new declarative limits to the runtime after enforcing supervisor
     * guardrails. The manifest is rewritten to surface the new ceilings.
     */
    async setChildLimits(childId, limits, options = {}) {
        const resolved = this.resolveChildLimits(limits ?? null);
        const logical = this.getLogicalChild(childId);
        const publishLimitsEvent = (limitsSnapshot) => {
            if (!this.eventBus) {
                return;
            }
            // Surface the update on the unified event bus so validation tooling can
            // assert declarative guardrails were actually refreshed. The message
            // mirrors the checklist wording while the structured payload retains the
            // resolved limits for downstream consumers.
            this.eventBus.publish({
                cat: "child",
                level: "info",
                childId,
                component: "child_supervisor",
                stage: "limits",
                msg: "child.limits.updated",
                data: { childId, limits: limitsSnapshot },
            });
        };
        if (logical) {
            logical.limits = resolved ? { ...resolved } : null;
            const metadata = { ...logical.metadata };
            if (logical.limits) {
                metadata.limits = structuredClone(logical.limits);
            }
            else {
                delete metadata.limits;
            }
            logical.metadata = metadata;
            this.mergeLogicalManifestExtras(logical, options.manifestExtras);
            await this.writeLogicalManifest(logical);
            const index = this.index.setLimits(childId, resolved);
            publishLimitsEvent(resolved);
            return { runtime: this.buildLogicalRuntimeStatus(logical), index, limits: resolved };
        }
        const runtime = this.requireRuntime(childId);
        await runtime.setLimits(resolved, options.manifestExtras ?? {});
        const index = this.index.setLimits(childId, resolved);
        publishLimitsEvent(resolved);
        return { runtime: runtime.getStatus(), index, limits: resolved };
    }
    /**
     * Refreshes the manifest of an already running child and records the
     * attachment timestamp for observability.
     */
    async attachChild(childId, options = {}) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            this.mergeLogicalManifestExtras(logical, options.manifestExtras);
            await this.writeLogicalManifest(logical);
            const existing = this.index.getChild(childId);
            const attachTimestamp = existing?.attachedAt ?? Date.now();
            const index = this.index.markAttached(childId, attachTimestamp);
            logical.lastHeartbeatAt = Date.now();
            this.index.updateHeartbeat(childId, logical.lastHeartbeatAt);
            return { runtime: this.buildLogicalRuntimeStatus(logical), index };
        }
        const runtime = this.requireRuntime(childId);
        await runtime.attach(options.manifestExtras ?? {});
        const index = this.index.markAttached(childId);
        return { runtime: runtime.getStatus(), index };
    }
    /**
     * Provides paginated access to the buffered messages emitted by the child.
     */
    stream(childId, options) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            return {
                childId,
                totalMessages: 0,
                matchedMessages: 0,
                hasMore: false,
                nextCursor: null,
                messages: [],
            };
        }
        const runtime = this.requireRuntime(childId);
        return runtime.streamMessages(options);
    }
    /**
     * Retrieves a combined status snapshot from the runtime and the index.
     */
    status(childId) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            const index = this.requireIndex(childId);
            return { runtime: this.buildLogicalRuntimeStatus(logical), index };
        }
        const runtime = this.requireRuntime(childId);
        const index = this.requireIndex(childId);
        return { runtime: runtime.getStatus(), index };
    }
    /**
     * Returns the set of tools explicitly allowed for the targeted child. An
     * empty array means the child is unrestricted.
     */
    getAllowedTools(childId) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            return logical.allowedTools;
        }
        const runtime = this.requireRuntime(childId);
        return runtime.toolsAllow;
    }
    /**
     * Returns a shallow clone of the HTTP endpoint descriptor registered for the
     * provided logical child. Process-backed runtimes return `null` since they do
     * not expose an HTTP loopback endpoint.
     */
    getHttpEndpoint(childId) {
        const logical = this.getLogicalChild(childId);
        if (!logical) {
            return null;
        }
        return {
            url: logical.endpoint.url,
            headers: { ...logical.endpoint.headers },
        };
    }
    /**
     * Requests a graceful shutdown of the child.
     */
    async cancel(childId, options) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            this.index.updateState(childId, "stopping");
            return this.finalizeLogicalChild(logical, false);
        }
        const runtime = this.requireRuntime(childId);
        this.index.updateState(childId, "stopping");
        return runtime.shutdown(options);
    }
    /**
     * Forcefully terminates the child.
     */
    async kill(childId, options) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            this.index.updateState(childId, "stopping");
            return this.finalizeLogicalChild(logical, true);
        }
        const runtime = this.requireRuntime(childId);
        this.index.updateState(childId, "stopping");
        return runtime.shutdown({ signal: "SIGTERM", timeoutMs: options?.timeoutMs ?? 100, force: true });
    }
    /**
     * Waits for the child to exit and returns the shutdown information.
     */
    async waitForExit(childId, timeoutMs) {
        const logical = this.getLogicalChild(childId);
        if (logical) {
            const recorded = this.exitEvents.get(childId);
            if (recorded) {
                return recorded;
            }
            throw new Error(`Logical child ${childId} is still active`);
        }
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
        this.logicalChildren.delete(childId);
        this.messageCounters.delete(childId);
        this.exitEvents.delete(childId);
        this.clearIdleWatchdog(childId);
        this.detachEventBridge(childId);
        this.detachChildLogRecorder(childId);
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
        for (const [childId, listener] of this.childLogRecorders.entries()) {
            const runtime = this.runtimes.get(childId);
            runtime?.off("message", listener);
        }
        this.childLogRecorders.clear();
        this.runtimes.clear();
        this.logicalChildren.clear();
        this.messageCounters.clear();
        this.exitEvents.clear();
        for (const dispose of this.childEventBridges.values()) {
            try {
                dispose();
            }
            catch {
                // Ignore bridge teardown errors during shutdown.
            }
        }
        this.childEventBridges.clear();
        for (const timer of this.watchdogs.values()) {
            runtimeTimers.clearInterval(timer);
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
    /** Returns the logical HTTP session if registered. */
    getLogicalChild(childId) {
        return this.logicalChildren.get(childId);
    }
    /** Builds a runtime status snapshot for logical HTTP children. */
    buildLogicalRuntimeStatus(session) {
        return {
            childId: session.childId,
            pid: -1,
            command: "http-loopback",
            args: [],
            workdir: session.workdir,
            startedAt: session.startedAt,
            lastHeartbeatAt: session.lastHeartbeatAt,
            lifecycle: "running",
            closed: false,
            exit: null,
            resourceUsage: null,
        };
    }
    /** Persists the manifest describing a logical HTTP child. */
    async writeLogicalManifest(session) {
        const manifest = {
            childId: session.childId,
            command: "http-loopback",
            args: [],
            pid: -1,
            startedAt: new Date(session.startedAt).toISOString(),
            workdir: session.workdir,
            workspace: session.workdir,
            logs: { child: session.logPath },
            envKeys: [],
            metadata: session.metadata,
            limits: session.limits,
            role: session.role,
            tools_allow: session.allowedTools,
            endpoint: session.endpoint,
            ...session.manifestExtras,
        };
        await this.fileSystem.writeFileUtf8(session.manifestPath, JSON.stringify(manifest, null, 2));
    }
    /** Merges extra manifest fields while filtering reserved keys. */
    mergeLogicalManifestExtras(session, extras) {
        if (!extras || Object.keys(extras).length === 0) {
            return;
        }
        const merged = { ...session.manifestExtras };
        for (const [key, value] of Object.entries(extras)) {
            if (key === "role" || key === "limits") {
                continue;
            }
            merged[key] = structuredClone(value);
        }
        session.manifestExtras = merged;
    }
    /** Records exit information and removes the logical child from the supervisor. */
    finalizeLogicalChild(session, forced) {
        const durationMs = Math.max(0, Date.now() - session.startedAt);
        this.index.recordExit(session.childId, {
            code: 0,
            signal: null,
            forced,
            at: Date.now(),
            reason: forced ? "logical_child_forced" : "logical_child_completed",
        });
        const result = { code: 0, signal: null, forced, durationMs };
        this.exitEvents.set(session.childId, result);
        this.logicalChildren.delete(session.childId);
        return result;
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
        active += this.logicalChildren.size;
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
            runtimeTimers.clearInterval(existing);
        }
        const interval = Math.min(this.idleCheckIntervalMs, this.idleTimeoutMs || this.idleCheckIntervalMs);
        const timer = runtimeTimers.setInterval(() => {
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
            runtimeTimers.clearInterval(timer);
            this.watchdogs.delete(childId);
        }
    }
    /** Detaches the event bridge associated with the child, if any. */
    detachEventBridge(childId) {
        const dispose = this.childEventBridges.get(childId);
        if (!dispose) {
            return;
        }
        try {
            dispose();
        }
        finally {
            this.childEventBridges.delete(childId);
        }
    }
    /** Detaches the log recorder associated with the child, if any. */
    detachChildLogRecorder(childId) {
        const listener = this.childLogRecorders.get(childId);
        if (!listener) {
            return;
        }
        try {
            this.runtimes.get(childId)?.off("message", listener);
        }
        finally {
            this.childLogRecorders.delete(childId);
        }
    }
}
//# sourceMappingURL=childSupervisor.js.map