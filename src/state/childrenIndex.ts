import { inspect } from "node:util";

/**
 * Lifecycle states supported by the orchestrator for child processes.
 *
 * We keep the list broad enough to support the workflows described in the
 * project brief (startup, ready to receive prompts, running, idle, graceful
 * stop, forced termination and crash reporting).
 */
export type ChildLifecycleState =
  | "starting"
  | "ready"
  | "running"
  | "idle"
  | "stopping"
  | "terminated"
  | "killed"
  | "error";

/**
 * Public snapshot describing an individual child process.
 */
export interface ChildRecordSnapshot {
  childId: string;
  pid: number;
  workdir: string;
  state: ChildLifecycleState;
  createdAt: number;
  lastHeartbeatAt: number | null;
  retries: number;
  metadata: Record<string, unknown>;
  stoppedAt: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  forcedTermination: boolean;
  stopReason: string | null;
}

/**
 * Options accepted when registering a new child.
 */
export interface RegisterChildOptions {
  childId: string;
  pid: number;
  workdir: string;
  state?: ChildLifecycleState;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Structure used when marking a child as exited.
 */
export interface ChildExitDetails {
  code: number | null;
  signal: NodeJS.Signals | null;
  at?: number;
  forced?: boolean;
  reason?: string;
}

interface MutableChildRecord extends ChildRecordSnapshot {}

/**
 * Raised whenever an operation targets an unknown child identifier.
 */
export class UnknownChildError extends Error {
  public readonly childId: string;

  constructor(childId: string) {
    super(`Unknown child identifier: ${childId}`);
    this.name = "UnknownChildError";
    this.childId = childId;
  }
}

/**
 * Deep clones a mutable record to ensure callers cannot mutate internal state.
 */
function cloneRecord(record: MutableChildRecord): ChildRecordSnapshot {
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
  private readonly children = new Map<string, MutableChildRecord>();

  /**
   * Registers a new child and returns the public snapshot.
   */
  registerChild(options: RegisterChildOptions): ChildRecordSnapshot {
    const createdAt = options.createdAt ?? Date.now();

    const record: MutableChildRecord = {
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
  getChild(childId: string): ChildRecordSnapshot | undefined {
    const record = this.children.get(childId);
    return record ? cloneRecord(record) : undefined;
  }

  /**
   * Returns the mutable record or throws when the child does not exist.
   */
  private requireChild(childId: string): MutableChildRecord {
    const record = this.children.get(childId);
    if (!record) {
      throw new UnknownChildError(childId);
    }
    return record;
  }

  /**
   * Updates the lifecycle state of a child.
   */
  updateState(childId: string, state: ChildLifecycleState): ChildRecordSnapshot {
    const record = this.requireChild(childId);
    record.state = state;
    return cloneRecord(record);
  }

  /**
   * Records the last observed heartbeat for the child.
   */
  updateHeartbeat(childId: string, timestamp?: number): ChildRecordSnapshot {
    const record = this.requireChild(childId);
    record.lastHeartbeatAt = timestamp ?? Date.now();
    return cloneRecord(record);
  }

  /**
   * Increments the retry counter for the child (used by fan-out planners).
   */
  incrementRetries(childId: string): ChildRecordSnapshot {
    const record = this.requireChild(childId);
    record.retries += 1;
    return cloneRecord(record);
  }

  /**
   * Records exit information for a child process.
   */
  recordExit(childId: string, details: ChildExitDetails): ChildRecordSnapshot {
    const record = this.requireChild(childId);
    record.exitCode = details.code;
    record.exitSignal = details.signal;
    record.stoppedAt = details.at ?? Date.now();
    record.lastHeartbeatAt = record.stoppedAt;
    record.forcedTermination = details.forced ?? false;
    record.stopReason = details.reason ?? null;

    if (record.forcedTermination) {
      record.state = "killed";
    } else if (record.exitCode === 0 && record.exitSignal === null) {
      record.state = "terminated";
    } else {
      record.state = "error";
    }

    return cloneRecord(record);
  }

  /**
   * Merges additional metadata for the child.
   */
  mergeMetadata(childId: string, metadata: Record<string, unknown>): ChildRecordSnapshot {
    const record = this.requireChild(childId);
    record.metadata = { ...record.metadata, ...metadata };
    return cloneRecord(record);
  }

  /**
   * Removes a child from the index.
   */
  removeChild(childId: string): boolean {
    return this.children.delete(childId);
  }

  /**
   * Clears the index completely (useful for tests).
   */
  clear(): void {
    this.children.clear();
  }

  /**
   * Returns a snapshot of every tracked child.
   */
  list(): ChildRecordSnapshot[] {
    return Array.from(this.children.values()).map((record) => cloneRecord(record));
  }

  /**
   * Serialises the index into a minimal structure usable by GraphState.
   */
  serialize(): Record<string, unknown> {
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
  restore(snapshot: Record<string, unknown>): void {
    this.children.clear();

    for (const [childId, raw] of Object.entries(snapshot)) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }

      const record: MutableChildRecord = {
        childId,
        pid: -1,
        workdir: "",
        state: "starting",
        createdAt: Date.now(),
        lastHeartbeatAt: typeof (raw as any).lastHeartbeatAt === "number" ? (raw as any).lastHeartbeatAt : null,
        retries: typeof (raw as any).retries === "number" ? (raw as any).retries : 0,
        metadata: {},
        stoppedAt: typeof (raw as any).stoppedAt === "number" ? (raw as any).stoppedAt : null,
        exitCode: typeof (raw as any).exitCode === "number" ? (raw as any).exitCode : null,
        exitSignal: typeof (raw as any).exitSignal === "string" ? ((raw as any).exitSignal as NodeJS.Signals) : null,
        forcedTermination: Boolean((raw as any).forcedTermination),
        stopReason: null,
      };

      this.children.set(childId, record);
    }
  }

  /**
   * Debug helper used mainly inside tests.
   */
  toString(): string {
    const entries = Array.from(this.children.values()).map((record) => cloneRecord(record));
    return inspect(entries, { depth: 4, colors: false });
  }
}
