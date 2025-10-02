import { describe, it } from "mocha";
import { expect } from "chai";

import {
  BehaviorTreeStatusRegistry,
  type BehaviorTreeStatusSnapshot,
} from "../src/monitor/btStatusRegistry.js";

describe("monitor/btStatusRegistry", () => {
  it("tracks node statuses per tree and exposes ordered snapshots", () => {
    const registry = new BehaviorTreeStatusRegistry();
    const base = 1_000;

    registry.reset("tree-a", base);
    registry.record("tree-a", "node-1", "running", base + 50);
    registry.record("tree-a", "node-1", "success", base + 75);
    registry.record("tree-a", "node-2", "failure", base + 80);

    registry.reset("tree-b", base + 10);
    registry.record("tree-b", "node-root", "running", base + 20);

    const snapshots = registry.snapshot();
    expect(snapshots).to.have.lengthOf(2);

    const [mostRecent, oldest] = snapshots;
    expect(mostRecent.treeId).to.equal("tree-a");
    expect(mostRecent.updatedAt).to.equal(base + 80);
    expect(mostRecent.nodes).to.deep.equal([
      { nodeId: "node-2", status: "failure", updatedAt: base + 80 },
      { nodeId: "node-1", status: "success", updatedAt: base + 75 },
    ] satisfies BehaviorTreeStatusSnapshot["nodes"]);

    expect(oldest.treeId).to.equal("tree-b");
    expect(oldest.nodes).to.deep.equal([
      { nodeId: "node-root", status: "running", updatedAt: base + 20 },
    ] satisfies BehaviorTreeStatusSnapshot["nodes"]);

    registry.delete("tree-a");
    const remaining = registry.snapshot();
    expect(remaining).to.have.lengthOf(1);
    expect(remaining[0].treeId).to.equal("tree-b");
  });
});
