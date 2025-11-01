import { randomUUID } from "node:crypto";
import process from "node:process";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { readOptionalInt } from "../config/env.js";
import { snapshotTake } from "../state/snapshot.js";
import { ERROR_CODES } from "../types.js";
import { recordOperation } from "./oplog.js";
import { fireAndForgetGraphWal } from "./wal.js";
import { assertValidGraph } from "./validate.js";
/** Metadata key storing the timestamp of the last successful transaction commit. */
const TX_COMMITTED_AT_METADATA_KEY = "__txCommittedAt";
/**
 * Generic error thrown by the transaction manager whenever an unexpected
 * situation occurs (unknown transaction, invalid graph id, ...).
 */
export class GraphTransactionError extends Error {
    /** Stable transaction error code surfaced to MCP clients. */
    code;
    /** Optional operator hint describing how to recover from the error. */
    hint;
    constructor(code, message, hint) {
        super(message);
        this.name = "GraphTransactionError";
        this.code = code;
        if (hint !== undefined) {
            this.hint = hint;
        }
    }
}
/** Error thrown when attempting to commit using a stale base version. */
export class GraphVersionConflictError extends GraphTransactionError {
    code;
    details;
    constructor(graphId, expected, found) {
        super(ERROR_CODES.TX_CONFLICT, "graph version conflict", "reload latest committed graph before retrying");
        this.name = "GraphVersionConflictError";
        this.code = ERROR_CODES.TX_CONFLICT;
        this.details = { graphId, expected, found };
    }
}
/** Error thrown when a caller references a transaction identifier that expired. */
export class UnknownTransactionError extends GraphTransactionError {
    constructor(_txId) {
        super(ERROR_CODES.TX_NOT_FOUND, "transaction not found", "open a new transaction");
        this.name = "UnknownTransactionError";
    }
}
const DEFAULT_SNAPSHOT_POLICY = {
    commitInterval: 10,
    timeIntervalMs: 5 * 60_000,
};
let snapshotPolicyOverride = null;
/** Allows tests to override the snapshot cadence deterministically. */
export function configureGraphSnapshotPolicy(policy) {
    snapshotPolicyOverride = policy;
}
/** Resolve the active snapshot policy honouring overrides and environment hints. */
function resolveSnapshotPolicy() {
    if (snapshotPolicyOverride) {
        return snapshotPolicyOverride;
    }
    return {
        commitInterval: resolveSnapshotOverride(readOptionalInt("MCP_GRAPH_SNAPSHOT_EVERY_COMMITS"), DEFAULT_SNAPSHOT_POLICY.commitInterval),
        timeIntervalMs: resolveSnapshotOverride(readOptionalInt("MCP_GRAPH_SNAPSHOT_INTERVAL_MS"), DEFAULT_SNAPSHOT_POLICY.timeIntervalMs),
    };
}
/** Error thrown when attempting to interact with an expired transaction. */
export class GraphTransactionExpiredError extends GraphTransactionError {
    details;
    constructor(txId, expiredAt, now) {
        super(ERROR_CODES.TX_EXPIRED, "transaction expired", "open a new transaction");
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
    /** Track how often disk snapshots were taken per graph. */
    snapshotTrackers = new Map();
    /**
     * Open a new transaction for the provided graph. The caller receives a fresh
     * working copy which can be mutated freely before invoking {@link commit} or
     * {@link rollback}.
     */
    begin(graph, options = {}) {
        if (!graph.graphId || graph.graphId.trim().length === 0) {
            throw new GraphTransactionError(ERROR_CODES.TX_INVALID_INPUT, "graph id required", "supply a graph_id before opening transactions");
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
        fireAndForgetGraphWal("tx_begin", {
            tx_id: txId,
            graph_id: graph.graphId,
            base_version: graph.graphVersion,
            owner,
            note,
            started_at: startedAt,
        });
        void recordOperation({
            kind: "tx_begin",
            graph_id: graph.graphId,
            base_version: graph.graphVersion,
            owner,
            note,
        }, txId);
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
            throw new GraphTransactionError(ERROR_CODES.TX_INVALID_INPUT, "graph id mismatch", "commit using the graph returned by tx_begin");
        }
        const state = this.states.get(record.graphId);
        if (!state) {
            throw new GraphTransactionError(ERROR_CODES.TX_NOT_FOUND, "graph state unavailable", "seed the graph via resources before opening transactions");
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
        if (mutated) {
            assertValidGraph(updatedGraph);
        }
        const committedAt = mutated ? now : state.committedAt;
        const nextVersion = mutated ? expectedVersion + 1 : state.version;
        const walGraphSnapshot = mutated ? this.cloneGraph(updatedGraph) : this.cloneGraph(state.graph);
        fireAndForgetGraphWal("tx_commit", {
            tx_id: txId,
            graph_id: record.graphId,
            base_version: expectedVersion,
            next_version: nextVersion,
            committed_at: committedAt,
            changed: mutated,
            owner: record.owner,
            note: record.note,
            graph: walGraphSnapshot,
        });
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
        void recordOperation({
            kind: "tx_commit",
            graph_id: record.graphId,
            version: nextVersion,
            changed: mutated,
            committed_at: committedAt,
        }, txId);
        if (mutated) {
            this.maybePersistSnapshot(record.graphId, {
                txId,
                version: nextVersion,
                committedAt,
                graph: finalGraph,
            });
        }
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
        fireAndForgetGraphWal("tx_rollback", {
            tx_id: txId,
            graph_id: record.graphId,
            base_version: record.baseVersion,
            rolled_back_at: now,
            owner: record.owner,
            note: record.note,
        });
        const rolledBackAt = now;
        void recordOperation({
            kind: "tx_rollback",
            graph_id: record.graphId,
            base_version: record.baseVersion,
            rolled_back_at: rolledBackAt,
        }, txId);
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
    /** Persist a committed graph snapshot when the configured policy deems it necessary. */
    maybePersistSnapshot(graphId, payload) {
        const policy = resolveSnapshotPolicy();
        const tracker = this.snapshotTrackers.get(graphId) ?? { lastTakenAt: 0, commitsSinceLast: 0 };
        tracker.commitsSinceLast += 1;
        const now = Date.now();
        const dueByCommit = policy.commitInterval !== null && tracker.commitsSinceLast >= Math.max(1, policy.commitInterval);
        const dueByTime = policy.timeIntervalMs !== null &&
            (tracker.lastTakenAt === 0 || now - tracker.lastTakenAt >= Math.max(1, policy.timeIntervalMs));
        const shouldPersist = tracker.lastTakenAt === 0 || dueByCommit || dueByTime;
        if (!shouldPersist) {
            this.snapshotTrackers.set(graphId, tracker);
            return;
        }
        tracker.commitsSinceLast = 0;
        tracker.lastTakenAt = now;
        this.snapshotTrackers.set(graphId, tracker);
        const clonedGraph = this.cloneGraph(payload.graph);
        snapshotTake(`graph/${graphId}`, {
            graph: clonedGraph,
            version: payload.version,
            committed_at: payload.committedAt,
            tx_id: payload.txId,
        }, {
            metadata: {
                graph_id: graphId,
                version: payload.version,
                committed_at: payload.committedAt,
                tx_id: payload.txId,
            },
        }).catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            process.emitWarning(`failed to persist graph snapshot for ${graphId}: ${reason}`);
        });
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
/**
 * Normalises a snapshot interval override sourced from {@link process.env}.
 *
 * The helper relies on the shared {@link readOptionalInt} parser to coerce the
 * textual value and mirrors the historical behaviour:
 *
 * - when the override is absent or malformed the {@link fallback} is used;
 * - values less than or equal to zero disable the interval by returning `null`;
 * - positive integers are accepted verbatim.
 */
function resolveSnapshotOverride(override, fallback) {
    if (override === undefined) {
        return fallback;
    }
    if (!Number.isFinite(override)) {
        return fallback;
    }
    if (override <= 0) {
        return null;
    }
    return override;
}
/** Internal hooks surfaced to the test suite for deterministic assertions. */
export const __graphTxInternals = {
    resolveSnapshotPolicy,
    resetSnapshotOverrides() {
        snapshotPolicyOverride = null;
    },
};
//# sourceMappingURL=tx.js.map