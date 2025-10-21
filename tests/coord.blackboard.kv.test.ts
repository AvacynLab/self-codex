import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";

/** Deterministic manual clock used to drive TTL computations in tests. */
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
 * Validates that the blackboard honours tag normalisation, TTL expiration and
 * history tracking for repeated updates.
 */
describe("coordination blackboard key/value", () => {
  it("persists, updates and expires entries deterministically", () => {
    const clock = new ManualClock();
    const store = new BlackboardStore({ now: () => clock.now(), historyLimit: 10 });

    const created = store.set(
      "alpha",
      { payload: 1 },
      { tags: ["Goal", "Alpha"], ttlMs: 1_000 },
    );

    expect(created.key).to.equal("alpha");
    expect(created.tags).to.deep.equal(["alpha", "goal"]);
    expect(created.createdAt).to.equal(0);
    expect(created.updatedAt).to.equal(0);
    expect(created.expiresAt).to.equal(1_000);

    const fetched = store.get("alpha");
    expect(fetched?.value).to.deep.equal({ payload: 1 });
    expect(fetched?.version).to.equal(created.version);

    clock.advance(250);
    const updated = store.set("alpha", { payload: 2 }, { tags: ["Goal"], ttlMs: 500 });
    expect(updated.version).to.be.greaterThan(created.version);
    expect(updated.createdAt).to.equal(created.createdAt);
    expect(updated.updatedAt).to.equal(clock.now());
    expect(updated.expiresAt).to.equal(clock.now() + 500);

    const tagged = store.query({ tags: ["goal"] });
    expect(tagged).to.have.length(1);
    expect(tagged[0].value).to.deep.equal({ payload: 2 });

    clock.advance(500);
    const expired = store.evictExpired();
    expect(expired).to.have.length(1);
    expect(expired[0].kind).to.equal("expire");
    expect(expired[0].key).to.equal("alpha");

    expect(store.get("alpha")).to.equal(undefined);

    const history = store.getEventsSince(0);
    expect(history.map((event) => event.kind)).to.deep.equal(["set", "set", "expire"]);
    expect(history[1].previous?.value).to.deep.equal({ payload: 1 });
  });

  it("accepts explicit undefined values on optional blackboard inputs", () => {
    const store = new BlackboardStore();

    // Passing `undefined` explicitly must mirror the behaviour of omitted fields
    // so enabling `exactOptionalPropertyTypes` remains a no-op for callers.
    const created = store.set(
      "beta",
      { payload: 3 },
      { tags: undefined, ttlMs: undefined },
    );

    expect(created.tags).to.deep.equal([]);
    expect(created.expiresAt).to.equal(null);

    const [batch] = store.batchSet([
      {
        key: "gamma",
        value: { payload: 4 },
        // Ensures the batch path also tolerates explicit undefined optionals.
        tags: undefined,
        ttlMs: undefined,
      },
    ]);

    expect(batch.tags).to.deep.equal([]);
    expect(batch.expiresAt).to.equal(null);

    const results = store.query({ keys: undefined, tags: undefined });
    expect(results.map((entry) => entry.key).sort()).to.deep.equal(["beta", "gamma"]);
  });
});
