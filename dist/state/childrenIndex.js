import { inspect } from "node:util";
/**
 * Raised whenever an operation targets an unknown child identifier.
 */
export class UnknownChildError extends Error {
    childId;
    constructor(childId) {
        super(`Unknown child identifier: ${childId}`);
        this.name = "UnknownChildError";
        this.childId = childId;
    }
}
/**
 * Deep clones a mutable record to ensure callers cannot mutate internal state.
 */
function cloneRecord(record) {
    return {
        childId: record.childId,
        pid: record.pid,
        workdir: record.workdir,
        state: record.state,
        createdAt: record.createdAt,
        lastHeartbeatAt: record.lastHeartbeatAt,
        retries: record.retries,
        metadata: { ...record.metadata },
        stoppedAt: record.stoppedAt,
        exitCode: record.exitCode,
        exitSignal: record.exitSignal,
        forcedTermination: record.forcedTermination,
        stopReason: record.stopReason,
    };
}
/**
 * In-memory index of active child processes with lifecycle metadata.
 *
 * The orchestrator relies on this structure to expose monitoring features and
 * to persist a lightweight snapshot into the `GraphState`. The index is fully
 * synchronous and therefore trivial to snapshot/restore.
 */
export class ChildrenIndex {
    children = new Map();
    /**
     * Registers a new child and returns the public snapshot.
     */
    registerChild(options) {
        const createdAt = options.createdAt ?? Date.now();
        const record = {
            childId: options.childId,
            pid: options.pid,
            workdir: options.workdir,
            state: options.state ?? "starting",
            createdAt,
            lastHeartbeatAt: null,
            retries: 0,
            metadata: { ...(options.metadata ?? {}) },
            stoppedAt: null,
            exitCode: null,
            exitSignal: null,
            forcedTermination: false,
            stopReason: null,
        };
        this.children.set(options.childId, record);
        return cloneRecord(record);
    }
    /**
     * Returns a snapshot of the child if it exists.
     */
    getChild(childId) {
        const record = this.children.get(childId);
        return record ? cloneRecord(record) : undefined;
    }
    /**
     * Returns the mutable record or throws when the child does not exist.
     */
    requireChild(childId) {
        const record = this.children.get(childId);
        if (!record) {
            throw new UnknownChildError(childId);
        }
        return record;
    }
    /**
     * Updates the lifecycle state of a child.
     */
    updateState(childId, state) {
        const record = this.requireChild(childId);
        record.state = state;
        return cloneRecord(record);
    }
    /**
     * Records the last observed heartbeat for the child.
     */
    updateHeartbeat(childId, timestamp) {
        const record = this.requireChild(childId);
        record.lastHeartbeatAt = timestamp ?? Date.now();
        return cloneRecord(record);
    }
    /**
     * Increments the retry counter for the child (used by fan-out planners).
     */
    incrementRetries(childId) {
        const record = this.requireChild(childId);
        record.retries += 1;
        return cloneRecord(record);
    }
    /**
     * Records exit information for a child process.
     */
    recordExit(childId, details) {
        const record = this.requireChild(childId);
        record.exitCode = details.code;
        record.exitSignal = details.signal;
        record.stoppedAt = details.at ?? Date.now();
        record.lastHeartbeatAt = record.stoppedAt;
        record.forcedTermination = details.forced ?? false;
        record.stopReason = details.reason ?? null;
        if (record.forcedTermination) {
            record.state = "killed";
        }
        else if (record.exitCode === 0 && record.exitSignal === null) {
            record.state = "terminated";
        }
        else {
            record.state = "error";
        }
        return cloneRecord(record);
    }
    /**
     * Merges additional metadata for the child.
     */
    mergeMetadata(childId, metadata) {
        const record = this.requireChild(childId);
        record.metadata = { ...record.metadata, ...metadata };
        return cloneRecord(record);
    }
    /**
     * Removes a child from the index.
     */
    removeChild(childId) {
        return this.children.delete(childId);
    }
    /**
     * Clears the index completely (useful for tests).
     */
    clear() {
        this.children.clear();
    }
    /**
     * Returns a snapshot of every tracked child.
     */
    list() {
        return Array.from(this.children.values()).map((record) => cloneRecord(record));
    }
    /**
     * Serialises the index into a minimal structure usable by GraphState.
     */
    serialize() {
        const entries = Array.from(this.children.entries()).map(([childId, record]) => [
            childId,
            {
                state: record.state,
                lastHeartbeatAt: record.lastHeartbeatAt,
                retries: record.retries,
                stoppedAt: record.stoppedAt,
                exitCode: record.exitCode,
                exitSignal: record.exitSignal,
                forcedTermination: record.forcedTermination,
            },
        ]);
        return Object.fromEntries(entries);
    }
    /**
     * Restores the index from a serialised structure.
     */
    restore(snapshot) {
        this.children.clear();
        for (const [childId, raw] of Object.entries(snapshot)) {
            if (typeof raw !== "object" || raw === null) {
                continue;
            }
            const record = {
                childId,
                pid: -1,
                workdir: "",
                state: "starting",
                createdAt: Date.now(),
                lastHeartbeatAt: typeof raw.lastHeartbeatAt === "number" ? raw.lastHeartbeatAt : null,
                retries: typeof raw.retries === "number" ? raw.retries : 0,
                metadata: {},
                stoppedAt: typeof raw.stoppedAt === "number" ? raw.stoppedAt : null,
                exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
                exitSignal: typeof raw.exitSignal === "string" ? raw.exitSignal : null,
                forcedTermination: Boolean(raw.forcedTermination),
                stopReason: null,
            };
            this.children.set(childId, record);
        }
    }
    /**
     * Debug helper used mainly inside tests.
     */
    toString() {
        const entries = Array.from(this.children.values()).map((record) => cloneRecord(record));
        return inspect(entries, { depth: 4, colors: false });
    }
}
