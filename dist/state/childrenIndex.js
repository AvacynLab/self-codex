import { inspect } from "node:util";
function isSerializedChildRecord(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value;
    if (typeof candidate.state !== "string") {
        return false;
    }
    const lifecycleStates = [
        "starting",
        "ready",
        "running",
        "idle",
        "stopping",
        "terminated",
        "killed",
        "error",
    ];
    if (!lifecycleStates.includes(candidate.state)) {
        return false;
    }
    const isNumberOrNull = (v) => v === null || typeof v === "number";
    const isStringOrNull = (v) => v === null || typeof v === "string";
    if (!isNumberOrNull(candidate.lastHeartbeatAt ?? null)) {
        return false;
    }
    if (typeof candidate.retries !== "number" && candidate.retries !== undefined) {
        return false;
    }
    if (!isNumberOrNull(candidate.endedAt ?? null)) {
        return false;
    }
    if (!isNumberOrNull(candidate.exitCode ?? null)) {
        return false;
    }
    if (!isStringOrNull(candidate.exitSignal ?? null)) {
        return false;
    }
    if (typeof candidate.forcedTermination !== "boolean" && candidate.forcedTermination !== undefined) {
        return false;
    }
    if (candidate.metadata !== undefined && (typeof candidate.metadata !== "object" || candidate.metadata === null)) {
        return false;
    }
    if (!isNumberOrNull(candidate.startedAt ?? null)) {
        return false;
    }
    if (!isStringOrNull(candidate.stopReason ?? null)) {
        return false;
    }
    if (candidate.role !== undefined && !isStringOrNull(candidate.role ?? null)) {
        return false;
    }
    if (candidate.limits !== undefined && typeof candidate.limits !== "object") {
        return false;
    }
    if (!isNumberOrNull(candidate.attachedAt ?? null)) {
        return false;
    }
    return true;
}
/**
 * Raised whenever an operation targets an unknown child identifier.
 */
export class UnknownChildError extends Error {
    childId;
    /** Machine readable error code surfaced to MCP clients. */
    code = "E-CHILD-NOT-FOUND";
    /** Hint describing how the caller can recover from the failure. */
    hint = "unknown_child";
    /** Structured details automatically serialised by the server error helpers. */
    details;
    constructor(childId) {
        super(`Unknown child identifier: ${childId}`);
        this.name = "UnknownChildError";
        this.childId = childId;
        this.details = { child_id: childId };
    }
}
/**
 * Raised when attempting to register a child twice.
 */
export class DuplicateChildError extends Error {
    childId;
    /** Error code signalling that the requested child already exists. */
    code = "E-CHILD-DUPLICATE";
    /** Hint guiding clients towards idempotent create operations. */
    hint = "duplicate_child";
    /** Contextual metadata included in structured tool errors. */
    details;
    constructor(childId) {
        super(`Child already registered: ${childId}`);
        this.name = "DuplicateChildError";
        this.childId = childId;
        this.details = { child_id: childId };
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
        startedAt: record.startedAt,
        lastHeartbeatAt: record.lastHeartbeatAt,
        retries: record.retries,
        metadata: { ...record.metadata },
        endedAt: record.endedAt,
        exitCode: record.exitCode,
        exitSignal: record.exitSignal,
        forcedTermination: record.forcedTermination,
        stopReason: record.stopReason,
        role: record.role,
        limits: record.limits ? { ...record.limits } : null,
        attachedAt: record.attachedAt,
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
        if (this.children.has(options.childId)) {
            throw new DuplicateChildError(options.childId);
        }
        const startedAt = options.startedAt ?? Date.now();
        const record = {
            childId: options.childId,
            pid: options.pid,
            workdir: options.workdir,
            state: options.state ?? "starting",
            startedAt,
            lastHeartbeatAt: null,
            retries: 0,
            metadata: { ...(options.metadata ?? {}) },
            endedAt: null,
            exitCode: null,
            exitSignal: null,
            forcedTermination: false,
            stopReason: null,
            role: options.role ?? null,
            limits: options.limits ? { ...options.limits } : null,
            attachedAt: options.attachedAt ?? null,
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
        record.endedAt = details.at ?? Date.now();
        record.lastHeartbeatAt = record.endedAt;
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
    /** Updates the advertised role for a child while keeping metadata in sync. */
    setRole(childId, role) {
        const record = this.requireChild(childId);
        record.role = role ?? null;
        if (role === null) {
            if ("role" in record.metadata) {
                const { role: _removed, ...rest } = record.metadata;
                record.metadata = rest;
            }
        }
        else {
            record.metadata = { ...record.metadata, role };
        }
        return cloneRecord(record);
    }
    /** Updates the declarative limits tracked for a child runtime. */
    setLimits(childId, limits) {
        const record = this.requireChild(childId);
        record.limits = limits ? { ...limits } : null;
        if (limits === null) {
            if ("limits" in record.metadata) {
                const { limits: _removed, ...rest } = record.metadata;
                record.metadata = rest;
            }
        }
        else {
            record.metadata = { ...record.metadata, limits: structuredClone(limits) };
        }
        return cloneRecord(record);
    }
    /** Marks the child as re-attached and records the timestamp for observability. */
    markAttached(childId, timestamp) {
        const record = this.requireChild(childId);
        record.attachedAt = timestamp ?? Date.now();
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
                endedAt: record.endedAt,
                exitCode: record.exitCode,
                exitSignal: record.exitSignal,
                forcedTermination: record.forcedTermination,
                startedAt: record.startedAt,
                metadata: { ...record.metadata },
                stopReason: record.stopReason,
                role: record.role,
                limits: record.limits ? { ...record.limits } : null,
                attachedAt: record.attachedAt,
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
            if (!isSerializedChildRecord(raw)) {
                continue;
            }
            const record = {
                childId,
                pid: -1,
                workdir: "",
                state: raw.state,
                startedAt: raw.startedAt ?? Date.now(),
                lastHeartbeatAt: raw.lastHeartbeatAt ?? null,
                retries: raw.retries ?? 0,
                metadata: { ...(raw.metadata ?? {}) },
                endedAt: raw.endedAt ?? null,
                exitCode: raw.exitCode ?? null,
                exitSignal: raw.exitSignal ?? null,
                forcedTermination: raw.forcedTermination ?? false,
                stopReason: raw.stopReason ?? null,
                role: raw.role ?? null,
                limits: raw.limits ? { ...raw.limits } : null,
                attachedAt: raw.attachedAt ?? null,
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
