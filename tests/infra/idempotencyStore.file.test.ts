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

    await first.set("graph:tx:abc", 200, JSON.stringify({ ok: true }), 5_000);
    const initial = await first.get("graph:tx:abc");
    expect(initial, "initial lookup").to.deep.equal({ status: 200, body: JSON.stringify({ ok: true }) });

    const restarted = await FileIdempotencyStore.create({ directory, clock: () => clock.now });
    const replay = await restarted.get("graph:tx:abc");
    expect(replay, "replay after restart").to.deep.equal({ status: 200, body: JSON.stringify({ ok: true }) });
  });

  it("expires entries once the TTL elapses", async () => {
    const clock = { now: 1_000 };
    const store = await FileIdempotencyStore.create({ directory: sandboxRoot, clock: () => clock.now });

    await store.set("child:spawn:xyz", 202, JSON.stringify({ child_id: "xyz" }), 500);
    const warm = await store.get("child:spawn:xyz");
    expect(warm, "value before expiry").to.not.equal(null);

    clock.now += 600;
    const expired = await store.get("child:spawn:xyz");
    expect(expired, "value after TTL").to.equal(null);
  });

  it("compacts expired entries when purge() runs", async () => {
    const clock = { now: 5_000 };
    const directory = join(sandboxRoot, "ledger");
    const store = await FileIdempotencyStore.create({ directory, clock: () => clock.now });
    const ledgerPath = join(directory, "index.jsonl");

    await store.set("plan:run", 200, JSON.stringify({ ok: true }), 250);
    clock.now += 1_000;
    await store.purge(clock.now);

    const contents = await readFile(ledgerPath, "utf8");
    expect(contents.trim(), "ledger content after purge").to.equal("");
  });
});
