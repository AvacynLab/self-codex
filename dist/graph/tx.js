import { randomUUID } from "node:crypto";
/** Metadata key storing the timestamp of the last successful transaction commit. */
const TX_COMMITTED_AT_METADATA_KEY = "__txCommittedAt";
/**
 * Generic error thrown by the transaction manager whenever an unexpected
 * situation occurs (unknown transaction, invalid graph id, ...).
 */
export class GraphTransactionError extends Error {
    constructor(message) {
        super(message);
        this.name = "GraphTransactionError";
    }
}
/** Error thrown when attempting to commit using a stale base version. */
export class GraphVersionConflictError extends GraphTransactionError {
    code = "E-REWRITE-CONFLICT";
    details;
    constructor(graphId, expected, found) {
        super(`graph '${graphId}' diverged: expected version ${expected} but received ${found}`);
        this.name = "GraphVersionConflictError";
        this.details = { graphId, expected, found };
    }
}
/** Error thrown when a caller references a transaction identifier that expired. */
export class UnknownTransactionError extends GraphTransactionError {
    constructor(txId) {
        super(`transaction '${txId}' is not active`);
        this.name = "UnknownTransactionError";
    }
}
/** Error thrown when attempting to interact with an expired transaction. */
export class GraphTransactionExpiredError extends GraphTransactionError {
    code = "E-TX-EXPIRED";
    details;
    constructor(txId, expiredAt, now) {
        super(`transaction '${txId}' expired at ${new Date(expiredAt).toISOString()}`);
        this.name = "GraphTransactionExpiredError";
        this.details = { txId, expiredAt, now };
    }
}
/**
 * Manage transactional snapshots for normalised graphs. The manager enforces a
 * strict single-writer policy: concurrent transactions must observe the latest
 * committed version otherwise the commit will fail with a conflict.
 */
export class GraphTransactionManager {
    /** Latest committed state tracked per graph identifier. */
    states = new Map();
    /** Active transaction records keyed by their identifier. */
    transactions = new Map();
    /**
     * Open a new transaction for the provided graph. The caller receives a fresh
     * working copy which can be mutated freely before invoking {@link commit} or
     * {@link rollback}.
     */
    begin(graph, options = {}) {
        if (!graph.graphId || graph.graphId.trim().length === 0) {
            throw new GraphTransactionError("graph id must be provided before opening a transaction");
        }
        const state = this.states.get(graph.graphId);
        if (state) {
            if (state.version !== graph.graphVersion) {
                throw new GraphVersionConflictError(graph.graphId, state.version, graph.graphVersion);
            }
            state.graph = this.cloneGraph(graph);
        }
        else {
            const committedAt = Date.now();
            this.states.set(graph.graphId, {
                version: graph.graphVersion,
                committedAt,
                graph: this.cloneGraph(graph),
            });
        }
        const txId = randomUUID();
        const startedAt = Date.now();
        const snapshot = this.cloneGraph(graph);
        const workingCopy = this.cloneGraph(graph);
        const owner = normaliseOwner(options.owner);
        const note = normaliseNote(options.note);
        const expiresAt = normaliseExpiry(startedAt, options.ttlMs);
        const record = {
            txId,
            graphId: graph.graphId,
            baseVersion: graph.graphVersion,
            snapshot,
            workingCopy,
            startedAt,
            owner,
            note,
            expiresAt,
            lastTouchedAt: startedAt,
        };
        this.transactions.set(txId, record);
        return {
            txId,
            graphId: graph.graphId,
            baseVersion: graph.graphVersion,
            startedAt,
            owner,
            note,
            expiresAt,
            workingCopy: this.cloneGraph(graph),
        };
    }
    /**
     * Commit the transaction identified by {@link txId}. The provided graph must
     * originate from the working copy returned by {@link begin}. The manager will
     * increment the graph version, stamp the commit timestamp, and update the
     * latest committed snapshot.
     */
    commit(txId, updatedGraph) {
        const now = Date.now();
        const record = this.getActiveTransaction(txId, now);
        if (updatedGraph.graphId !== record.graphId) {
            throw new GraphTransactionError(`graph id mismatch: expected '${record.graphId}' but received '${updatedGraph.graphId}'`);
        }
        const state = this.states.get(record.graphId);
        if (!state) {
            throw new GraphTransactionError(`no committed state registered for graph '${record.graphId}'`);
        }
        if (state.version !== record.baseVersion) {
            throw new GraphVersionConflictError(record.graphId, state.version, record.baseVersion);
        }
        const expectedVersion = record.baseVersion;
        const providedVersion = updatedGraph.graphVersion;
        if (providedVersion < expectedVersion || providedVersion > expectedVersion + 1) {
            throw new GraphVersionConflictError(record.graphId, expectedVersion, providedVersion);
        }
        const mutated = !this.graphsEqual(record.snapshot, updatedGraph);
        const committedAt = mutated ? now : state.committedAt;
        const nextVersion = mutated ? expectedVersion + 1 : state.version;
        let finalGraph;
        if (mutated) {
            finalGraph = this.cloneGraph(updatedGraph);
            finalGraph.graphVersion = nextVersion;
            finalGraph.metadata = {
                ...finalGraph.metadata,
                [TX_COMMITTED_AT_METADATA_KEY]: committedAt,
            };
            state.version = nextVersion;
            state.committedAt = committedAt;
            state.graph = this.cloneGraph(finalGraph);
        }
        else {
            finalGraph = this.cloneGraph(state.graph);
        }
        // The transaction can only be retired once the graph has been safely
        // persisted. Keeping the record alive until this point allows callers to
        // recover via {@link rollback} when a conflict occurs during validation.
        this.transactions.delete(txId);
        return {
            txId,
            graphId: record.graphId,
            version: nextVersion,
            committedAt,
            graph: finalGraph,
        };
    }
    /**
     * Abort the transaction identified by {@link txId}, restoring the snapshot
     * captured at {@link begin}. The caller receives the pristine state so it can
     * be re-used or inspected safely.
     */
    rollback(txId) {
        const now = Date.now();
        const record = this.getActiveTransaction(txId, now);
        this.transactions.delete(txId);
        const rolledBackAt = now;
        return {
            txId,
            graphId: record.graphId,
            version: record.baseVersion,
            rolledBackAt,
            snapshot: this.cloneGraph(record.snapshot),
        };
    }
    /** Retrieve the number of active transactions, useful for diagnostics. */
    countActiveTransactions() {
        return this.transactions.size;
    }
    /** Returns a clone of the in-memory working copy for the transaction. */
    getWorkingCopy(txId) {
        const now = Date.now();
        const record = this.getActiveTransaction(txId, now, true);
        return this.cloneGraph(record.workingCopy);
    }
    /** Replaces the working copy for a transaction after applying mutations. */
    setWorkingCopy(txId, graph) {
        const now = Date.now();
        const record = this.getActiveTransaction(txId, now, true);
        record.workingCopy = this.cloneGraph(graph);
        this.transactions.set(txId, record);
    }
    /** Returns metadata about an active transaction. */
    describe(txId) {
        const now = Date.now();
        const record = this.getActiveTransaction(txId, now);
        return {
            txId: record.txId,
            graphId: record.graphId,
            baseVersion: record.baseVersion,
            startedAt: record.startedAt,
            owner: record.owner,
            note: record.note,
            expiresAt: record.expiresAt,
            lastTouchedAt: record.lastTouchedAt,
        };
    }
    /** Returns the latest committed snapshot stored for the graph. */
    getCommittedState(graphId) {
        const state = this.states.get(graphId);
        if (!state) {
            return null;
        }
        return {
            graphId,
            version: state.version,
            committedAt: state.committedAt,
            graph: this.cloneGraph(state.graph),
        };
    }
    getActiveTransaction(txId, now = Date.now(), touch = false) {
        const record = this.transactions.get(txId);
        if (!record) {
            throw new UnknownTransactionError(txId);
        }
        if (record.expiresAt !== null && record.expiresAt <= now) {
            this.transactions.delete(txId);
            throw new GraphTransactionExpiredError(txId, record.expiresAt, now);
        }
        if (touch) {
            record.lastTouchedAt = now;
            this.transactions.set(txId, record);
        }
        return record;
    }
    /** Shallow helper to deep-clone a normalised graph without sharing references. */
    cloneGraph(graph) {
        return structuredClone(graph);
    }
    /**
     * Compare two graphs for structural equality. The normalised representation
     * preserves node/edge ordering which makes a simple JSON serialisation safe
     * for equality checks without introducing a heavy diff dependency.
     */
    graphsEqual(first, second) {
        return JSON.stringify(first) === JSON.stringify(second);
    }
}
function normaliseOwner(owner) {
    if (!owner) {
        return null;
    }
    const trimmed = owner.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function normaliseNote(note) {
    if (!note) {
        return null;
    }
    const trimmed = note.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function normaliseExpiry(startedAt, ttlMs) {
    if (ttlMs === null || ttlMs === undefined) {
        return null;
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        return null;
    }
    return startedAt + Math.floor(ttlMs);
}
