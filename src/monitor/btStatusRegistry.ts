import { BTStatus } from "../executor/bt/types.js";

/** Snapshot describing the status of a Behaviour Tree node. */
export interface BehaviorTreeNodeStatusSnapshot {
  /** Identifier assigned to the node inside the compiled Behaviour Tree. */
  readonly nodeId: string;
  /** Latest status observed for the node. */
  readonly status: BTStatus;
  /** Epoch timestamp (milliseconds) when the status was recorded. */
  readonly updatedAt: number;
}

/** Snapshot aggregating node statuses for a Behaviour Tree instance. */
export interface BehaviorTreeStatusSnapshot {
  /** Identifier of the Behaviour Tree provided by the caller. */
  readonly treeId: string;
  /** Timestamp of the latest update affecting this tree. */
  readonly updatedAt: number;
  /** Per-node statuses captured during execution. */
  readonly nodes: BehaviorTreeNodeStatusSnapshot[];
}

/**
 * Registry tracking Behaviour Tree node statuses across plan executions. The
 * dashboard uses the registry to surface live RUNNING/OK/KO badges while tests
 * rely on the deterministic snapshots returned by {@link snapshot}.
 */
export class BehaviorTreeStatusRegistry {
  private readonly trees = new Map<string, Map<string, BehaviorTreeNodeStatusSnapshot>>();
  private readonly treeUpdatedAt = new Map<string, number>();

  /** Removes previous state for the provided tree before a fresh execution. */
  reset(treeId: string, timestamp: number = Date.now()): void {
    this.trees.set(treeId, new Map());
    this.treeUpdatedAt.set(treeId, timestamp);
  }

  /**
   * Records the latest status observed for the provided node. Callers should
   * invoke {@link reset} beforehand to avoid mixing runs.
   */
  record(treeId: string, nodeId: string, status: BTStatus, timestamp: number = Date.now()): void {
    const nodes = this.trees.get(treeId) ?? new Map<string, BehaviorTreeNodeStatusSnapshot>();
    const entry: BehaviorTreeNodeStatusSnapshot = { nodeId, status, updatedAt: timestamp };
    nodes.set(nodeId, entry);
    this.trees.set(treeId, nodes);
    this.treeUpdatedAt.set(treeId, timestamp);
  }

  /** Deletes the state associated with the provided tree. */
  delete(treeId: string): void {
    this.trees.delete(treeId);
    this.treeUpdatedAt.delete(treeId);
  }

  /** Returns the snapshot for a specific Behaviour Tree, if tracked. */
  getSnapshot(treeId: string): BehaviorTreeStatusSnapshot | null {
    const nodes = this.trees.get(treeId);
    if (!nodes) {
      return null;
    }
    const updatedAt = this.treeUpdatedAt.get(treeId) ?? Date.now();
    return {
      treeId,
      updatedAt,
      nodes: this.sortNodes(nodes),
    };
  }

  /** Returns a snapshot for every tracked Behaviour Tree. */
  snapshot(): BehaviorTreeStatusSnapshot[] {
    const snapshots: BehaviorTreeStatusSnapshot[] = [];
    for (const treeId of this.trees.keys()) {
      const snapshot = this.getSnapshot(treeId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt || a.treeId.localeCompare(b.treeId));
  }

  private sortNodes(nodes: Map<string, BehaviorTreeNodeStatusSnapshot>): BehaviorTreeNodeStatusSnapshot[] {
    return [...nodes.values()].sort((a, b) => {
      if (b.updatedAt === a.updatedAt) {
        return a.nodeId.localeCompare(b.nodeId);
      }
      return b.updatedAt - a.updatedAt;
    });
  }
}
