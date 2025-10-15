/**
 * Unit tests for the `withIdempotency` helper. The scenarios focus on replaying
 * cached payloads, forwarding TTL hints to the persistent store, and bubbling up
 * assertion failures when the same logical request is reused with divergent
 * parameters.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { withIdempotency, type HttpIdempotencySnapshot } from "../../src/infra/idempotency.js";
import type { IdempotencyStore } from "../../src/infra/idempotencyStore.js";

/**
 * Minimal in-memory implementation of {@link IdempotencyStore} used to verify
 * the helper behaviour without touching the real filesystem-backed store.
 */
class StubStore implements IdempotencyStore {
  /** Current simulated time used to evaluate TTL expiration. */
  public now = 0;
  /** Records the most recent call to `set` so tests can assert TTL propagation. */
  public lastPersisted: { key: string; ttlMs: number } | null = null;
  /** Keeps track of cache keys validated via `assertKeySemantics`. */
  public readonly assertedKeys: string[] = [];
  /** Keys that should trigger an artificial conflict during assertions. */
  public readonly conflictingKeys = new Set<string>();

  private readonly entries = new Map<string, { snapshot: HttpIdempotencySnapshot; expiresAt: number }>();

  /** Seeds the store with an entry that remains valid for the provided TTL. */
  public seed(key: string, snapshot: HttpIdempotencySnapshot, ttlMs: number): void {
    this.entries.set(key, { snapshot, expiresAt: this.now + ttlMs });
  }

  async get(key: string): Promise<HttpIdempotencySnapshot | null> {
    const record = this.entries.get(key);
    if (!record) {
      return null;
    }
    if (this.now >= record.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return { ...record.snapshot };
  }

  async set(key: string, status: number, body: string, ttlMs: number): Promise<void> {
    this.lastPersisted = { key, ttlMs };
    this.entries.set(key, { snapshot: { status, body }, expiresAt: this.now + ttlMs });
  }

  async assertKeySemantics(cacheKey: string): Promise<void> {
    this.assertedKeys.push(cacheKey);
    if (this.conflictingKeys.has(cacheKey)) {
      throw new Error(`conflict for ${cacheKey}`);
    }
  }
}

describe("infra/withIdempotency", () => {
  it("executes the operation immediately when no cache key is supplied", async () => {
    const store = new StubStore();
    let executions = 0;

    const result = await withIdempotency(null, 5_000, async () => {
      executions += 1;
      return { status: 201, body: JSON.stringify({ ok: true }) };
    }, store);

    expect(result).to.deep.equal({ status: 201, body: JSON.stringify({ ok: true }) });
    expect(executions, "operation was invoked once").to.equal(1);
    expect(store.lastPersisted, "store should not persist without a cache key").to.equal(null);
    expect(store.assertedKeys, "assertions skipped without key").to.deep.equal([]);
  });

  it("replays the cached snapshot without re-executing the operation", async () => {
    const store = new StubStore();
    store.seed("graph:abc:hash", { status: 200, body: JSON.stringify({ cached: true }) }, 10_000);

    let executed = false;
    const replay = await withIdempotency("graph:abc:hash", 5_000, async () => {
      executed = true;
      return { status: 500, body: JSON.stringify({}) };
    }, store);

    expect(replay).to.deep.equal({ status: 200, body: JSON.stringify({ cached: true }) });
    expect(executed, "operation must not execute on cache hit").to.equal(false);
    expect(store.assertedKeys, "semantic guard invoked").to.deep.equal(["graph:abc:hash"]);
    expect(store.lastPersisted, "fresh writes should be skipped on replay").to.equal(null);
  });

  it("persists fresh responses and forwards ttl hints to the store", async () => {
    const store = new StubStore();

    const fresh = await withIdempotency("child:create:123", 2_500, async () => ({
      status: 202,
      body: JSON.stringify({ child_id: "123" }),
    }), store);

    expect(fresh).to.deep.equal({ status: 202, body: JSON.stringify({ child_id: "123" }) });
    expect(store.lastPersisted, "store receives ttl from helper").to.deep.equal({
      key: "child:create:123",
      ttlMs: 2_500,
    });

    // Advance time to prove the stored entry stays valid until the TTL elapses.
    store.now += 2_000;
    const replay = await withIdempotency("child:create:123", 1_000, async () => {
      throw new Error("should not execute once cached");
    }, store);
    expect(replay).to.deep.equal(fresh);
  });

  it("propagates assertion failures from the underlying store", async () => {
    const store = new StubStore();
    store.conflictingKeys.add("plan:conflict");

    try {
      await withIdempotency("plan:conflict", 1_000, async () => ({
        status: 500,
        body: JSON.stringify({ error: true }),
      }), store);
      throw new Error("expected assertion failure to bubble");
    } catch (error) {
      expect((error as Error).message).to.equal("conflict for plan:conflict");
    }
  });

  it("clamps negative ttl values before persisting snapshots", async () => {
    const store = new StubStore();

    await withIdempotency("plan:negative", -50, async () => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }), store);

    expect(store.lastPersisted).to.deep.equal({ key: "plan:negative", ttlMs: 1 });
  });
});
