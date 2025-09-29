import { randomUUID } from "crypto";
import { startChildRuntime, } from "./childRuntime.js";
import { ChildrenIndex } from "./state/childrenIndex.js";
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
    constructor(options) {
        this.childrenRoot = options.childrenRoot;
        this.defaultCommand = options.defaultCommand;
        this.defaultArgs = options.defaultArgs ? [...options.defaultArgs] : [];
        this.defaultEnv = { ...(options.defaultEnv ?? {}) };
        this.index = options.index ?? new ChildrenIndex();
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
        runtime
            .waitForExit()
            .then((event) => {
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
        const childId = options.childId ?? `child_${randomUUID()}`;
        if (this.runtimes.has(childId)) {
            throw new Error(`A runtime is already registered for ${childId}`);
        }
        const command = options.command ?? this.defaultCommand;
        const args = options.args ? [...options.args] : [...this.defaultArgs];
        const env = { ...this.defaultEnv, ...(options.env ?? {}) };
        const runtime = await startChildRuntime({
            childId,
            childrenRoot: this.childrenRoot,
            command,
            args,
            env,
            metadata: options.metadata,
            manifestExtras: options.manifestExtras,
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
        return runtime.shutdown({ signal: "SIGTERM", timeoutMs: options?.timeoutMs ?? 100 });
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
    nextMessageIndex(childId) {
        const current = this.messageCounters.get(childId) ?? 0;
        const next = current + 1;
        this.messageCounters.set(childId, next);
        return next;
    }
}
