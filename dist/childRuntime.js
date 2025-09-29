import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { listArtifacts } from "./artifacts.js";
import { childWorkspacePath, ensureDirectory } from "./paths.js";
/**
 * Wraps a spawned child process and exposes helpers for messaging, logging and
 * heartbeat tracking. The class is intentionally event based so it can be
 * composed easily with orchestrator tools.
 */
export class ChildRuntime extends EventEmitter {
    childId;
    command;
    args;
    childrenRoot;
    workdir;
    logPath;
    manifestPath;
    metadata;
    envKeys;
    child;
    logStream;
    messages = [];
    spawnPromise;
    spawnSettled = false;
    spawnResolve = null;
    spawnReject = null;
    exitPromise;
    exitResolve = null;
    exitEvent = null;
    stdoutBuffer = "";
    stderrBuffer = "";
    forcedKill = false;
    closed = false;
    startedAt;
    lastHeartbeatAt = null;
    constructor(params) {
        super();
        this.childId = params.childId;
        this.command = params.command;
        this.args = params.args;
        this.childrenRoot = params.childrenRoot;
        this.workdir = params.workdir;
        this.logPath = params.logPath;
        this.manifestPath = params.manifestPath;
        this.metadata = params.metadata;
        this.envKeys = params.envKeys;
        this.child = params.child;
        this.startedAt = Date.now();
        this.logStream = createWriteStream(this.logPath, { flags: "a" });
        this.spawnPromise = new Promise((resolve, reject) => {
            this.spawnResolve = resolve;
            this.spawnReject = reject;
        });
        this.exitPromise = new Promise((resolve) => {
            this.exitResolve = resolve;
        });
        this.setupListeners();
    }
    /**
     * Number of the process created by the runtime.
     */
    get pid() {
        return this.child.pid ?? -1;
    }
    /**
     * Timestamp of the last IO event observed for the child.
     */
    get lastHeartbeat() {
        return this.lastHeartbeatAt;
    }
    /**
     * Accessor for the recorded messages (JSON lines emitted by the child).
     */
    getRecordedMessages() {
        this.flushStdout();
        this.flushStderr();
        return this.messages.map((message) => ({ ...message }));
    }
    /**
     * Streams messages recorded so far. The method clamps pagination bounds and
     * performs stream filtering before cloning the payloads to avoid exposing
     * mutable references outside of the runtime.
     */
    streamMessages(options = {}) {
        this.flushStdout();
        this.flushStderr();
        const totalMessages = this.messages.length;
        const after = options.afterSequence ?? -1;
        if (!Number.isInteger(after) || after < -1) {
            throw new Error("afterSequence must be an integer >= -1");
        }
        const rawLimit = options.limit ?? 50;
        if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
            throw new Error("limit must be a positive integer");
        }
        const limit = Math.min(rawLimit, 200);
        const streamsFilter = options.streams ? new Set(options.streams) : null;
        if (streamsFilter && streamsFilter.size === 0) {
            throw new Error("streams filter must contain at least one entry");
        }
        const slice = [];
        let lastSequence = after;
        for (let index = Math.max(0, after + 1); index < totalMessages; index += 1) {
            const candidate = this.messages[index];
            if (streamsFilter && !streamsFilter.has(candidate.stream)) {
                continue;
            }
            slice.push({ ...candidate });
            lastSequence = candidate.sequence;
            if (slice.length >= limit) {
                break;
            }
        }
        let hasMore = false;
        if (lastSequence < totalMessages - 1) {
            for (let index = lastSequence + 1; index < totalMessages; index += 1) {
                const candidate = this.messages[index];
                if (!streamsFilter || streamsFilter.has(candidate.stream)) {
                    hasMore = true;
                    break;
                }
            }
        }
        return {
            childId: this.childId,
            totalMessages,
            matchedMessages: slice.length,
            hasMore,
            nextCursor: slice.length > 0 ? slice[slice.length - 1].sequence : lastSequence >= 0 ? lastSequence : null,
            messages: slice,
        };
    }
    /**
     * Reports the current execution status of the child process including the
     * most recent heartbeat and the exit information when available.
     */
    getStatus() {
        let resourceUsage = null;
        const resourceUsageFn = this.child.resourceUsage;
        if (typeof resourceUsageFn === "function") {
            try {
                resourceUsage = resourceUsageFn.call(this.child);
            }
            catch {
                resourceUsage = null;
            }
        }
        let lifecycle = "spawning";
        if (this.spawnSettled && !this.exitEvent) {
            lifecycle = "running";
        }
        else if (this.exitEvent) {
            lifecycle = "exited";
        }
        return {
            childId: this.childId,
            pid: this.pid,
            command: this.command,
            args: [...this.args],
            workdir: this.workdir,
            startedAt: this.startedAt,
            lastHeartbeatAt: this.lastHeartbeatAt,
            lifecycle,
            closed: this.closed,
            exit: this.exitEvent
                ? {
                    code: this.exitEvent.code,
                    signal: this.exitEvent.signal,
                    forced: this.exitEvent.forced,
                    at: this.exitEvent.at,
                }
                : null,
            resourceUsage,
        };
    }
    /**
     * Waits until the underlying process has been spawned successfully.
     */
    async waitUntilSpawned() {
        return this.spawnPromise;
    }
    /**
     * Aggregates all outputs produced by the child so far. This includes
     * buffered messages and the current artifact manifest within the outbox.
     */
    async collectOutputs() {
        this.flushStdout();
        this.flushStderr();
        const artifacts = await listArtifacts(this.childrenRoot, this.childId);
        return {
            childId: this.childId,
            manifestPath: this.manifestPath,
            logPath: this.logPath,
            messages: this.getRecordedMessages(),
            artifacts,
        };
    }
    /**
     * Sends a payload to the child over STDIN. Strings are transmitted as-is
     * while other values are serialised as JSON.
     */
    async send(payload) {
        if (this.closed) {
            throw new Error("Cannot send message to a closed child runtime");
        }
        if (!this.child.stdin || this.child.stdin.destroyed) {
            throw new Error("Child stdin is not available");
        }
        const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
        const line = `${serialized}\n`;
        await new Promise((resolve, reject) => {
            const stream = this.child.stdin;
            const cleanup = () => {
                stream.off("error", onError);
                stream.off("drain", onDrain);
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            stream.once("error", onError);
            const wrote = stream.write(line, (err) => {
                if (err) {
                    cleanup();
                    reject(err);
                }
                else if (wrote) {
                    cleanup();
                    resolve();
                }
            });
            if (!wrote) {
                stream.once("drain", onDrain);
            }
        });
        this.recordInternal("stdin", serialized);
    }
    /**
     * Waits for the next message matching a predicate. Throws after the provided
     * timeout (default 2 seconds).
     */
    async waitForMessage(predicate, timeoutMs = 2000) {
        for (const message of this.messages) {
            if (predicate(message)) {
                return message;
            }
        }
        return new Promise((resolve, reject) => {
            const timer = timeoutMs >= 0 ? setTimeout(() => {
                this.off("message", onMessage);
                reject(new Error(`Timed out after ${timeoutMs}ms while waiting for child message`));
            }, timeoutMs) : null;
            const onMessage = (message) => {
                if (predicate(message)) {
                    if (timer)
                        clearTimeout(timer);
                    this.off("message", onMessage);
                    resolve(message);
                }
            };
            this.on("message", onMessage);
        });
    }
    /**
     * Requests the child to terminate gracefully. If the timeout elapses the
     * child is forcefully killed with SIGKILL.
     */
    async shutdown(options = {}) {
        const { signal = "SIGINT", timeoutMs = 2000 } = options;
        const started = Date.now();
        if (this.closed) {
            const exit = await this.exitPromise;
            return { code: exit.code, signal: exit.signal, forced: exit.forced, durationMs: Date.now() - started };
        }
        this.recordInternal("lifecycle", `shutdown-request:${signal}:${timeoutMs}`);
        try {
            this.child.kill(signal);
        }
        catch (error) {
            this.recordInternal("lifecycle", `kill-error:${error.message}`);
            throw error;
        }
        let exit;
        try {
            exit = await this.waitForExit(timeoutMs);
        }
        catch (err) {
            this.forcedKill = true;
            this.recordInternal("lifecycle", "shutdown-timeout");
            this.child.kill("SIGKILL");
            exit = await this.waitForExit();
        }
        return { code: exit.code, signal: exit.signal, forced: exit.forced, durationMs: Date.now() - started };
    }
    /**
     * Persists a manifest describing the child runtime.
     */
    async writeManifest(extras = {}) {
        const manifest = {
            childId: this.childId,
            command: this.command,
            args: this.args,
            pid: this.pid,
            startedAt: new Date(this.startedAt).toISOString(),
            workdir: this.workdir,
            logs: {
                child: this.logPath,
            },
            envKeys: this.envKeys,
            metadata: this.metadata,
            ...extras,
        };
        await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }
    /**
     * Resolves once the underlying process exits.
     */
    async waitForExit(timeoutMs) {
        if (timeoutMs === undefined) {
            return this.exitPromise;
        }
        return new Promise((resolve, reject) => {
            const timer = timeoutMs >= 0 ? setTimeout(() => {
                reject(new Error("Timed out waiting for child exit"));
            }, timeoutMs) : null;
            this.exitPromise
                .then((event) => {
                if (timer)
                    clearTimeout(timer);
                resolve(event);
            })
                .catch((error) => {
                if (timer)
                    clearTimeout(timer);
                reject(error);
            });
        });
    }
    /**
     * Releases resources (listeners and log stream).
     */
    cleanup() {
        if (!this.closed) {
            this.closed = true;
            if (this.child.stdout) {
                this.child.stdout.removeAllListeners();
            }
            if (this.child.stderr) {
                this.child.stderr.removeAllListeners();
            }
            if (this.child.stdin) {
                this.child.stdin.removeAllListeners();
            }
            this.logStream.end();
        }
    }
    setupListeners() {
        if (this.child.stdout) {
            this.child.stdout.setEncoding("utf8");
            this.child.stdout.on("data", (chunk) => {
                this.consumeStdout(chunk);
            });
            this.child.stdout.on("end", () => {
                this.flushStdout();
            });
        }
        if (this.child.stderr) {
            this.child.stderr.setEncoding("utf8");
            this.child.stderr.on("data", (chunk) => {
                this.consumeStderr(chunk);
            });
            this.child.stderr.on("end", () => {
                this.flushStderr();
            });
        }
        this.child.once("spawn", () => {
            this.spawnSettled = true;
            this.lastHeartbeatAt = Date.now();
            this.recordInternal("lifecycle", "spawned");
            this.spawnResolve?.();
        });
        this.child.on("error", (error) => {
            if (!this.spawnSettled) {
                this.spawnSettled = true;
                this.spawnReject?.(error);
            }
            this.recordInternal("stderr", `process-error:${error.message}`);
            if (!this.exitEvent) {
                const event = {
                    code: null,
                    signal: null,
                    at: Date.now(),
                    forced: this.forcedKill,
                    error,
                };
                this.exitEvent = event;
                this.exitResolve?.(event);
            }
            this.cleanup();
        });
        this.child.once("exit", (code, signal) => {
            const event = {
                code,
                signal,
                at: Date.now(),
                forced: this.forcedKill,
                error: null,
            };
            this.exitEvent = event;
            this.recordInternal("lifecycle", `exit:${code ?? "null"}:${signal ?? "null"}`);
            this.exitResolve?.(event);
            this.cleanup();
        });
    }
    consumeStdout(chunk) {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            this.recordLine("stdout", rawLine);
            newlineIndex = this.stdoutBuffer.indexOf("\n");
        }
    }
    flushStdout() {
        if (this.stdoutBuffer.length > 0) {
            this.recordLine("stdout", this.stdoutBuffer);
            this.stdoutBuffer = "";
        }
    }
    consumeStderr(chunk) {
        this.stderrBuffer += chunk;
        let newlineIndex = this.stderrBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const rawLine = this.stderrBuffer.slice(0, newlineIndex);
            this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
            this.recordLine("stderr", rawLine);
            newlineIndex = this.stderrBuffer.indexOf("\n");
        }
    }
    flushStderr() {
        if (this.stderrBuffer.length > 0) {
            this.recordLine("stderr", this.stderrBuffer);
            this.stderrBuffer = "";
        }
    }
    recordLine(stream, line) {
        const cleaned = line.replace(/\r$/, "");
        if (!cleaned.trim()) {
            return;
        }
        this.recordInternal(stream, cleaned);
        const receivedAt = Date.now();
        this.lastHeartbeatAt = receivedAt;
        let parsed = null;
        if (stream === "stdout") {
            try {
                parsed = JSON.parse(cleaned);
            }
            catch {
                parsed = null;
            }
        }
        const sequence = this.messages.length;
        const message = {
            raw: cleaned,
            parsed,
            stream,
            receivedAt,
            sequence,
        };
        this.messages.push(message);
        this.emit("message", message);
    }
    recordInternal(kind, data) {
        const entry = {
            ts: Date.now(),
            kind,
            data,
        };
        this.logStream.write(`${JSON.stringify(entry)}\n`);
    }
}
/**
 * Creates a new child runtime and ensures its workspace exists before the
 * process is spawned.
 */
export async function startChildRuntime(options) {
    const childRoot = await ensureDirectory(options.childrenRoot, options.childId);
    await ensureDirectory(options.childrenRoot, options.childId, "logs");
    await ensureDirectory(options.childrenRoot, options.childId, "outbox");
    await ensureDirectory(options.childrenRoot, options.childId, "inbox");
    const workdir = childRoot;
    const logPath = childWorkspacePath(options.childrenRoot, options.childId, "logs", "child.log");
    const manifestPath = childWorkspacePath(options.childrenRoot, options.childId, "manifest.json");
    const args = options.args ?? [];
    const env = { ...process.env, ...(options.env ?? {}) };
    const child = spawn(options.command, args, {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const runtime = new ChildRuntime({
        childId: options.childId,
        command: options.command,
        args,
        childrenRoot: options.childrenRoot,
        workdir,
        logPath,
        manifestPath,
        metadata: options.metadata ?? {},
        envKeys: Object.keys(env).sort(),
        child,
    });
    await runtime.waitUntilSpawned();
    await runtime.writeManifest(options.manifestExtras ?? {});
    return runtime;
}
/**
 * Pretty printer primarily used by tests for debugging purposes.
 */
export function formatChildMessages(messages) {
    return messages
        .map((message) => `${new Date(message.receivedAt).toISOString()} [${message.stream}#${message.sequence}] ${message.raw} ` +
        (message.parsed ? inspect(message.parsed, { depth: 4 }) : "<raw>"))
        .join("\n");
}
