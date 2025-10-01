import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import {
  ChildrenIndex,
  DuplicateChildError,
  UnknownChildError,
  type ChildLifecycleState,
} from "../src/state/childrenIndex.js";

/**
 * Helper creating a baseline child payload to keep tests terse.
 */
function baseChild(childId = "child-1") {
  return {
    childId,
    pid: 1234,
    workdir: `/tmp/${childId}`,
    metadata: { role: "tester" },
  };
}

describe("ChildrenIndex", () => {
  let index: ChildrenIndex;

  beforeEach(() => {
    index = new ChildrenIndex();
  });

  it("registers a child and prevents duplicate identifiers", () => {
    const snapshot = index.registerChild(baseChild());

    expect(snapshot.state).to.equal("starting");
    expect(snapshot.metadata).to.deep.equal({ role: "tester" });

    expect(() => index.registerChild(baseChild())).to.throw(DuplicateChildError);
  });

  it("updates lifecycle information including heartbeats and retries", () => {
    index.registerChild(baseChild());

    const running = index.updateState("child-1", "running");
    expect(running.state).to.equal("running");

    const beat = index.updateHeartbeat("child-1", 42);
    expect(beat.lastHeartbeatAt).to.equal(42);

    const retried = index.incrementRetries("child-1");
    expect(retried.retries).to.equal(1);
  });

  it("captures exit metadata and infers terminal states", () => {
    index.registerChild(baseChild());

    const graceful = index.recordExit("child-1", { code: 0, signal: null, at: 100 });
    expect(graceful.state).to.equal("terminated");
    expect(graceful.endedAt).to.equal(100);

    index.registerChild(baseChild("child-2"));
    const forced = index.recordExit("child-2", { code: null, signal: "SIGKILL", forced: true });
    expect(forced.state).to.equal("killed");
    expect(forced.forcedTermination).to.equal(true);

    index.registerChild(baseChild("child-3"));
    const errored = index.recordExit("child-3", { code: 1, signal: null, reason: "crash" });
    expect(errored.state).to.equal("error");
    expect(errored.stopReason).to.equal("crash");
  });

  it("merges metadata and guards against accidental mutation", () => {
    index.registerChild(baseChild());
    const extra = { tokensUsed: 10 };

    const merged = index.mergeMetadata("child-1", extra);
    expect(merged.metadata).to.deep.equal({ role: "tester", tokensUsed: 10 });

    extra.tokensUsed = 9999;
    const latest = index.getChild("child-1");
    expect(latest?.metadata.tokensUsed).to.equal(10);
  });

  it("lists and removes children without exposing internal references", () => {
    index.registerChild(baseChild());
    index.registerChild(baseChild("child-2"));

    const listed = index.list();
    expect(listed).to.have.length(2);

    listed[0].metadata.role = "hacker";
    const fresh = index.getChild("child-1");
    expect(fresh?.metadata.role).to.equal("tester");

    expect(index.removeChild("child-1")).to.equal(true);
    expect(index.getChild("child-1")).to.equal(undefined);
  });

  it("serialises and restores snapshots while validating entries", () => {
    const started = Date.now() - 1000;
    index.registerChild({ ...baseChild(), startedAt: started });
    index.updateState("child-1", "idle");
    index.updateHeartbeat("child-1", started + 100);
    index.incrementRetries("child-1");

    const serialised = index.serialize();
    expect(serialised["child-1"].state).to.equal("idle");

    const restored = new ChildrenIndex();
    restored.restore({
      ...serialised,
      invalid: { state: "ghost" as ChildLifecycleState },
    });

    const snapshot = restored.getChild("child-1");
    expect(snapshot?.state).to.equal("idle");
    expect(snapshot?.startedAt).to.be.at.least(started);
    expect(restored.getChild("invalid")).to.equal(undefined);
  });

  it("throws when targeting unknown identifiers", () => {
    expect(() => index.updateState("missing", "ready")).to.throw(UnknownChildError);
  });
});

