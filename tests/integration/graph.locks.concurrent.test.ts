import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { GraphLockManager, GraphLockHeldError } from "../../src/graph/locks.js";
import {
  handleGraphLock,
  handleGraphUnlock,
  GraphLockInputSchema,
  GraphUnlockInputSchema,
  type GraphLockToolContext,
} from "../../src/tools/graphLockTools.js";

/**
 * Deterministic clock helper allowing the tests to advance time manually. Using a closure keeps the
 * implementation simple while mirroring the production interface accepted by GraphLockManager.
 */
function createClock(start = 1_000): { now(): number; advance(delta: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (delta: number) => {
      current += delta;
    },
  };
}

describe("graph lock concurrency integration", () => {
  let clock: ReturnType<typeof createClock>;
  let locks: GraphLockManager;
  let context: GraphLockToolContext;

  beforeEach(() => {
    clock = createClock();
    locks = new GraphLockManager(() => clock.now());
    context = { locks };
  });

  it("allows the same holder to refresh a lock while rejecting conflicting owners", () => {
    const acquired = handleGraphLock(
      context,
      GraphLockInputSchema.parse({ graph_id: "graph-1", holder: "owner-a", ttl_ms: 2_000 }),
    );

    expect(acquired.lock_id).to.be.a("string");
    expect(acquired.expires_at).to.equal(clock.now() + 2_000);

    clock.advance(500);

    const refreshed = handleGraphLock(
      context,
      GraphLockInputSchema.parse({ graph_id: "graph-1", holder: "owner-a", ttl_ms: 3_000 }),
    );

    expect(refreshed.lock_id).to.equal(acquired.lock_id);
    expect(refreshed.refreshed_at).to.equal(clock.now());
    expect(refreshed.expires_at).to.equal(clock.now() + 3_000);

    expect(() =>
      handleGraphLock(
        context,
        GraphLockInputSchema.parse({ graph_id: "graph-1", holder: "owner-b", ttl_ms: 1_000 }),
      ),
    ).to.throw(GraphLockHeldError);
  });

  it("releases locks after expiry and reports the proper status", () => {
    const acquired = handleGraphLock(
      context,
      GraphLockInputSchema.parse({ graph_id: "graph-2", holder: "owner-a", ttl_ms: 1_000 }),
    );

    clock.advance(1_200);

    const afterExpiry = handleGraphUnlock(
      context,
      GraphUnlockInputSchema.parse({ lock_id: acquired.lock_id }),
    );

    expect(afterExpiry.expired).to.equal(true);
    expect(afterExpiry.graph_id).to.equal("graph-2");

    const reacquired = handleGraphLock(
      context,
      GraphLockInputSchema.parse({ graph_id: "graph-2", holder: "owner-b", ttl_ms: 500 }),
    );

    expect(reacquired.holder).to.equal("owner-b");
    expect(reacquired.lock_id).to.not.equal(acquired.lock_id);
  });
});
