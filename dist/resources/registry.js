import { EventEmitter } from "node:events";
/** Base error emitted by the resource registry. */
export class ResourceRegistryError extends Error {
    code;
    hint;
    details;
    constructor(code, message, hint, details) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.details = details;
        this.name = "ResourceRegistryError";
    }
}
/** Error raised when attempting to resolve an unknown resource. */
export class ResourceNotFoundError extends ResourceRegistryError {
    constructor(uri) {
        super("E-RES-NOT_FOUND", `resource '${uri}' does not exist`);
        this.name = "ResourceNotFoundError";
    }
}
/** Error raised when a watch operation is not supported for the URI. */
export class ResourceWatchUnsupportedError extends ResourceRegistryError {
    constructor(uri) {
        super("E-RES-UNSUPPORTED", `resource '${uri}' cannot be watched`, "watch_not_supported");
        this.name = "ResourceWatchUnsupportedError";
    }
}
/** Utility ensuring limits remain sane. */
function clampPositive(value, fallback) {
    if (!value || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.floor(value);
}
/** Creates a defensive deep clone so callers cannot mutate stored state. */
function clone(value) {
    return structuredClone(value);
}
/** Extract the namespace portion of a blackboard key. */
function extractNamespace(key) {
    const separators = [":", "/", "|"]; // keep flexible to accommodate multiple conventions
    for (const separator of separators) {
        const index = key.indexOf(separator);
        if (index > 0) {
            return key.slice(0, index);
        }
    }
    return key;
}
/** Maintains deterministic MCP resource metadata and snapshots. */
export class ResourceRegistry {
    graphHistories = new Map();
    graphSnapshots = new Map();
    runHistories = new Map();
    childHistories = new Map();
    runHistoryLimit;
    childLogHistoryLimit;
    blackboard;
    constructor(options = {}) {
        this.runHistoryLimit = clampPositive(options.runHistoryLimit, 500);
        this.childLogHistoryLimit = clampPositive(options.childLogHistoryLimit, 500);
        this.blackboard = options.blackboard ?? null;
    }
    /**
     * Records a transaction snapshot so clients can inspect the base version even
     * if the transaction later aborts.
     */
    recordGraphSnapshot(input) {
        const normalised = this.getOrCreateSnapshotBucket(input.graphId);
        const snapshot = {
            txId: input.txId,
            graphId: input.graphId,
            baseVersion: input.baseVersion,
            startedAt: input.startedAt,
            state: "pending",
            committedAt: null,
            finalVersion: null,
            baseGraph: clone(input.graph),
            finalGraph: null,
        };
        normalised.set(input.txId, snapshot);
    }
    /** Marks a transaction snapshot as committed and stores the resulting graph. */
    markGraphSnapshotCommitted(input) {
        const bucket = this.graphSnapshots.get(input.graphId);
        if (!bucket) {
            return;
        }
        const snapshot = bucket.get(input.txId);
        if (!snapshot) {
            return;
        }
        snapshot.state = "committed";
        snapshot.committedAt = input.committedAt;
        snapshot.finalVersion = input.finalVersion;
        snapshot.finalGraph = clone(input.finalGraph);
        bucket.set(input.txId, snapshot);
    }
    /** Marks a transaction snapshot as rolled back. */
    markGraphSnapshotRolledBack(graphId, txId) {
        const bucket = this.graphSnapshots.get(graphId);
        if (!bucket) {
            return;
        }
        const snapshot = bucket.get(txId);
        if (!snapshot) {
            return;
        }
        snapshot.state = "rolled_back";
        snapshot.committedAt = null;
        snapshot.finalVersion = null;
        snapshot.finalGraph = null;
        bucket.set(txId, snapshot);
    }
    /** Records a committed graph version. */
    recordGraphVersion(input) {
        if (!input.graphId) {
            return;
        }
        const history = this.getOrCreateGraphHistory(input.graphId);
        const record = {
            version: input.version,
            committedAt: input.committedAt,
            graph: clone(input.graph),
        };
        history.versions.set(input.version, record);
        if (input.version >= history.latestVersion) {
            history.latestVersion = input.version;
        }
        this.graphHistories.set(input.graphId, history);
    }
    /** Records an orchestrator event correlated with a run identifier. */
    recordRunEvent(runId, event) {
        if (!runId.trim()) {
            return;
        }
        const history = this.getOrCreateRunHistory(runId);
        const payload = {
            seq: event.seq,
            ts: event.ts,
            kind: event.kind,
            level: event.level,
            jobId: event.jobId ?? null,
            childId: event.childId ?? null,
            payload: clone(event.payload ?? null),
        };
        history.events.push(payload);
        history.lastSeq = Math.max(history.lastSeq, payload.seq);
        if (history.events.length > this.runHistoryLimit) {
            history.events.splice(0, history.events.length - this.runHistoryLimit);
        }
        history.emitter.emit("event", payload);
    }
    /** Records a log entry produced by a child runtime. */
    recordChildLogEntry(childId, entry) {
        if (!childId.trim()) {
            return;
        }
        const history = this.getOrCreateChildHistory(childId);
        const seq = history.lastSeq + 1;
        const record = {
            seq,
            ts: entry.ts,
            stream: entry.stream,
            message: entry.message,
        };
        history.entries.push(record);
        history.lastSeq = seq;
        if (history.entries.length > this.childLogHistoryLimit) {
            history.entries.splice(0, history.entries.length - this.childLogHistoryLimit);
        }
        history.emitter.emit("event", record);
    }
    /**
     * Returns a deterministic list of URIs. The entries are sorted to guarantee a
     * stable contract for clients performing prefix scans.
     */
    list(prefix) {
        const entries = [];
        for (const [graphId, history] of this.graphHistories.entries()) {
            entries.push({
                uri: `sc://graphs/${graphId}`,
                kind: "graph",
                metadata: { latest_version: history.latestVersion },
            });
            for (const version of history.versions.keys()) {
                entries.push({
                    uri: `sc://graphs/${graphId}@v${version}`,
                    kind: "graph_version",
                });
            }
        }
        for (const [graphId, bucket] of this.graphSnapshots.entries()) {
            for (const snapshot of bucket.values()) {
                entries.push({
                    uri: `sc://snapshots/${graphId}/${snapshot.txId}`,
                    kind: "snapshot",
                    metadata: { state: snapshot.state, base_version: snapshot.baseVersion },
                });
            }
        }
        for (const runId of this.runHistories.keys()) {
            entries.push({ uri: `sc://runs/${runId}/events`, kind: "run_events" });
        }
        for (const childId of this.childHistories.keys()) {
            entries.push({ uri: `sc://children/${childId}/logs`, kind: "child_logs" });
        }
        for (const namespace of this.listBlackboardNamespaces()) {
            entries.push({ uri: `sc://blackboard/${namespace}`, kind: "blackboard_namespace" });
        }
        const filtered = prefix ? entries.filter((entry) => entry.uri.startsWith(prefix)) : entries;
        return filtered.sort((a, b) => a.uri.localeCompare(b.uri));
    }
    /** Returns the materialised payload for the requested URI. */
    read(uri) {
        const parsed = this.parseUri(uri);
        switch (parsed.kind) {
            case "graph": {
                const history = this.graphHistories.get(parsed.graphId);
                if (!history || history.latestVersion === 0) {
                    throw new ResourceNotFoundError(uri);
                }
                const record = history.versions.get(history.latestVersion);
                if (!record) {
                    throw new ResourceNotFoundError(uri);
                }
                return {
                    uri,
                    kind: "graph",
                    payload: {
                        graphId: parsed.graphId,
                        version: record.version,
                        committedAt: record.committedAt,
                        graph: clone(record.graph),
                    },
                };
            }
            case "graph_version": {
                const history = this.graphHistories.get(parsed.graphId);
                const record = history?.versions.get(parsed.version ?? -1);
                if (!record) {
                    throw new ResourceNotFoundError(uri);
                }
                return {
                    uri,
                    kind: "graph_version",
                    payload: {
                        graphId: parsed.graphId,
                        version: record.version,
                        committedAt: record.committedAt,
                        graph: clone(record.graph),
                    },
                };
            }
            case "snapshot": {
                const bucket = this.graphSnapshots.get(parsed.graphId);
                const snapshot = bucket?.get(parsed.txId ?? "");
                if (!snapshot) {
                    throw new ResourceNotFoundError(uri);
                }
                return {
                    uri,
                    kind: "snapshot",
                    payload: clone(snapshot),
                };
            }
            case "run_events": {
                const history = this.runHistories.get(parsed.runId ?? "");
                if (!history) {
                    throw new ResourceNotFoundError(uri);
                }
                return {
                    uri,
                    kind: "run_events",
                    payload: { runId: parsed.runId, events: history.events.map((evt) => clone(evt)) },
                };
            }
            case "child_logs": {
                const history = this.childHistories.get(parsed.childId ?? "");
                if (!history) {
                    throw new ResourceNotFoundError(uri);
                }
                return {
                    uri,
                    kind: "child_logs",
                    payload: { childId: parsed.childId, logs: history.entries.map((entry) => clone(entry)) },
                };
            }
            case "blackboard_namespace": {
                if (!this.blackboard) {
                    throw new ResourceNotFoundError(uri);
                }
                const entries = this.blackboard
                    .query()
                    .filter((entry) => extractNamespace(entry.key) === parsed.namespace)
                    .map((entry) => clone(entry));
                if (entries.length === 0) {
                    throw new ResourceNotFoundError(uri);
                }
                return {
                    uri,
                    kind: "blackboard_namespace",
                    payload: { namespace: parsed.namespace, entries },
                };
            }
            default:
                throw new ResourceNotFoundError(uri);
        }
    }
    /**
     * Returns a monotonic slice of events/logs associated with the resource.
     * Unsupported resources raise {@link ResourceWatchUnsupportedError}.
     */
    watch(uri, options = {}) {
        const fromSeq = options.fromSeq ?? 0;
        const limit = clampPositive(options.limit, 250);
        const parsed = this.parseUri(uri);
        switch (parsed.kind) {
            case "run_events": {
                const history = this.runHistories.get(parsed.runId ?? "");
                if (!history) {
                    throw new ResourceNotFoundError(uri);
                }
                const events = history.events
                    .filter((event) => event.seq > fromSeq)
                    .sort((a, b) => a.seq - b.seq)
                    .slice(0, limit)
                    .map((event) => clone(event));
                const nextSeq = events.length > 0 ? events[events.length - 1].seq : Math.max(fromSeq, history.lastSeq);
                return { uri, kind: "run_events", events, nextSeq };
            }
            case "child_logs": {
                const history = this.childHistories.get(parsed.childId ?? "");
                if (!history) {
                    throw new ResourceNotFoundError(uri);
                }
                const events = history.entries
                    .filter((entry) => entry.seq > fromSeq)
                    .sort((a, b) => a.seq - b.seq)
                    .slice(0, limit)
                    .map((entry) => clone(entry));
                const nextSeq = events.length > 0 ? events[events.length - 1].seq : Math.max(fromSeq, history.lastSeq);
                return { uri, kind: "child_logs", events, nextSeq };
            }
            default:
                throw new ResourceWatchUnsupportedError(uri);
        }
    }
    getOrCreateGraphHistory(graphId) {
        const existing = this.graphHistories.get(graphId);
        if (existing) {
            return existing;
        }
        const history = { latestVersion: 0, versions: new Map() };
        this.graphHistories.set(graphId, history);
        return history;
    }
    getOrCreateSnapshotBucket(graphId) {
        const existing = this.graphSnapshots.get(graphId);
        if (existing) {
            return existing;
        }
        const bucket = new Map();
        this.graphSnapshots.set(graphId, bucket);
        return bucket;
    }
    getOrCreateRunHistory(runId) {
        const existing = this.runHistories.get(runId);
        if (existing) {
            return existing;
        }
        const history = { events: [], lastSeq: 0, emitter: new EventEmitter() };
        this.runHistories.set(runId, history);
        return history;
    }
    getOrCreateChildHistory(childId) {
        const existing = this.childHistories.get(childId);
        if (existing) {
            return existing;
        }
        const history = { entries: [], lastSeq: 0, emitter: new EventEmitter() };
        this.childHistories.set(childId, history);
        return history;
    }
    listBlackboardNamespaces() {
        if (!this.blackboard) {
            return [];
        }
        const namespaces = new Set();
        for (const entry of this.blackboard.query()) {
            namespaces.add(extractNamespace(entry.key));
        }
        return Array.from(namespaces.values());
    }
    parseUri(uri) {
        if (!uri.startsWith("sc://")) {
            throw new ResourceNotFoundError(uri);
        }
        const body = uri.slice("sc://".length);
        if (body.startsWith("graphs/")) {
            const remainder = body.slice("graphs/".length);
            const [identifier, versionSuffix] = remainder.split("@v");
            if (!identifier) {
                throw new ResourceNotFoundError(uri);
            }
            if (versionSuffix !== undefined) {
                const version = Number(versionSuffix);
                if (!Number.isInteger(version) || version <= 0) {
                    throw new ResourceNotFoundError(uri);
                }
                return { kind: "graph_version", graphId: identifier, version };
            }
            return { kind: "graph", graphId: identifier };
        }
        if (body.startsWith("snapshots/")) {
            const remainder = body.slice("snapshots/".length);
            const [graphId, txId] = remainder.split("/");
            if (!graphId || !txId) {
                throw new ResourceNotFoundError(uri);
            }
            return { kind: "snapshot", graphId, txId };
        }
        if (body.startsWith("runs/") && body.endsWith("/events")) {
            const runId = body.slice("runs/".length, body.length - "/events".length);
            if (!runId) {
                throw new ResourceNotFoundError(uri);
            }
            return { kind: "run_events", runId };
        }
        if (body.startsWith("children/") && body.endsWith("/logs")) {
            const childId = body.slice("children/".length, body.length - "/logs".length);
            if (!childId) {
                throw new ResourceNotFoundError(uri);
            }
            return { kind: "child_logs", childId };
        }
        if (body.startsWith("blackboard/")) {
            const namespace = body.slice("blackboard/".length);
            if (!namespace) {
                throw new ResourceNotFoundError(uri);
            }
            return { kind: "blackboard_namespace", namespace };
        }
        throw new ResourceNotFoundError(uri);
    }
}
