/**
 * Behavioural tests for the file-backed idempotency store. The suite focuses on
 * persistence guarantees (surviving process restarts), TTL enforcement and the
 * ability to compact expired entries via `purge()`.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileIdempotencyStore } from "../../src/infra/idempotencyStore.file.js";
import { buildIdempotencyCacheKey } from "../../src/infra/idempotency.js";
import { IdempotencyConflictError } from "../../src/infra/idempotencyStore.js";

describe("infra/file idempotency store", () => {
  let sandboxRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "idempotency-store-"));
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("replays persisted entries across restarts", async () => {
    const clock = { now: Date.now() };
    const directory = join(sandboxRoot, "runs", "idempotency");
    const first = await FileIdempotencyStore.create({ directory, clock: () => clock.now });

    const cacheKey = buildIdempotencyCacheKey("graph/mutate", "abc", { delta: 1 });
    await first.set(cacheKey, 200, JSON.stringify({ ok: true }), 5_000);
    const initial = await first.get(cacheKey);
    expect(initial, "initial lookup").to.deep.equal({ status: 200, body: JSON.stringify({ ok: true }) });

    const restarted = await FileIdempotencyStore.create({ directory, clock: () => clock.now });
    const replay = await restarted.get(cacheKey);
    expect(replay, "replay after restart").to.deep.equal({ status: 200, body: JSON.stringify({ ok: true }) });
  });

  it("expires entries once the TTL elapses", async () => {
    const clock = { now: 1_000 };
    const store = await FileIdempotencyStore.create({ directory: sandboxRoot, clock: () => clock.now });

    const baseKey = buildIdempotencyCacheKey("child/spawn", "xyz", { payload: 1 });
    await store.set(baseKey, 202, JSON.stringify({ child_id: "xyz" }), 500);
    const warm = await store.get(baseKey);
    expect(warm, "value before expiry").to.not.equal(null);

    const divergentKey = buildIdempotencyCacheKey("child/spawn", "xyz", { payload: 2 });
    expect(() => store.assertKeySemantics(divergentKey)).to.throw(IdempotencyConflictError);

    clock.now += 600;
    const expired = await store.get(baseKey);
    expect(expired, "value after TTL").to.equal(null);

    expect(() => store.assertKeySemantics(divergentKey)).to.not.throw();
  });

  it("triggers automatic compaction once the ledger exceeds the threshold", async () => {
    const clock = { now: 5_000 };
    const directory = join(sandboxRoot, "ledger");
    const store = await FileIdempotencyStore.create({
      directory,
      clock: () => clock.now,
      maxEntriesBeforeCompaction: 2,
    });
    const ledgerPath = join(directory, "index.jsonl");

    const firstKey = buildIdempotencyCacheKey("plan/run", "alpha", { step: 1 });
    await store.set(firstKey, 200, JSON.stringify({ ok: true }), 250);
    clock.now += 1_000;
    const secondKey = buildIdempotencyCacheKey("plan/run", "beta", { step: 2 });
    await store.set(secondKey, 200, JSON.stringify({ ok: true }), 500);
    await store.checkHealth?.();

    const contents = await readFile(ledgerPath, "utf8");
    const lines = contents.trim().split(/\r?\n/).filter((line) => line.length > 0);
    expect(lines.length, "ledger lines after compaction").to.equal(1);
    const record = JSON.parse(lines[0] ?? "{}") as { key?: string };
    expect(record.key, "remaining ledger key").to.equal(secondKey);
  });

  it("rejects divergent payloads when the same idempotency key is reused", async () => {
    const store = await FileIdempotencyStore.create({ directory: sandboxRoot });
    const originalKey = buildIdempotencyCacheKey("tx/commit", "conflict", { op: 1 });
    await store.set(originalKey, 200, JSON.stringify({ ok: true }), 1_000);

    const conflictingKey = buildIdempotencyCacheKey("tx/commit", "conflict", { op: 2 });
    try {
      await store.set(conflictingKey, 200, JSON.stringify({ ok: true }), 1_000);
      throw new Error("expected idempotency conflict");
    } catch (error) {
      expect(error).to.be.instanceOf(IdempotencyConflictError);
    }
  });
});
