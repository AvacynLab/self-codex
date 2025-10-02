/**
 * Registry tracking Behaviour Tree node statuses across plan executions. The
 * dashboard uses the registry to surface live RUNNING/OK/KO badges while tests
 * rely on the deterministic snapshots returned by {@link snapshot}.
 */
export class BehaviorTreeStatusRegistry {
    trees = new Map();
    treeUpdatedAt = new Map();
    /** Removes previous state for the provided tree before a fresh execution. */
    reset(treeId, timestamp = Date.now()) {
        this.trees.set(treeId, new Map());
        this.treeUpdatedAt.set(treeId, timestamp);
    }
    /**
     * Records the latest status observed for the provided node. Callers should
     * invoke {@link reset} beforehand to avoid mixing runs.
     */
    record(treeId, nodeId, status, timestamp = Date.now()) {
        const nodes = this.trees.get(treeId) ?? new Map();
        const entry = { nodeId, status, updatedAt: timestamp };
        nodes.set(nodeId, entry);
        this.trees.set(treeId, nodes);
        this.treeUpdatedAt.set(treeId, timestamp);
    }
    /** Deletes the state associated with the provided tree. */
    delete(treeId) {
        this.trees.delete(treeId);
        this.treeUpdatedAt.delete(treeId);
    }
    /** Returns the snapshot for a specific Behaviour Tree, if tracked. */
    getSnapshot(treeId) {
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
    snapshot() {
        const snapshots = [];
        for (const treeId of this.trees.keys()) {
            const snapshot = this.getSnapshot(treeId);
            if (snapshot) {
                snapshots.push(snapshot);
            }
        }
        return snapshots.sort((a, b) => b.updatedAt - a.updatedAt || a.treeId.localeCompare(b.treeId));
    }
    sortNodes(nodes) {
        return [...nodes.values()].sort((a, b) => {
            if (b.updatedAt === a.updatedAt) {
                return a.nodeId.localeCompare(b.nodeId);
            }
            return b.updatedAt - a.updatedAt;
        });
    }
}
