import { randomUUID } from "node:crypto";

import type { NormalisedGraph } from "./types.js";

/** Metadata key storing the timestamp of the last successful transaction commit. */
const TX_COMMITTED_AT_METADATA_KEY = "__txCommittedAt";

/**
 * Generic error thrown by the transaction manager whenever an unexpected
 * situation occurs (unknown transaction, invalid graph id, ...).
 */
export class GraphTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphTransactionError";
  }
}

/** Error thrown when attempting to commit using a stale base version. */
export class GraphVersionConflictError extends GraphTransactionError {
  public readonly code = "E-REWRITE-CONFLICT";
  public readonly details: { graphId: string; expected: number; found: number };

  constructor(graphId: string, expected: number, found: number) {
    super(
      `graph '${graphId}' diverged: expected version ${expected} but received ${found}`,
    );
    this.name = "GraphVersionConflictError";
    this.details = { graphId, expected, found };
  }
}

/** Error thrown when a caller references a transaction identifier that expired. */
export class UnknownTransactionError extends GraphTransactionError {
  constructor(txId: string) {
    super(`transaction '${txId}' is not active`);
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
  startedAt: number;
}

/** Result returned when opening a new transaction. */
export interface BeginTransactionResult {
  txId: string;
  graphId: string;
  baseVersion: number;
  startedAt: number;
  /** Working copy that callers can mutate before attempting a commit. */
  workingCopy: NormalisedGraph;
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
  begin(graph: NormalisedGraph): BeginTransactionResult {
    if (!graph.graphId || graph.graphId.trim().length === 0) {
      throw new GraphTransactionError("graph id must be provided before opening a transaction");
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
    const record: TransactionRecord = {
      txId,
      graphId: graph.graphId,
      baseVersion: graph.graphVersion,
      snapshot,
      startedAt,
    };
    this.transactions.set(txId, record);

    return {
      txId,
      graphId: graph.graphId,
      baseVersion: graph.graphVersion,
      startedAt,
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
    const record = this.transactions.get(txId);
    if (!record) {
      throw new UnknownTransactionError(txId);
    }

    this.transactions.delete(txId);

    if (updatedGraph.graphId !== record.graphId) {
      throw new GraphTransactionError(
        `graph id mismatch: expected '${record.graphId}' but received '${updatedGraph.graphId}'`,
      );
    }

    const state = this.states.get(record.graphId);
    if (!state) {
      throw new GraphTransactionError(
        `no committed state registered for graph '${record.graphId}'`,
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
    const committedAt = mutated ? Date.now() : state.committedAt;
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
    const record = this.transactions.get(txId);
    if (!record) {
      throw new UnknownTransactionError(txId);
    }

    this.transactions.delete(txId);

    const rolledBackAt = Date.now();
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
