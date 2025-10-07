import { randomUUID } from "node:crypto";

import { ERROR_CODES } from "../types.js";
import type { NormalisedGraph } from "./types.js";

/** Narrow union describing transaction specific error codes. */
type TransactionErrorCode =
  | typeof ERROR_CODES.TX_NOT_FOUND
  | typeof ERROR_CODES.TX_CONFLICT
  | typeof ERROR_CODES.TX_INVALID_OP
  | typeof ERROR_CODES.TX_UNEXPECTED
  | typeof ERROR_CODES.TX_INVALID_INPUT
  | typeof ERROR_CODES.TX_EXPIRED;

/** Metadata key storing the timestamp of the last successful transaction commit. */
const TX_COMMITTED_AT_METADATA_KEY = "__txCommittedAt";

/**
 * Generic error thrown by the transaction manager whenever an unexpected
 * situation occurs (unknown transaction, invalid graph id, ...).
 */
export class GraphTransactionError extends Error {
  /** Stable transaction error code surfaced to MCP clients. */
  public readonly code: TransactionErrorCode;

  /** Optional operator hint describing how to recover from the error. */
  public readonly hint?: string;

  constructor(code: TransactionErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "GraphTransactionError";
    this.code = code;
    this.hint = hint;
  }
}

/** Error thrown when attempting to commit using a stale base version. */
export class GraphVersionConflictError extends GraphTransactionError {
  public readonly code: typeof ERROR_CODES.TX_CONFLICT;
  public readonly details: { graphId: string; expected: number; found: number };

  constructor(graphId: string, expected: number, found: number) {
    super(
      ERROR_CODES.TX_CONFLICT,
      "graph version conflict",
      "reload latest committed graph before retrying",
    );
    this.name = "GraphVersionConflictError";
    this.code = ERROR_CODES.TX_CONFLICT;
    this.details = { graphId, expected, found };
  }
}

/** Error thrown when a caller references a transaction identifier that expired. */
export class UnknownTransactionError extends GraphTransactionError {
  constructor(txId: string) {
    super(ERROR_CODES.TX_NOT_FOUND, "transaction not found", "open a new transaction");
    this.name = "UnknownTransactionError";
  }
}

/** Snapshot of the latest committed state for a graph identifier. */
interface GraphVersionState {
  version: number;
  committedAt: number;
  graph: NormalisedGraph;
}

/** Internal representation of a live transaction. */
interface TransactionRecord {
  txId: string;
  graphId: string;
  baseVersion: number;
  snapshot: NormalisedGraph;
  /** Working copy mutated in-memory by tx_apply before commit. */
  workingCopy: NormalisedGraph;
  startedAt: number;
  /** Owner advertised by the caller to ease auditing. */
  owner: string | null;
  /** Optional free-form note associated with the transaction. */
  note: string | null;
  /** Timestamp at which the transaction should be considered expired. */
  expiresAt: number | null;
  /** Tracks the last time the transaction was accessed. */
  lastTouchedAt: number;
}

/** Result returned when opening a new transaction. */
export interface BeginTransactionResult {
  txId: string;
  graphId: string;
  baseVersion: number;
  startedAt: number;
  owner: string | null;
  note: string | null;
  expiresAt: number | null;
  /** Working copy that callers can mutate before attempting a commit. */
  workingCopy: NormalisedGraph;
}

/** Options accepted when opening a new transaction. */
export interface BeginTransactionOptions {
  /** Identifier describing the component initiating the transaction. */
  owner?: string | null;
  /** Human readable note attached to the transaction. */
  note?: string | null;
  /**
   * Optional TTL expressed in milliseconds. When provided, the transaction will
   * expire after the interval elapses, preventing further mutations.
   */
  ttlMs?: number | null;
}

/** Result returned after successfully committing a transaction. */
export interface CommitTransactionResult {
  txId: string;
  graphId: string;
  version: number;
  committedAt: number;
  graph: NormalisedGraph;
}

/** Result returned when a transaction gets rolled back. */
export interface RollbackTransactionResult {
  txId: string;
  graphId: string;
  version: number;
  rolledBackAt: number;
  snapshot: NormalisedGraph;
}

/** Describes the latest committed state tracked for a graph identifier. */
export interface GraphCommittedState {
  graphId: string;
  version: number;
  committedAt: number;
  graph: NormalisedGraph;
}

/** Public shape describing a live transaction for diagnostics. */
export interface TransactionMetadata {
  txId: string;
  graphId: string;
  baseVersion: number;
  startedAt: number;
  owner: string | null;
  note: string | null;
  expiresAt: number | null;
  lastTouchedAt: number;
}

/** Error thrown when attempting to interact with an expired transaction. */
export class GraphTransactionExpiredError extends GraphTransactionError {
  public readonly details: { txId: string; expiredAt: number; now: number };

  constructor(txId: string, expiredAt: number, now: number) {
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
  private readonly states = new Map<string, GraphVersionState>();

  /** Active transaction records keyed by their identifier. */
  private readonly transactions = new Map<string, TransactionRecord>();

  /**
   * Open a new transaction for the provided graph. The caller receives a fresh
   * working copy which can be mutated freely before invoking {@link commit} or
   * {@link rollback}.
   */
  begin(graph: NormalisedGraph, options: BeginTransactionOptions = {}): BeginTransactionResult {
    if (!graph.graphId || graph.graphId.trim().length === 0) {
      throw new GraphTransactionError(
        ERROR_CODES.TX_INVALID_INPUT,
        "graph id required",
        "supply a graph_id before opening transactions",
      );
    }

    const state = this.states.get(graph.graphId);
    if (state) {
      if (state.version !== graph.graphVersion) {
        throw new GraphVersionConflictError(graph.graphId, state.version, graph.graphVersion);
      }
      state.graph = this.cloneGraph(graph);
    } else {
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
    const record: TransactionRecord = {
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
  commit(txId: string, updatedGraph: NormalisedGraph): CommitTransactionResult {
    const now = Date.now();
    const record = this.getActiveTransaction(txId, now);

    if (updatedGraph.graphId !== record.graphId) {
      throw new GraphTransactionError(
        ERROR_CODES.TX_INVALID_INPUT,
        "graph id mismatch",
        "commit using the graph returned by tx_begin",
      );
    }

    const state = this.states.get(record.graphId);
    if (!state) {
      throw new GraphTransactionError(
        ERROR_CODES.TX_NOT_FOUND,
        "graph state unavailable",
        "seed the graph via resources before opening transactions",
      );
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

    let finalGraph: NormalisedGraph;
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
    } else {
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
  rollback(txId: string): RollbackTransactionResult {
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
  countActiveTransactions(): number {
    return this.transactions.size;
  }

  /** Returns a clone of the in-memory working copy for the transaction. */
  getWorkingCopy(txId: string): NormalisedGraph {
    const now = Date.now();
    const record = this.getActiveTransaction(txId, now, true);
    return this.cloneGraph(record.workingCopy);
  }

  /** Replaces the working copy for a transaction after applying mutations. */
  setWorkingCopy(txId: string, graph: NormalisedGraph): void {
    const now = Date.now();
    const record = this.getActiveTransaction(txId, now, true);
    record.workingCopy = this.cloneGraph(graph);
    this.transactions.set(txId, record);
  }

  /** Returns metadata about an active transaction. */
  describe(txId: string): TransactionMetadata {
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
  getCommittedState(graphId: string): GraphCommittedState | null {
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

  private getActiveTransaction(txId: string, now = Date.now(), touch = false): TransactionRecord {
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
  private cloneGraph(graph: NormalisedGraph): NormalisedGraph {
    return structuredClone(graph) as NormalisedGraph;
  }

  /**
   * Compare two graphs for structural equality. The normalised representation
   * preserves node/edge ordering which makes a simple JSON serialisation safe
   * for equality checks without introducing a heavy diff dependency.
   */
  private graphsEqual(first: NormalisedGraph, second: NormalisedGraph): boolean {
    return JSON.stringify(first) === JSON.stringify(second);
  }
}

function normaliseOwner(owner: string | null | undefined): string | null {
  if (!owner) {
    return null;
  }
  const trimmed = owner.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normaliseNote(note: string | null | undefined): string | null {
  if (!note) {
    return null;
  }
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normaliseExpiry(startedAt: number, ttlMs: number | null | undefined): number | null {
  if (ttlMs === null || ttlMs === undefined) {
    return null;
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return null;
  }
  return startedAt + Math.floor(ttlMs);
}
