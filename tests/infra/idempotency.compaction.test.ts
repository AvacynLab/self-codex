/**
 * Regression tests covering the compaction behaviour of the file-backed
 * idempotency store. The suite ensures the JSONL ledger shrinks after pruning
 * expired entries, the offset index sidecar is regenerated, and lookups remain
 * consistent across restarts.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileIdempotencyStore } from "../../src/infra/idempotencyStore.file.js";
import { buildIdempotencyCacheKey } from "../../src/infra/idempotency.js";

describe("infra/file idempotency store compaction", () => {
  let sandboxRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "idempotency-compaction-"));
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("shrinks the ledger and rewrites the offset index during purge", async () => {
    const clock = { now: 42_000 };
    const directory = join(sandboxRoot, "validation_run", "idempotency");
    const store = await FileIdempotencyStore.create({ directory, clock: () => clock.now });

    const staleKey = buildIdempotencyCacheKey("graph/apply", "stale", { version: 1 });
    await store.set(staleKey, 200, JSON.stringify({ ok: true }), 500);

    const liveKey = buildIdempotencyCacheKey("graph/apply", "live", { version: 2 });
    await store.set(liveKey, 201, JSON.stringify({ ok: true }), 60_000);

    const ledgerPath = join(directory, "index.jsonl");
    const indexPath = join(directory, "index.jsonl.idx");
    const ledgerBefore = (await stat(ledgerPath)).size;
    const indexBefore = (await stat(indexPath)).size;

    clock.now += 10_000;
    await store.purge(clock.now);

    const ledgerAfter = (await stat(ledgerPath)).size;
    const indexAfter = (await stat(indexPath)).size;
    expect(ledgerAfter, "ledger size after purge").to.be.lessThan(ledgerBefore);
    expect(indexAfter, "index size after purge").to.be.lessThan(indexBefore);

    const staleLookup = await store.get(staleKey);
    expect(staleLookup, "expired entry after purge").to.equal(null);

    const liveLookup = await store.get(liveKey);
    expect(liveLookup, "surviving entry after purge").to.deep.equal({
      status: 201,
      body: JSON.stringify({ ok: true }),
    });

    const restarted = await FileIdempotencyStore.create({ directory, clock: () => clock.now });
    const replay = await restarted.get(liveKey);
    expect(replay, "lookup after restart").to.deep.equal({
      status: 201,
      body: JSON.stringify({ ok: true }),
    });
  });
});
