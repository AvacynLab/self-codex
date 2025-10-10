import { randomUUID } from "crypto";

/** Function returning the current epoch milliseconds, injectable for tests. */
type Clock = () => number;

/**
 * Default TTL upper bound (24h) mirroring transaction guard rails. This keeps
 * runaway locks from lingering forever when a caller forgets to refresh them.
 */
const MAX_TTL_MS = 86_400_000;

/** Internal snapshot describing an acquired graph lock. */
export interface GraphLockSnapshot {
  lockId: string;
  graphId: string;
  holder: string;
  acquiredAt: number;
  refreshedAt: number;
  expiresAt: number | null;
  ttlMs: number | null;
}

/** Base error used by the locking subsystem. */
export class GraphLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphLockError";
  }
}

/** Error thrown when another holder already protects the requested graph. */
export class GraphLockHeldError extends GraphLockError {
  public readonly code = "E-LOCK-HELD";
  public readonly hint = "wait for the active holder to release or retry after expiry";
  public readonly details: { graphId: string; holder: string; lockId: string; expiresAt: number | null };

  constructor(graphId: string, holder: string, lockId: string, expiresAt: number | null) {
    super(`graph '${graphId}' is locked by '${holder}'`);
    this.name = "GraphLockHeldError";
    this.details = { graphId, holder, lockId, expiresAt };
  }
}

/** Error thrown when an operation references an unknown lock identifier. */
export class GraphLockUnknownError extends GraphLockError {
  public readonly code = "E-LOCK-NOTFOUND";
  public readonly hint = "refresh the lock catalogue before retrying";
  public readonly details: { lockId: string };

  constructor(lockId: string) {
    super(`graph lock '${lockId}' is not active`);
    this.name = "GraphLockUnknownError";
    this.details = { lockId };
  }
}

/** Error thrown when a mutation is attempted while a conflicting lock exists. */
export class GraphMutationLockedError extends GraphLockError {
  public readonly code = "E-LOCK-HELD";
  public readonly hint = "acquire the lock with the same holder or wait for expiry";
  public readonly details: { graphId: string; holder: string; lockId: string; expiresAt: number | null };

  constructor(graphId: string, holder: string, lockId: string, expiresAt: number | null) {
    super(`graph '${graphId}' is locked by '${holder}'`);
    this.name = "GraphMutationLockedError";
    this.details = { graphId, holder, lockId, expiresAt };
  }
}

/** Result describing a released lock. */
export interface GraphLockReleaseResult {
  lockId: string;
  graphId: string;
  holder: string;
  releasedAt: number;
  expired: boolean;
  expiresAt: number | null;
}

/** Options accepted when acquiring a graph lock. */
export interface AcquireGraphLockOptions {
  /** Optional time-to-live (milliseconds). When omitted the previous TTL is kept. */
  ttlMs?: number | null;
}

/**
 * Cooperative lock manager protecting graph mutations. The manager exposes
 * optimistic APIs: callers either receive the lock immediately or a
 * deterministic error that can be retried after the TTL expires.
 */
export class GraphLockManager {
  private readonly locksByGraphId = new Map<string, GraphLockSnapshot>();
  private readonly locksById = new Map<string, GraphLockSnapshot>();

  constructor(private readonly clock: Clock = () => Date.now()) {}

  /** Acquire a lock for the provided graph identifier. */
  acquire(graphId: string, holder: string, options: AcquireGraphLockOptions = {}): GraphLockSnapshot {
    const normalisedGraphId = normaliseGraphId(graphId);
    const normalisedHolder = normaliseHolder(holder);
    const now = this.clock();
    this.pruneExpired(normalisedGraphId, now);

    const existing = this.locksByGraphId.get(normalisedGraphId);
    const ttlMs = normaliseTtl(options.ttlMs);
    if (existing) {
      if (existing.holder !== normalisedHolder) {
        throw new GraphLockHeldError(normalisedGraphId, existing.holder, existing.lockId, existing.expiresAt);
      }
      const effectiveTtl = ttlMs ?? existing.ttlMs ?? null;
      return this.refreshSnapshot(existing, now, effectiveTtl);
    }

    const snapshot: GraphLockSnapshot = {
      lockId: randomUUID(),
      graphId: normalisedGraphId,
      holder: normalisedHolder,
      acquiredAt: now,
      refreshedAt: now,
      ttlMs,
      expiresAt: computeExpiry(now, ttlMs),
    };
    this.store(snapshot);
    return { ...snapshot };
  }

  /** Release the lock identified by {@link lockId}. */
  release(lockId: string): GraphLockReleaseResult {
    const record = this.locksById.get(lockId);
    if (!record) {
      throw new GraphLockUnknownError(lockId);
    }
    const now = this.clock();
    this.locksById.delete(lockId);
    const existing = this.locksByGraphId.get(record.graphId);
    if (existing && existing.lockId === lockId) {
      this.locksByGraphId.delete(record.graphId);
    }
    const expired = record.expiresAt !== null && record.expiresAt <= now;
    return {
      lockId: record.lockId,
      graphId: record.graphId,
      holder: record.holder,
      releasedAt: now,
      expired,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Refresh an existing lock by identifier, optionally overriding the TTL. This
   * is useful when callers only persisted the `lockId` and want to extend the
   * lease without re-specifying the original holder/graph pair.
   */
  refresh(lockId: string, options: AcquireGraphLockOptions = {}): GraphLockSnapshot {
    const snapshot = this.locksById.get(lockId);
    if (!snapshot) {
      throw new GraphLockUnknownError(lockId);
    }
    const now = this.clock();
    const overrideTtl = normaliseTtl(options.ttlMs);
    const effectiveTtl = overrideTtl ?? snapshot.ttlMs ?? null;
    return this.refreshSnapshot(snapshot, now, effectiveTtl);
  }

  /**
   * Ensure the caller can mutate the target graph. Throws when a conflicting
   * lock is active.
   */
  assertCanMutate(graphId: string, holder: string | null | undefined): void {
    const normalisedGraphId = normaliseGraphId(graphId);
    const now = this.clock();
    this.pruneExpired(normalisedGraphId, now);
    const active = this.locksByGraphId.get(normalisedGraphId);
    if (!active) {
      return;
    }
    const normalisedHolder = holder === undefined || holder === null ? null : normaliseHolder(holder);
    if (normalisedHolder !== active.holder) {
      throw new GraphMutationLockedError(active.graphId, active.holder, active.lockId, active.expiresAt);
    }
  }

  /** Describe the current lock protecting the graph, if any. */
  describe(graphId: string): GraphLockSnapshot | null {
    const normalisedGraphId = normaliseGraphId(graphId);
    const now = this.clock();
    this.pruneExpired(normalisedGraphId, now);
    const snapshot = this.locksByGraphId.get(normalisedGraphId);
    return snapshot ? { ...snapshot } : null;
  }

  /** Describe the lock associated with the identifier, if it exists. */
  describeById(lockId: string): GraphLockSnapshot | null {
    const snapshot = this.locksById.get(lockId);
    if (!snapshot) {
      return null;
    }
    return { ...snapshot };
  }

  private store(snapshot: GraphLockSnapshot): void {
    this.locksByGraphId.set(snapshot.graphId, snapshot);
    this.locksById.set(snapshot.lockId, snapshot);
  }

  private refreshSnapshot(snapshot: GraphLockSnapshot, now: number, ttlMs: number | null): GraphLockSnapshot {
    const refreshed: GraphLockSnapshot = {
      ...snapshot,
      refreshedAt: now,
      ttlMs,
      expiresAt: computeExpiry(now, ttlMs),
    };
    this.store(refreshed);
    return { ...refreshed };
  }

  private pruneExpired(graphId: string, now: number): void {
    const existing = this.locksByGraphId.get(graphId);
    if (!existing) {
      return;
    }
    if (existing.expiresAt !== null && existing.expiresAt <= now) {
      this.locksByGraphId.delete(graphId);
      this.locksById.delete(existing.lockId);
    }
  }
}

function normaliseGraphId(graphId: string): string {
  if (!graphId || graphId.trim().length === 0) {
    throw new GraphLockError("graph id must not be empty");
  }
  return graphId.trim();
}

function normaliseHolder(holder: string): string {
  const trimmed = holder.trim();
  if (trimmed.length === 0) {
    throw new GraphLockError("holder must not be empty");
  }
  return trimmed;
}

function normaliseTtl(ttlMs: number | null | undefined): number | null {
  if (ttlMs === null || ttlMs === undefined) {
    return null;
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return null;
  }
  return Math.min(Math.floor(ttlMs), MAX_TTL_MS);
}

function computeExpiry(now: number, ttlMs: number | null): number | null {
  if (ttlMs === null) {
    return null;
  }
  return now + ttlMs;
}
