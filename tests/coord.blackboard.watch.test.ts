import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardEvent, BlackboardStore } from "../src/coord/blackboard.js";

/** Manual clock mirroring the deterministic clock used in coordinator tests. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * Ensures that watchers receive backlog events and live updates in order while
 * respecting unsubscribe semantics and pagination.
 */
describe("coordination blackboard watch", () => {
  it("streams backlog and live events with deterministic ordering", () => {
    const clock = new ManualClock();
    const store = new BlackboardStore({ now: () => clock.now(), historyLimit: 10 });

    store.set("alpha", { status: "draft" });
    clock.advance(10);
    store.set("beta", { status: "todo" }, { tags: ["ops"] });

    const received: BlackboardEvent[] = [];
    const unsubscribe = store.watch({
      fromVersion: 1,
      listener: (event) => {
        received.push(event);
      },
    });

    expect(received.map((event) => event.key)).to.deep.equal(["beta"]);

    clock.advance(5);
    store.set("gamma", { status: "running" });
    clock.advance(5);
    expect(store.delete("beta")).to.equal(true);
    clock.advance(5);
    store.set("delta", { status: "cooldown" }, { ttlMs: 20 });

    clock.advance(20);
    const expired = store.evictExpired();
    expect(expired).to.have.length(1);
    expect(expired[0].key).to.equal("delta");

    expect(received.map((event) => event.kind)).to.deep.equal([
      "set",
      "set",
      "delete",
      "set",
      "expire",
    ]);
    expect(received.map((event) => event.key)).to.deep.equal([
      "beta",
      "gamma",
      "beta",
      "delta",
      "delta",
    ]);

    unsubscribe();

    store.set("epsilon", { status: "archived" });
    expect(received.some((event) => event.key === "epsilon")).to.equal(false);

    const paged = store.getEventsSince(1, { limit: 3 });
    expect(paged.map((event) => event.version)).to.deep.equal([2, 3, 4]);
  });
});
